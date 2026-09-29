/**
 * Harness text in a synced envelope (task notifications, hook feedback,
 * subagent hand-backs) was indexed as `user_context`, so the classifier tagged
 * it as the person's decisions and corrections.
 */
import { describe, test, expect } from 'vitest';
import { chunksFromTurns, chunkRole } from './session-chunks.js';

const build = (turns: Parameters<typeof chunksFromTurns>[1]) =>
  chunksFromTurns('s1', turns, '/home/user/code/example', Date.parse('2026-08-21'));

describe('chunkRole', () => {
  test('a user message with an origin is harness text', () => {
    expect(chunkRole({ role: 'user', origin: 'task-notification' })).toBe('harness');
    expect(chunkRole({ role: 'user' })).toBe('user');
    expect(chunkRole({ role: 'assistant' })).toBe('assistant');
  });
});

describe('harness chunks', () => {
  test('THE FAILURE: harness text is not classified as the person', () => {
    const text = 'Stop hook feedback: we decided to ship it, never do that again';
    const [chunk] = build([{ role: 'harness', text }]);
    expect(chunk.chunkType).toBe('harness');
    const [asUser] = build([{ role: 'user', text }]);
    expect(asUser.chunkType).toMatch(/^user_context:/);
  });

  test('harness text has its own cap, so tool results keep theirs', () => {
    const turns: Parameters<typeof chunksFromTurns>[1] = [];
    for (let i = 0; i < 80; i++) turns.push({ role: 'harness', text: `<task-notification> task ${i} finished` });
    for (let i = 0; i < 80; i++) turns.push({ role: 'tool_result', text: `result number ${i} of the build` });
    const chunks = build(turns);
    expect(chunks.filter((c) => c.chunkType === 'harness')).toHaveLength(60);
    expect(chunks.filter((c) => c.chunkType === 'tool_result')).toHaveLength(60);
  });
});
