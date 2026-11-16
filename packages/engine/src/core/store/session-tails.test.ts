/**
 * Tail segments of a stored envelope (issue #27): the id format, the state of a
 * session and the merge a reader gets.
 */
import { describe, test, expect } from 'vitest';
import { tailRowId, parseTailRowId, tailStateOf, mergeEnvelopeWithTails, type TailBody } from './session-tails.js';

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
    expect(tailStateOf(4, tail({ o: 900, lastLine: 12 }))).toEqual({ seq: 4, o: 900, lastLine: 12 });
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
