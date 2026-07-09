/**
 * Shadow-archive unit tests. The load-bearing correctness is the merge: a
 * resume-truncated transcript must be recovered to the full union, in
 * chronological order, without duplicating records — for every session that
 * has ever been seen.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  mergeLineText,
  mergeContainer,
  updateShadow,
  readShadowContainer,
  seedShadow,
} from './shadow.js';
import { buildRawContainer, parseTranscriptFromContainer, type RawContainer } from './raw.js';
import type { RawSessionExport } from '../core/tool-backend.js';
import '../core/backends/index.js'; // register backends so the agy generic fallback resolves

// Build a claude JSONL transcript from message uuids + optional trailing meta.
function jsonl(uuids: string[], meta: Record<string, unknown>[] = []): string {
  const lines = uuids.map((u, i) =>
    JSON.stringify({ type: i % 2 ? 'assistant' : 'user', uuid: u, parentUuid: i ? uuids[i - 1] : null, message: { role: i % 2 ? 'assistant' : 'user', content: `msg-${u}` } }),
  );
  for (const m of meta) lines.push(JSON.stringify(m));
  return lines.join('\n') + '\n';
}

function container(tool: RawContainer['tool'], name: string, text: string, mtime = 1000): RawContainer {
  return { v: 1, tool, mtime, files: [{ name, text }] };
}

function exportOf(tool: RawSessionExport['tool'], name: string, text: string, mtime = 1000): RawSessionExport {
  return { tool, mtime, files: [{ name, bytes: Buffer.from(text, 'utf-8') }] };
}

describe('mergeLineText', () => {
  test('normal append: current is a superset → equals current, nothing recovered', () => {
    const shadow = jsonl(['a', 'b', 'c']);
    const current = jsonl(['a', 'b', 'c', 'd', 'e']);
    const r = mergeLineText(shadow, current);
    expect(r.recovered).toBe(0);
    expect(r.totalRecords).toBe(5);
    expect(r.text).toBe(current);
  });

  test('identical → unchanged, nothing recovered', () => {
    const t = jsonl(['a', 'b']);
    const r = mergeLineText(t, t);
    expect(r.recovered).toBe(0);
    expect(r.totalRecords).toBe(2);
  });

  test('resume truncation: shadow head recovered, order is old→new, no dupes', () => {
    // The incident: disk keeps only the resumed tail (fresh uuids), the old
    // history is gone from the file but lives in the shadow.
    const shadow = jsonl(['a', 'b', 'c', 'd', 'e']);
    const current = jsonl(['x', 'y']); // resumed continuation only
    const r = mergeLineText(shadow, current);
    expect(r.recovered).toBe(5);          // all 5 old records were missing from disk
    expect(r.totalRecords).toBe(7);       // 5 recovered + 2 new
    const order = r.text.trim().split('\n').map((l) => JSON.parse(l).uuid);
    expect(order).toEqual(['a', 'b', 'c', 'd', 'e', 'x', 'y']);
  });

  test('singleton meta: current wins, no stale accumulation', () => {
    const shadow = jsonl(['a'], [{ type: 'ai-title', aiTitle: 'OLD' }]);
    const current = jsonl(['a'], [{ type: 'ai-title', aiTitle: 'NEW' }]);
    const r = mergeLineText(shadow, current);
    const titles = r.text.trim().split('\n').map((l) => JSON.parse(l)).filter((o) => o.type === 'ai-title');
    expect(titles).toHaveLength(1);
    expect(titles[0].aiTitle).toBe('NEW');
  });

  test('overlapping tail: partial-resume where some old records survive on disk', () => {
    const shadow = jsonl(['a', 'b', 'c', 'd']);
    const current = jsonl(['c', 'd', 'e']); // disk kept c,d and added e
    const r = mergeLineText(shadow, current);
    expect(r.recovered).toBe(2);           // a,b only in shadow
    const order = r.text.trim().split('\n').map((l) => JSON.parse(l).uuid);
    expect(order).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('mergeContainer', () => {
  test('claude rewrite across the main file → rewrite-merged', () => {
    const shadow = container('claude', 's.jsonl', jsonl(['a', 'b', 'c']));
    const current = container('claude', 's.jsonl', jsonl(['x']));
    const m = mergeContainer(shadow, current);
    expect(m.status).toBe('rewrite-merged');
    expect(m.recovered).toBe(3);
  });

  test('subagent file the rewrite dropped is recovered', () => {
    const shadow: RawContainer = { v: 1, tool: 'claude', mtime: 1, files: [
      { name: 's.jsonl', text: jsonl(['a', 'b']) },
      { name: 'subagents/agent-1.jsonl', text: jsonl(['p', 'q']) },
    ] };
    const current: RawContainer = { v: 1, tool: 'claude', mtime: 2, files: [
      { name: 's.jsonl', text: jsonl(['a', 'b', 'c']) }, // main grew
      // subagent file gone from disk
    ] };
    const m = mergeContainer(shadow, current);
    expect(m.status).toBe('rewrite-merged'); // the dropped subagent counts as recovery
    const names = m.container.files.map((f) => f.name).sort();
    expect(names).toEqual(['s.jsonl', 'subagents/agent-1.jsonl']);
  });

  test('gemini whole-file: shrink keeps the larger blob', () => {
    const shadow = container('gemini', 'chat.json', JSON.stringify({ messages: [1, 2, 3, 4, 5] }));
    const current = container('gemini', 'chat.json', JSON.stringify({ messages: [1] }));
    const m = mergeContainer(shadow, current);
    expect(m.status).toBe('rewrite-merged');
    expect(m.container.files[0].text).toBe(shadow.files[0].text);
  });

  test('gemini whole-file: growth takes current', () => {
    const shadow = container('gemini', 'chat.json', JSON.stringify({ messages: [1] }));
    const current = container('gemini', 'chat.json', JSON.stringify({ messages: [1, 2, 3] }));
    const m = mergeContainer(shadow, current);
    expect(m.status).toBe('grew');
    expect(m.container.files[0].text).toBe(current.files[0].text);
  });
});

// Regression: parseTranscriptFromContainer must NOT return empty for tools
// without a hardcoded branch (agy). Before the readEventsFromText fallback,
// an agy session reconstructed from a shadow/raw-archive container parsed to
// zero messages — so recovery/repair silently produced empty conversations.
describe('parseTranscriptFromContainer generic fallback (agy)', () => {
  test('agy container parses to real messages via readEventsFromText', () => {
    const agyLines = [
      JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-07-09T00:00:00Z', content: '<USER_REQUEST>fix the build</USER_REQUEST>' }),
      JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-07-09T00:00:01Z', content: 'On it — reading the config.' }),
    ].join('\n') + '\n';
    const c: RawContainer = { v: 1, tool: 'agy', mtime: 1, files: [{ name: 'transcript_full.jsonl', text: agyLines }] };
    const msgs = parseTranscriptFromContainer(c).messages;
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(msgs.some((m) => m.content?.includes('fix the build'))).toBe(true);
  });
});

describe('updateShadow (disk round-trip)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cr-shadow-')); process.env.CHAT_RECALL_DATA_DIR = dir; });
  afterEach(() => { delete process.env.CHAT_RECALL_DATA_DIR; rmSync(dir, { recursive: true, force: true }); });

  test('first sight creates, resume recovers on the next tick', () => {
    const id = 'sess-1';
    // Tick 1: full transcript seen and shadowed.
    const first = updateShadow(id, exportOf('claude', `${id}.jsonl`, jsonl(['a', 'b', 'c', 'd'])));
    expect(first.status).toBe('created');
    expect(readShadowContainer('claude', id)).not.toBeNull();

    // Tick 2: the file was resume-truncated to just the continuation.
    const second = updateShadow(id, exportOf('claude', `${id}.jsonl`, jsonl(['z']), 2000));
    expect(second.status).toBe('rewrite-merged');
    expect(second.recovered).toBe(4);
    const order = second.container!.files[0].text.trim().split('\n').map((l) => JSON.parse(l).uuid);
    expect(order).toEqual(['a', 'b', 'c', 'd', 'z']);

    // Tick 3: shadow is now the fullest; a re-read of the still-truncated file
    // must not lose the recovered history.
    const third = updateShadow(id, exportOf('claude', `${id}.jsonl`, jsonl(['z']), 2000));
    expect(third.recovered).toBe(4);
    const order3 = third.container!.files[0].text.trim().split('\n').map((l) => JSON.parse(l).uuid);
    expect(order3).toEqual(['a', 'b', 'c', 'd', 'z']);
  });

  test('unavailable export still surfaces the prior shadow', () => {
    const id = 'sess-2';
    updateShadow(id, exportOf('claude', `${id}.jsonl`, jsonl(['a', 'b'])));
    const u = updateShadow(id, null);
    expect(u.status).toBe('unavailable');
    expect(u.container).not.toBeNull();
    expect(u.container!.files[0].text.trim().split('\n')).toHaveLength(2);
  });

  test('seedShadow merges an external (server-recovered) container', () => {
    const id = 'sess-3';
    // Local shadow has the tail; server archive has the head. Union = whole.
    updateShadow(id, exportOf('claude', `${id}.jsonl`, jsonl(['c', 'd'])));
    const fromServer = buildRawContainer(exportOf('claude', `${id}.jsonl`, jsonl(['a', 'b', 'c', 'd'])));
    const fullest = seedShadow(id, fromServer);
    const order = fullest.files[0].text.trim().split('\n').map((l) => JSON.parse(l).uuid);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });
});
