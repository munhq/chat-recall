/**
 * Which messages recall_show returns for around_line, from_end and expand_line.
 *
 * The failure these tests exist for: around_line kept every message within
 * ±(max_messages/2 × 10) lines of the target and then returned the FIRST
 * max_messages of them. In a session where messages sit one or two lines
 * apart, that set ends before the target. around_line 1768 with max_messages 6
 * returned lines 1745–1752, and around_line 1780 with max_messages 30 returned
 * lines 1633–1716. The message the agent asked for was in neither window.
 *
 * A miss on expand_line named only the session's first and last line, so the
 * agent guessed the next line number and missed again.
 */
import { describe, test, expect } from 'vitest';
import { selectShowWindow, nearestMessageLines, noMessageAtLine, type ShowMessage } from './show-render.js';

/** A dense session: messages on most lines, with the gaps a tool result or a skipped entry leaves. */
function denseSession(count: number): ShowMessage[] {
  const out: ShowMessage[] = [];
  let line = 1;
  for (let i = 0; i < count; i++) {
    out.push({ line, role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
    line += i % 5 === 0 ? 3 : 1;
  }
  return out;
}

const lines = (msgs: ShowMessage[]) => msgs.map((m) => m.line);

describe('around_line', () => {
  const session = denseSession(1000);

  test('THE FAILURE: the target line is in the window, for every window size', () => {
    for (const target of [session[700].line, session[950].line]) {
      for (const maxMessages of [1, 6, 12, 30, 100]) {
        const win = selectShowWindow(session, { aroundLine: target, maxMessages });
        expect(lines(win)).toContain(target);
        expect(win).toHaveLength(maxMessages);
      }
    }
  });

  test('the window is centred on the target message', () => {
    const target = session[500].line;
    const win = selectShowWindow(session, { aroundLine: target, maxMessages: 11 });
    expect(win[5].line).toBe(target);
    expect(win[0]).toBe(session[495]);
    expect(win[10]).toBe(session[505]);
  });

  test('a line with no message centres on the nearest message', () => {
    // Message 5 is followed by a three-line gap.
    const gap = session[5].line + 1;
    const win = selectShowWindow(session, { aroundLine: gap, maxMessages: 3 });
    expect(lines(win)).toEqual([session[4].line, session[5].line, session[6].line]);
  });

  test('near the start and the end, the window is clamped and keeps its size', () => {
    expect(selectShowWindow(session, { aroundLine: 1, maxMessages: 10 })).toEqual(session.slice(0, 10));
    const last = session[session.length - 1].line;
    expect(selectShowWindow(session, { aroundLine: last + 500, maxMessages: 10 })).toEqual(session.slice(-10));
  });

  test('a window larger than the session returns the whole session', () => {
    const small = denseSession(4);
    expect(selectShowWindow(small, { aroundLine: 3, maxMessages: 30 })).toEqual(small);
  });
});

describe('from_end and the default window', () => {
  const session = denseSession(50);

  test('from_end returns the last N messages', () => {
    expect(selectShowWindow(session, { fromEnd: 7, maxMessages: 10 })).toEqual(session.slice(-7));
    expect(selectShowWindow(session, { fromEnd: 500, maxMessages: 10 })).toEqual(session);
    expect(selectShowWindow(session, { fromEnd: 0, maxMessages: 10 })).toEqual(session.slice(-1));
  });

  test('from_end wins over around_line', () => {
    expect(selectShowWindow(session, { fromEnd: 3, aroundLine: 1, maxMessages: 10 })).toEqual(session.slice(-3));
  });

  test('with neither, the first max_messages are returned', () => {
    expect(selectShowWindow(session, { maxMessages: 4 })).toEqual(session.slice(0, 4));
  });

  test('an empty session returns nothing', () => {
    expect(selectShowWindow([], { aroundLine: 10, maxMessages: 5 })).toEqual([]);
  });
});

describe('expand_line on a line with no message', () => {
  const session: ShowMessage[] = [10, 1762, 1763, 1771, 1776, 2556].map((line) => ({ line, role: 'assistant', content: '' }));

  test('THE FAILURE: the reply names the real lines nearest to the one asked for', () => {
    expect(nearestMessageLines(session, 1766)).toEqual([1762, 1763, 1771, 1776]);
    expect(noMessageAtLine(session, 1766, 'abc')).toBe(
      'No message at line 1766 in abc. The nearest messages are at lines 1762, 1763, 1771, 1776.',
    );
  });

  test('a line past the end names the last lines', () => {
    expect(nearestMessageLines(session, 9000, 2)).toEqual([1776, 2556]);
  });
});
