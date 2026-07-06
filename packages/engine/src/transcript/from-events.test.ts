/**
 * Pins the generic canonical-event → messages converter that lets parseTranscript
 * handle any ToolBackend (the fix for agy sessions parsing to null and never
 * syncing).
 */
import { describe, test, expect } from 'vitest';
import { canonicalEventsToMessages } from './from-events.js';
import type { CanonicalEvent } from '../core/tool-backend.js';

const ev = (e: Partial<CanonicalEvent> & { kind: CanonicalEvent['kind'] }): CanonicalEvent =>
  ({ ts: 0, line: 0, ...e });

describe('canonicalEventsToMessages', () => {
  test('user + assistant_text + tool_use + tool_result → grouped messages', () => {
    const msgs = canonicalEventsToMessages([
      ev({ kind: 'user', line: 1, text: 'hello' }),
      ev({ kind: 'assistant_text', line: 2, text: 'on it' }),
      ev({ kind: 'tool_use', line: 3, toolName: 'Bash', toolUseId: 't1', toolInput: { cmd: 'ls' } }),
      ev({ kind: 'tool_result', line: 4, toolUseId: 't1', resultBody: 'file.txt', resultIsError: false }),
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toBe('on it');
    expect(msgs[1].toolCalls).toHaveLength(1);
    expect(msgs[1].toolCalls![0]).toMatchObject({ name: 'Bash', input: { cmd: 'ls' }, result: 'file.txt', isError: false });
  });

  test('tool_use with no preceding assistant_text starts an assistant message', () => {
    const msgs = canonicalEventsToMessages([
      ev({ kind: 'user', line: 1, text: 'go' }),
      ev({ kind: 'tool_use', line: 2, toolName: 'Read', toolUseId: 't1', toolInput: {} }),
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: '' });
    expect(msgs[1].toolCalls![0].name).toBe('Read');
  });

  test('summary events become summary messages; empty input → empty output', () => {
    expect(canonicalEventsToMessages([])).toEqual([]);
    const msgs = canonicalEventsToMessages([ev({ kind: 'summary', line: 1, text: 'recap' })]);
    expect(msgs).toEqual([{ line: 1, role: 'summary', content: 'recap' }]);
  });

  test('orphan tool_result (no matching id) is ignored, does not throw', () => {
    const msgs = canonicalEventsToMessages([
      ev({ kind: 'assistant_text', line: 1, text: 'x' }),
      ev({ kind: 'tool_result', line: 2, toolUseId: 'nope', resultBody: 'y' }),
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].toolCalls).toBeUndefined();
  });
});
