/**
 * Tail segments of a stored envelope (issue #27): the id format, the state of a
 * session and the merge a reader gets.
 */
import { describe, test, expect } from 'vitest';
import { tailRowId, parseTailRowId, tailStateOf, mergeEnvelopeWithTails, peekEnvelopeTail, markerTail, pageEnvelope, type TailBody } from './session-tails.js';

const msg = (line: number, content = `m${line}`) => ({ role: 'user', content, line });
const base = (n: number, o = 100) => JSON.stringify({ v: 6, messages: Array.from({ length: n }, (_, i) => msg(i + 1)), subagents: [], o });
const tail = (over: Partial<TailBody>): string => JSON.stringify({ v: 6, base: 0, o: 0, lastLine: 0, messages: [], ...over });

describe('segment ids', () => {
  test('sort in sequence order as text', () => {
    const ids = [10, 2, 1].map((n) => tailRowId('s1', n)).sort();
    expect(ids.map((id) => parseTailRowId(id)!.seq)).toEqual([1, 2, 10]);
  });

  test('round-trip the session id and the sequence number', () => {
    expect(parseTailRowId(tailRowId('pi_01a1~8e268b72', 7))).toEqual({ sessionId: 'pi_01a1~8e268b72', seq: 7 });
  });

  test('a session id with a hash sign keeps it', () => {
    expect(parseTailRowId(tailRowId('a#b', 3))).toEqual({ sessionId: 'a#b', seq: 3 });
  });

  test('an id that is not a segment id is not parsed', () => {
    expect(parseTailRowId('plain-session')).toBeNull();
    expect(parseTailRowId('s#12')).toBeNull();
    expect(parseTailRowId('s#00000000ab')).toBeNull();
    expect(parseTailRowId('#0000000001')).toBeNull();
  });
});

describe('tailStateOf', () => {
  test('reads the offset and the last line', () => {
    expect(tailStateOf(4, tail({ o: 900, lastLine: 12 }))).toEqual({ seq: 4, o: 900, lastLine: 12, bytes: expect.any(Number) });
  });

  test('a body that is not a segment gives null', () => {
    expect(tailStateOf(1, 'not json')).toBeNull();
    expect(tailStateOf(1, JSON.stringify({ messages: [] }))).toBeNull();
  });
});

describe('mergeEnvelopeWithTails', () => {
  test('without segments the base comes back as it is', () => {
    const b = base(3);
    expect(mergeEnvelopeWithTails(b, [])).toBe(b);
  });

  test('applies the segments in sequence order, whatever order they arrive in', () => {
    const merged = JSON.parse(mergeEnvelopeWithTails(base(2, 100), [
      { seq: 2, body: tail({ o: 300, lastLine: 4, messages: [msg(4)] }) },
      { seq: 1, body: tail({ o: 200, lastLine: 3, messages: [msg(3)] }) },
    ]));
    expect(merged.messages.map((m: { line: number }) => m.line)).toEqual([1, 2, 3, 4]);
    expect(merged.o).toBe(300);
  });

  test('keeps the other fields of the base', () => {
    const merged = JSON.parse(mergeEnvelopeWithTails(JSON.stringify({ v: 6, messages: [msg(1)], subagents: [], o: 1, extra: 'kept' }), [
      { seq: 1, body: tail({ o: 2, messages: [msg(2)] }) },
    ]));
    expect(merged.extra).toBe('kept');
    expect(merged.v).toBe(6);
  });

  test('takes the subagents of the newest segment that has any', () => {
    const merged = JSON.parse(mergeEnvelopeWithTails(base(1), [
      { seq: 1, body: tail({ o: 2, messages: [msg(2)], subagents: [{ id: 'a' }] }) },
      { seq: 2, body: tail({ o: 3, messages: [msg(3)] }) },
    ]));
    expect(merged.subagents).toEqual([{ id: 'a' }]);
  });

  test('a segment that cannot be read gives the base back', () => {
    const b = base(2);
    expect(mergeEnvelopeWithTails(b, [{ seq: 1, body: '{broken' }])).toBe(b);
    expect(mergeEnvelopeWithTails(b, [{ seq: 1, body: JSON.stringify({ o: 1 }) }])).toBe(b);
  });

  test('a base that is not an envelope comes back as it is', () => {
    expect(mergeEnvelopeWithTails('not json', [{ seq: 1, body: tail({ messages: [msg(1)] }) }])).toBe('not json');
    expect(mergeEnvelopeWithTails(JSON.stringify({ v: 6 }), [{ seq: 1, body: tail({ messages: [msg(1)] }) }])).toBe(JSON.stringify({ v: 6 }));
  });

  test('a merge of a large base costs no more than parse and stringify', () => {
    const big = base(8000);
    const t0 = Date.now();
    const merged = JSON.parse(mergeEnvelopeWithTails(big, [{ seq: 1, body: tail({ o: 5, lastLine: 8001, messages: [msg(8001)] }) }]));
    expect(merged.messages).toHaveLength(8001);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('peekEnvelopeTail', () => {
  test('reads the offset and the last line of a stored envelope without parsing it', () => {
    expect(peekEnvelopeTail(base(5, 4096))).toEqual({ o: 4096, lastLine: 5 });
  });

  test('agrees with a parse of the same envelope', () => {
    const text = base(321, 987654);
    const env = JSON.parse(text);
    expect(peekEnvelopeTail(text)).toEqual({ o: env.o, lastLine: env.messages[env.messages.length - 1].line });
  });

  test('an envelope with no messages ends at line 0', () => {
    expect(peekEnvelopeTail(JSON.stringify({ v: 6, messages: [], subagents: [], o: 77 }))).toEqual({ o: 77, lastLine: 0 });
  });

  test('a last message with a long content is found', () => {
    const text = JSON.stringify({ v: 6, messages: [msg(1), { role: 'assistant', content: 'y'.repeat(300_000), line: 2 }], subagents: [], o: 5 });
    expect(peekEnvelopeTail(text)).toEqual({ o: 5, lastLine: 2 });
  });

  test('text in a message that looks like a line key does not count', () => {
    const text = JSON.stringify({ v: 6, messages: [msg(1), { role: 'user', content: 'it said "line":999 here', line: 2 }], subagents: [], o: 5 });
    expect(peekEnvelopeTail(text)?.lastLine).toBe(2);
  });

  test('text that does not end like an envelope gives null', () => {
    expect(peekEnvelopeTail('not json')).toBeNull();
    expect(peekEnvelopeTail(JSON.stringify({ v: 6, messages: [msg(1)], subagents: [] }))).toBeNull();
    expect(peekEnvelopeTail(JSON.stringify({ v: 6, o: 5, messages: [msg(1)] }))).toBeNull();
  });
});

describe('markerTail', () => {
  test('is a segment with no messages that carries the state', () => {
    const t = markerTail(6, 100, 9);
    expect(t).toEqual({ v: 6, base: 100, o: 100, lastLine: 9, messages: [] });
    expect(tailStateOf(0, JSON.stringify(t))).toEqual({ seq: 0, o: 100, lastLine: 9, bytes: expect.any(Number) });
  });
});

describe('pageEnvelope', () => {
  const t1 = tail({ o: 200, lastLine: 5, messages: [msg(4), msg(5)] });
  const t2 = tail({ o: 300, lastLine: 7, messages: [msg(6), msg(7)] });
  const parts = [{ seq: 1, body: t1 }, { seq: 2, body: t2 }];
  const lines = (p: { messages: unknown[] } | null) => (p ? (p.messages as Array<{ line: number }>).map((m) => m.line) : null);

  test('a page that spans the base and a segment', () => {
    const p = pageEnvelope(base(3), parts, 2, 3, 5);
    expect(lines(p)).toEqual([3, 4, 5]);
    expect(p?.total).toBe(7);
  });

  test('a page inside one segment', () => {
    expect(lines(pageEnvelope(base(3), parts, 5, 1, 0))).toEqual([6]);
  });

  test('limit 0 returns every message', () => {
    expect(lines(pageEnvelope(base(3), parts, 0, 0, 0))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('a page past the end is empty and the total is still right', () => {
    const p = pageEnvelope(base(3), parts, 50, 10, 0);
    expect(p?.messages).toEqual([]);
    expect(p?.total).toBe(7);
  });

  test('agrees with the merged envelope for every window', () => {
    const merged = JSON.parse(mergeEnvelopeWithTails(base(3), parts)).messages as Array<{ line: number }>;
    for (const [offset, limit] of [[0, 2], [1, 4], [3, 2], [6, 5], [0, 7]] as const) {
      expect(lines(pageEnvelope(base(3), parts, offset, limit, 0))).toEqual(merged.slice(offset, offset + limit).map((m) => m.line));
    }
  });

  test('a segment that cannot be read leaves the base alone', () => {
    const p = pageEnvelope(base(3), [{ seq: 1, body: '{broken' }], 0, 0, 0);
    expect(lines(p)).toEqual([1, 2, 3]);
    expect(p?.total).toBe(3);
  });

  test('a base that is not an envelope gives null', () => {
    expect(pageEnvelope('not json', parts, 0, 0, 0)).toBeNull();
    expect(pageEnvelope(JSON.stringify({ v: 6 }), parts, 0, 0, 0)).toBeNull();
  });

  test('carries the version, the mtime and the newest subagents', () => {
    const p = pageEnvelope(base(1), [{ seq: 1, body: tail({ messages: [msg(2)], subagents: [{ id: 'a' }] }) }], 0, 0, 1234);
    expect(p).toMatchObject({ v: 6, mtime: 1234, subagents: [{ id: 'a' }] });
  });
});
