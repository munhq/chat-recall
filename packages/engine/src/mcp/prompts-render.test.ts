/**
 * recall_user_prompts returns what the person typed.
 *
 * Three failures these tests exist for:
 * 1. The tool said "newest first", but it kept the first `limit` prompts of the
 *    server's line-ordered list. A session with more prompts than the limit lost
 *    its latest ones, and the cross-session mode did the same in each session.
 * 2. Each prompt was cut at 240 characters with no way to get the rest.
 * 3. "Did I say X?" had no filter, so it took one call per page of prompts.
 */
import { describe, test, expect } from 'vitest';
import { selectPrompts, collectAcrossSessions, renderPrompts, type PromptRow } from './prompts-render.js';
import { BODY_LIMIT, EDGE } from './show-render.js';

const T0 = Date.parse('2026-09-30T12:00:00Z');
const MIN = 60_000;

/** `n` prompts in line order, oldest first, one minute apart — the server's order. */
function session(sessionId: string, n: number, startMs = T0, texts?: (i: number) => string): PromptRow[] {
  return Array.from({ length: n }, (_, i) => ({
    sessionId,
    line: 5 + i * 10,
    ts: startMs + i * MIN,
    tsIso: new Date(startMs + i * MIN).toISOString(),
    markers: [],
    text: texts ? texts(i) : `prompt ${i}`,
  }));
}

describe('order', () => {
  test('THE FAILURE: a limit keeps the newest prompts of a session', () => {
    const rows = session('s1', 80);
    const got = selectPrompts(rows, { limit: 30 });
    expect(got).toHaveLength(30);
    expect(got[0].text).toBe('prompt 79');
    expect(got[29].text).toBe('prompt 50');
    expect(got.map(p => p.line)).toEqual([...got.map(p => p.line)].sort((a, b) => b - a));
  });

  test('a prompt with no timestamp still sorts by line inside its session', () => {
    const rows = session('s1', 3).map(p => ({ ...p, ts: undefined, tsIso: undefined }));
    expect(selectPrompts(rows, { limit: 3 }).map(p => p.line)).toEqual([25, 15, 5]);
  });

  test('empty prompts are dropped before the limit counts', () => {
    const rows = [...session('s1', 2), { sessionId: 's1', line: 99, ts: T0 + 10 * MIN, markers: [], text: '   ' }];
    expect(selectPrompts(rows, { limit: 2 }).map(p => p.text)).toEqual(['prompt 1', 'prompt 0']);
  });
});

describe('across sessions', () => {
  const fetchFrom = (bySession: Record<string, PromptRow[]>, calls: string[] = []) =>
    async (sid: string) => { calls.push(sid); return bySession[sid] ?? null; };

  test('THE FAILURE: the newest prompts of each session, merged newest first', async () => {
    // s1 was written last, but s2 ran at the same time and has newer prompts
    // than most of s1.
    const s1 = session('s1', 50, T0);              // T0 .. T0+49m
    const s2 = session('s2', 40, T0 + 20 * MIN);   // T0+20m .. T0+59m
    const feed = [
      { sessionId: 's2', modifiedMs: T0 + 59 * MIN },
      { sessionId: 's1', modifiedMs: T0 + 49 * MIN },
    ];
    const got = await collectAcrossSessions(feed, fetchFrom({ s1, s2 }), { limit: 25 });
    expect(got).toHaveLength(25);
    const times = got.map(p => p.ts!);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(got[0]).toMatchObject({ sessionId: 's2', text: 'prompt 39' });
    // The 25 newest are s2's last 10 alone (T0+59..50m), then both sessions
    // interleave from T0+49m down.
    expect(got.some(p => p.sessionId === 's1' && p.text === 'prompt 49')).toBe(true);
    expect(got.some(p => p.sessionId === 's1' && p.text === 'prompt 0')).toBe(false);
  });

  test('stops at the first session that cannot hold a newer prompt', async () => {
    const calls: string[] = [];
    const feed = [
      { sessionId: 'a', modifiedMs: T0 + 100 * MIN },
      { sessionId: 'b', modifiedMs: T0 - 1 },
      { sessionId: 'c', modifiedMs: T0 - 2 },
    ];
    const got = await collectAcrossSessions(feed, fetchFrom({ a: session('a', 10), b: session('b', 5, T0 - 10 * MIN) }, calls), { limit: 5 });
    expect(got.map(p => p.text)).toEqual(['prompt 9', 'prompt 8', 'prompt 7', 'prompt 6', 'prompt 5']);
    expect(calls).toEqual(['a']);
  });

  test('a session that is not synced is skipped', async () => {
    const feed = [{ sessionId: 'gone', modifiedMs: T0 + MIN }, { sessionId: 'a', modifiedMs: T0 }];
    const got = await collectAcrossSessions(feed, fetchFrom({ a: session('a', 2) }), { limit: 5 });
    expect(got.map(p => p.sessionId)).toEqual(['a', 'a']);
  });
});

describe('query', () => {
  const texts = (i: number) => (i === 3 ? 'this is too ai - Where it says no - SCREAMS AI' : `prompt ${i}`);

  test('THE FAILURE: "did I say X?" returns the prompts that contain X, in one call', () => {
    const got = selectPrompts(session('s1', 10, T0, texts), { limit: 50, query: 'where it  SAYS no' });
    expect(got.map(p => p.line)).toEqual([35]);
  });

  test('the limit counts the matches, not the prompts read', async () => {
    const feed = [{ sessionId: 's1', modifiedMs: T0 + 200 * MIN }];
    const rows = session('s1', 200, T0, i => (i % 50 === 0 ? `deploy ${i}` : `prompt ${i}`));
    const got = await collectAcrossSessions(feed, async () => rows, { limit: 3, query: 'deploy' });
    expect(got.map(p => p.text)).toEqual(['deploy 150', 'deploy 100', 'deploy 50']);
  });

  test('no match renders nothing', () => {
    expect(selectPrompts(session('s1', 5), { limit: 5, query: 'absent' })).toEqual([]);
  });
});

describe('text', () => {
  test('THE FAILURE: a prompt up to BODY_LIMIT prints whole', () => {
    const text = 'x'.repeat(BODY_LIMIT - 3) + 'END';
    const out = renderPrompts([{ sessionId: 's1', line: 2534, markers: [], text }], { withMarkers: false });
    expect(out).toContain(text);
    expect(out).not.toContain('characters cut');
  });

  test('a longer prompt prints its start, its end and the expand_line call', () => {
    const text = 'S'.repeat(EDGE) + 'm'.repeat(5000) + 'E'.repeat(EDGE);
    const out = renderPrompts([{ sessionId: 's1', line: 2534, markers: [], text }], { withMarkers: false });
    expect(out).toContain('  ' + 'S'.repeat(EDGE));
    expect(out).toContain('  ' + 'E'.repeat(EDGE));
    expect(out).toContain(`… 5000 characters cut (${text.length} in all, 1 lines).`);
    expect(out).toContain('Call recall_show with session_id "s1" and expand_line 2534 for the whole text.');
    expect(out).not.toContain('m'.repeat(200));
  });

  test('line breaks in a prompt are kept, each line indented under its header', () => {
    const out = renderPrompts([{ sessionId: 's1', line: 7, markers: ['correction'], text: 'no\nDO NOT SAY THAT' }], { withMarkers: true });
    expect(out).toContain('- **s1** L7 _[correction]_\n  no\n  DO NOT SAY THAT');
  });

  test('the header names the order and the query', () => {
    const out = renderPrompts(session('s1', 2), { withMarkers: false, query: 'prompt' });
    expect(out.split('\n')[0]).toBe('# User prompts (2, containing "prompt", newest first)');
  });
});
