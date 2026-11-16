/**
 * The Claude parser cuts each payload body as it reads the line, and keeps one
 * record at a time. Its messages must be the ones the two-pass parse gives (all
 * records first, then the calls with their results) followed by
 * trimTranscriptForSync, because the server stores what the collector sends.
 */
import { describe, test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseClaudeTranscriptText, parseClaudeTranscript, parseClaudeSubagents } from './claude.js';
import { capPayload, SYNC_PAYLOAD_CAP } from './trim.js';
import { trimTranscriptForSync } from './index.js';
import type { TranscriptMessage } from './types.js';

const big = (n: number, ch = 'x') => ch.repeat(n);

function records(): unknown[] {
  return [
    { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'start the work' } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { content: [
      { type: 'thinking', thinking: big(5000, 't') },
      { type: 'text', text: 'reading two files' },
      { type: 'tool_use', id: 'a1', name: 'Read', input: { file_path: '/home/user/code/example/a.ts' } },
      { type: 'tool_use', id: 'a2', name: 'Bash', input: { command: big(9000, 'c') } },
    ] } },
    { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'a1', content: big(50_000, 'r') },
      { type: 'tool_result', tool_use_id: 'a2', content: [{ type: 'text', text: big(30_000, 's') }], is_error: true },
    ] } },
    // The same id twice: the last result wins for every call with that id.
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'dup', name: 'Grep', input: { q: 1 } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'dup', content: 'first' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'dup', content: 'second', is_error: true }, { type: 'text', text: 'and a prompt' }] } },
    // A result that arrives before its call.
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'early', content: { ok: true, items: [1, 2, 3] } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'early', name: 'Edit', input: { old_string: big(10_000, 'o'), new_string: 'n' } }] } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: null }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } },
    { type: 'user', message: { content: '<local-command-caveat>x</local-command-caveat>' } },
    { type: 'summary', summary: 'a summary' },
    { type: 'system', subtype: 'away_summary', content: [{ type: 'text', text: 'away' }] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'NoId', input: 'plain' }] } },
  ];
}

function toText(recs: unknown[], extra: string[] = []): string {
  const lines = recs.map((r) => JSON.stringify(r));
  return [...lines.slice(0, 3), '', 'not json', ...extra, ...lines.slice(3)].join('\n');
}

/** The parse as it was written before: read every record, collect every result by id, then build. */
function twoPass(text: string): TranscriptMessage[] {
  const raw: Array<{ line: number; obj: any }> = [];
  let n = 0;
  for (const line of text.split('\n')) {
    n++;
    if (!line.trim()) continue;
    try { raw.push({ line: n, obj: JSON.parse(line) }); } catch { /* skip */ }
  }
  const results = new Map<string, { content: any; isError?: boolean }>();
  for (const { obj } of raw) {
    if (obj?.type !== 'user' || !Array.isArray(obj.message?.content)) continue;
    for (const b of obj.message.content) {
      if (b?.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, { content: b.content, isError: b.is_error === true });
    }
  }
  const out: TranscriptMessage[] = [];
  for (const { line, obj } of raw) {
    if (obj.type === 'assistant') {
      const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
      const thinkingBlock = blocks.find((c: any) => c?.type === 'thinking');
      const textBlock = blocks.find((c: any) => c?.type === 'text');
      const calls = blocks.filter((c: any) => c?.type === 'tool_use').map((u: any) => {
        const r = u.id ? results.get(u.id) : undefined;
        return { name: u.name || 'unknown', input: u.input, result: r?.content, isError: r?.isError };
      });
      const has = thinkingBlock !== undefined;
      const text = textBlock?.text ?? '';
      const thinking = thinkingBlock?.thinking ?? (has ? '' : undefined);
      if (!text && !has && calls.length === 0) continue;
      out.push({ line, role: 'assistant', content: text, thinking, toolCalls: calls.length > 0 ? calls : undefined, timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined });
    }
  }
  return out;
}

const assistantsOf = (m: TranscriptMessage[]) => m.filter((x) => x.role === 'assistant');
const wire = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('the Claude parser with a payload cap', () => {
  const text = toText(records());

  test('gives the assistant messages of the two-pass parse after trimTranscriptForSync', () => {
    const expected = trimTranscriptForSync({ messages: twoPass(text), subagents: [] }).messages;
    const got = parseClaudeTranscriptText(text, { payloadCap: SYNC_PAYLOAD_CAP });
    expect(wire(assistantsOf(got))).toEqual(wire(assistantsOf(expected)));
  });

  test('gives the user and summary messages of the parse with no cap', () => {
    const whole = parseClaudeTranscriptText(text);
    const cut = parseClaudeTranscriptText(text, { payloadCap: SYNC_PAYLOAD_CAP });
    expect(wire(cut.filter((m) => m.role !== 'assistant'))).toEqual(wire(whole.filter((m) => m.role !== 'assistant')));
    expect(cut.map((m) => m.line)).toEqual(whole.map((m) => m.line));
  });

  test('with no cap gives the assistant messages of the two-pass parse', () => {
    expect(wire(assistantsOf(parseClaudeTranscriptText(text)))).toEqual(wire(assistantsOf(twoPass(text))));
  });

  test('cuts a payload once: the suffix is not cut again', () => {
    const got = parseClaudeTranscriptText(text, { payloadCap: SYNC_PAYLOAD_CAP });
    const first = assistantsOf(got)[0];
    expect(first.thinking).toBe(`${big(SYNC_PAYLOAD_CAP, 't')}… [+${5000 - SYNC_PAYLOAD_CAP} chars]`);
    expect(first.toolCalls?.[0].result).toBe(`${big(SYNC_PAYLOAD_CAP, 'r')}… [+${50_000 - SYNC_PAYLOAD_CAP} chars]`);
  });

  test('gives each call with one id the last result of that id, and the error flag of it', () => {
    const calls = assistantsOf(parseClaudeTranscriptText(text, { payloadCap: SYNC_PAYLOAD_CAP })).flatMap((m) => m.toolCalls ?? []);
    const dup = calls.find((c) => c.name === 'Grep');
    expect(dup).toMatchObject({ result: 'second', isError: true });
    const early = calls.find((c) => c.name === 'Edit');
    expect(early?.result).toEqual({ ok: true, items: [1, 2, 3] });
    expect(early?.isError).toBe(false);
  });

  test('keeps 2,000 characters of each of 200 results of 1 MB', () => {
    const recs: unknown[] = [];
    for (let i = 0; i < 200; i++) {
      recs.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: {} }] } });
      recs.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big(1_000_000, String.fromCharCode(97 + (i % 26))) }] } });
    }
    const body = recs.map((r) => JSON.stringify(r)).join('\n');
    const got = parseClaudeTranscriptText(body, { payloadCap: SYNC_PAYLOAD_CAP });
    expect(got).toHaveLength(200);
    expect(JSON.stringify(got).length).toBeLessThan(200 * 2400);
    const head = got[0].toolCalls?.[0].result as string;
    expect(head.length).toBe(SYNC_PAYLOAD_CAP + `… [+${1_000_000 - SYNC_PAYLOAD_CAP} chars]`.length);
  });
});

describe('capPayload', () => {
  test('keeps a lone surrogate at the cut as it was', () => {
    const s = big(SYNC_PAYLOAD_CAP - 1) + '😀' + big(10);
    const out = capPayload(s) as string;
    expect(out.startsWith(big(SYNC_PAYLOAD_CAP - 1) + '\ud83d')).toBe(true);
  });

  test('cuts the values of an object and keeps the keys', () => {
    const out = capPayload({ a: big(20_000), b: 'short' }) as Record<string, string>;
    expect(Object.keys(out)).toEqual(['a', 'b']);
    expect(out.b).toBe('short');
    expect(out.a.endsWith(`… [+${20_000 - SYNC_PAYLOAD_CAP} chars]`)).toBe(true);
  });
});

describe('files and subagents', () => {
  test('a file read line by line gives the messages of the same text read whole, and subagents are cut too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-stream-'));
    try {
      const id = '11111111-2222-3333-4444-555555555555';
      const main = join(dir, `${id}.jsonl`);
      const text = toText(records());
      writeFileSync(main, text);
      mkdirSync(join(dir, id, 'subagents'), { recursive: true });
      writeFileSync(join(dir, id, 'subagents', 'agent-a0123456789abcdef.jsonl'), text);
      writeFileSync(join(dir, id, 'subagents', 'agent-a0123456789abcdef.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'look around' }));

      const fromFile = await parseClaudeTranscript(main, { payloadCap: SYNC_PAYLOAD_CAP });
      expect(wire(fromFile)).toEqual(wire(parseClaudeTranscriptText(text, { payloadCap: SYNC_PAYLOAD_CAP })));

      const subs = await parseClaudeSubagents(main, { payloadCap: SYNC_PAYLOAD_CAP });
      expect(subs).toHaveLength(1);
      expect(subs[0]).toMatchObject({ kind: 'explore', agentType: 'Explore', description: 'look around' });
      expect(wire(subs[0].messages)).toEqual(wire(fromFile));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
