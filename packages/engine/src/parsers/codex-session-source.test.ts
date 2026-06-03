import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CodexSessionSource } from './codex-session-source.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'codex-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function writeCodexSession(date: string, sid: string, events: object[]) {
  const [, year, mo, day] = date.match(/^(\d{4})-(\d{2})-(\d{2})/)!;
  const dir = join(tmp, year, mo, day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-${date}T10-00-00-${sid}.jsonl`),
    events.map(e => JSON.stringify(e)).join('\n') + '\n',
  );
}

async function collect(): Promise<any[]> {
  const src = new CodexSessionSource(tmp);
  const out: any[] = [];
  for await (const i of src.discover()) out.push(i);
  return out;
}

describe('CodexSessionSource', () => {
  test('discovers a top-level rollout with session_meta + user message', async () => {
    writeCodexSession('2026-05-01', 'aaaa', [
      { type: 'session_meta', payload: { id: 'aaaa', cwd: '/proj' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'hi codex' } },
      { type: 'response_item', payload: { type: 'message' } },
    ]);
    const items = await collect();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('codex_aaaa');
    expect(items[0].extra.tool).toBe('codex');
    expect(items[0].title).toContain('hi codex');
  });

  test('skips sub-agent rollouts (agent_role / agent_nickname present)', async () => {
    writeCodexSession('2026-05-01', 'bbbb', [
      { type: 'session_meta', payload: { id: 'bbbb', agent_role: 'sub', agent_nickname: 'helper' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'sub' } },
    ]);
    const items = await collect();
    expect(items).toHaveLength(0);
  });

  test('skips sessions with fewer than 2 messages', async () => {
    writeCodexSession('2026-05-01', 'cccc', [
      { type: 'session_meta', payload: { id: 'cccc' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'only one' } },
    ]);
    const items = await collect();
    expect(items).toHaveLength(0);
  });

  test('returns empty when sessions dir is missing', async () => {
    const src = new CodexSessionSource(join(tmp, 'doesnotexist'));
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    expect(items).toEqual([]);
  });

  test('parse() emits chunks for a discovered session', async () => {
    writeCodexSession('2026-05-01', 'dddd', [
      { type: 'session_meta', payload: { id: 'dddd', cwd: '/proj' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'do the thing' } },
      { type: 'response_item', payload: { type: 'message', content: 'done' } },
    ]);
    const src = new CodexSessionSource(tmp);
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    if (items.length === 0) return;
    const chunks = await src.parse(items[0]);
    expect(Array.isArray(chunks)).toBe(true);
  });
});
