/**
 * The summary model reads what buildSummaryContext gives it. It read the first
 * 5 user and first 5 assistant messages, so a long session was summarised from
 * its first minutes and called "cut off".
 */
import { describe, test, expect } from 'vitest';
import { buildSummaryContext, spreadOrder } from './summary-generator.js';
import type { SessionContent } from '../parsers/session.js';

function session(turns: number, text = (i: number) => `turn ${i}`): SessionContent {
  const userMessages: SessionContent['userMessages'] = [];
  const assistantMessages: SessionContent['assistantMessages'] = [];
  for (let i = 0; i < turns; i++) {
    const line = i + 1;
    if (i % 2 === 0) userMessages.push({ text: text(i), lineNumber: line, contentType: 'user' });
    else assistantMessages.push({ text: text(i), lineNumber: line, contentType: 'assistant' });
  }
  return {
    sessionId: 's', sessionPath: '', summaries: [], userMessages, assistantMessages,
    toolResults: [], toolsUsed: new Set(), firstPrompt: 'turn 0',
    metadata: {} as SessionContent['metadata'],
  };
}

describe('buildSummaryContext', () => {
  test('a session that fits is sent whole, in order', () => {
    const ctx = buildSummaryContext(session(12));
    for (let i = 0; i < 12; i++) expect(ctx).toContain(`: turn ${i}`);
    expect(ctx).not.toContain('left out');
    expect(ctx.indexOf('turn 3')).toBeLessThan(ctx.indexOf('turn 4'));
    expect(ctx).toContain('Conversation (12 messages)');
  });

  test('a long session keeps its end, and samples the middle within the budget', () => {
    const pad = 'x'.repeat(300);
    const budget = 6000;
    const ctx = buildSummaryContext(session(262, (i) => `turn ${i} ${pad}`), budget);
    const conversation = ctx.slice(ctx.indexOf('Conversation ('));
    expect(conversation.length).toBeLessThan(budget + 200);
    // The last messages show where the session stopped.
    for (let i = 254; i < 262; i++) expect(ctx).toContain(`: turn ${i} `);
    expect(ctx).toContain('User: turn 0 ');
    // A prompt from the middle is in, so the summary sees the later requests.
    const shownUserTurns = [...conversation.matchAll(/User: turn (\d+) /g)].map((m) => Number(m[1]));
    expect(shownUserTurns.some((t) => t > 80 && t < 180)).toBe(true);
    expect(conversation).toMatch(/\[\d+ messages left out\]/);
  });

  test('the left-out counts add up to the messages not shown', () => {
    const ctx = buildSummaryContext(session(100, (i) => `turn ${i} ${'y'.repeat(200)}`), 4000);
    const shown = (ctx.match(/^(User|Assistant): /gm) ?? []).length;
    const left = [...ctx.matchAll(/\[(\d+) messages? left out\]/g)].reduce((n, m) => n + Number(m[1]), 0);
    expect(shown + left).toBe(100);
  });
});

describe('spreadOrder', () => {
  test('every prefix is spread over the whole range', () => {
    expect(spreadOrder([0, 1, 2, 3, 4, 5, 6, 7, 8])).toEqual([0, 8, 4, 2, 6, 1, 3, 5, 7]);
  });

  test('each item appears once', () => {
    const items = Array.from({ length: 37 }, (_, i) => i);
    expect([...spreadOrder(items)].sort((a, b) => a - b)).toEqual(items);
  });
});
