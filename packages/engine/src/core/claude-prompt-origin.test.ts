/**
 * Who wrote a `user` record. The records below have the shapes Claude Code
 * writes: one real session held 45 "user prompts", and about 20 of them were
 * task notifications, Stop-hook feedback, subagent hand-backs, messages from
 * other sessions and subagent task prompts.
 */
import { describe, test, expect } from 'vitest';
import { userRecordOrigin, queuedCommandPrompt, originFromText, isPersonMessage } from './claude-prompt-origin.js';

describe('userRecordOrigin', () => {
  test('a typed prompt is human, with or without the origin field', () => {
    expect(userRecordOrigin({ type: 'user', origin: { kind: 'human' } }, 'fix the login bug')).toBe('human');
    expect(userRecordOrigin({ type: 'user' }, 'fix the login bug')).toBe('human');
  });

  test('THE FAILURE: harness records are not the person', () => {
    expect(userRecordOrigin({ type: 'user', origin: { kind: 'task-notification' } }, '<task-notification>…')).toBe('task-notification');
    expect(userRecordOrigin({ type: 'user', isMeta: true }, 'Stop hook feedback:\nanswer these')).toBe('meta');
    expect(userRecordOrigin({ type: 'user', isMeta: true, origin: { kind: 'peer', from: 'a1' } },
      'Another Claude session sent a message:\n<agent-message from="a1">')).toBe('peer');
    expect(userRecordOrigin({ type: 'user', isSidechain: true }, 'Repo: /home/user/code/example. Map the code.')).toBe('subagent');
  });

  test('a record with no origin fields is read by its text prefix', () => {
    expect(userRecordOrigin({ type: 'user' }, '<task-notification>\n<task-id>x</task-id>')).toBe('task-notification');
    expect(userRecordOrigin({ type: 'user' }, 'Stop hook feedback:\nanswer')).toBe('hook');
    expect(userRecordOrigin({ type: 'user' }, '<agent-message from="a1">\nreport')).toBe('peer');
  });

  test('a prompt that quotes a prefix later in its text stays human', () => {
    expect(userRecordOrigin({ type: 'user' }, 'why did the <task-notification> say failed?')).toBe('human');
  });
});

describe('queuedCommandPrompt', () => {
  const attachment = (att: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', ...att }, ...extra });

  test('a prompt typed while the agent works is a human prompt', () => {
    expect(queuedCommandPrompt(attachment({ prompt: 'show me a diagram', origin: { kind: 'human' }, humanTurn: true })))
      .toEqual({ text: 'show me a diagram', origin: 'human' });
  });

  test('a queued subagent hand-back or notification keeps its kind', () => {
    expect(queuedCommandPrompt(attachment({ prompt: '<agent-message from="a1">', origin: { kind: 'peer' } }))?.origin).toBe('peer');
    expect(queuedCommandPrompt(attachment({ prompt: '<task-notification>\n<task-id>b</task-id>' }))?.origin).toBe('task-notification');
  });

  test('content blocks are joined', () => {
    const q = queuedCommandPrompt(attachment({ prompt: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }], humanTurn: true }));
    expect(q).toEqual({ text: 'one\ntwo', origin: 'human' });
  });

  test('other attachments and other records are not prompts', () => {
    expect(queuedCommandPrompt({ type: 'attachment', attachment: { type: 'hook_success' } })).toBeNull();
    expect(queuedCommandPrompt({ type: 'user', message: { content: 'x' } })).toBeNull();
    expect(queuedCommandPrompt(attachment({ prompt: '' }))).toBeNull();
  });
});

describe('originFromText and isPersonMessage', () => {
  test('leading whitespace does not hide a prefix', () => {
    expect(originFromText('\n  <task-notification>')).toBe('task-notification');
  });

  test('a message with an origin is not the person', () => {
    expect(isPersonMessage({ role: 'user' })).toBe(true);
    expect(isPersonMessage({ role: 'user', origin: 'task-notification' })).toBe(false);
    expect(isPersonMessage({ role: 'assistant' })).toBe(false);
  });
});
