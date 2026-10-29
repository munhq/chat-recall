import { describe, test, expect } from 'vitest';
import {
  boardHookCommand, boardHookEntries, isBoardHookEntry,
  MESSAGE_HOOK_EVENTS, MESSAGE_WAITER_EVENTS, messageHookCommand, messageHookEntries,
  isMessageHookEntry, isMessageWaiterEntry,
} from './board-hooks.js';

/** Synthetic paths — a POSIX one and a Windows one that contains a space. */
const NODE_POSIX = '/usr/bin/node';
const CLI_POSIX = '/home/user/.local/lib/node_modules/chat-recall/dist/cli.js';
const NODE_WIN = 'C:\\Program Files\\nodejs\\node.exe';
const CLI_WIN = 'C:\\Users\\First Last\\AppData\\Roaming\\npm\\node_modules\\chat-recall\\dist\\cli.js';


describe('boardHookCommand', () => {
  test('runs the CLI, with both paths quoted', () => {
    expect(boardHookCommand(NODE_POSIX, CLI_POSIX, 'claim'))
      .toBe(`"${NODE_POSIX}" "${CLI_POSIX}" task-hook --claim`);
  });

  test('a Windows path with a space stays one argument', () => {
    // cmd.exe splits an unquoted "C:\\Program Files\\..." at the space, and the
    // hook then fails on every turn.
    const cmd = boardHookCommand(NODE_WIN, CLI_WIN, 'close');
    expect(cmd).toBe(`"${NODE_WIN}" "${CLI_WIN}" task-hook --close`);
    expect(cmd.startsWith('"C:\\Program Files\\nodejs\\node.exe"')).toBe(true);
  });

  test('the two modes differ only in the flag', () => {
    const claim = boardHookCommand(NODE_POSIX, CLI_POSIX, 'claim');
    const close = boardHookCommand(NODE_POSIX, CLI_POSIX, 'close');
    expect(claim.replace('--claim', '--close')).toBe(close);
  });
});

describe('boardHookEntries', () => {
  test('covers both halves of the loop', () => {
    const entries = boardHookEntries(NODE_POSIX, CLI_POSIX);
    expect(entries.map(([e]) => e)).toEqual(['UserPromptSubmit', 'SessionEnd']);
    expect(entries[0][1].hooks[0].command).toContain('--claim');
    expect(entries[1][1].hooks[0].command).toContain('--close');
  });

  test('every entry is recognised as ours', () => {
    for (const [, entry] of boardHookEntries(NODE_WIN, CLI_WIN)) {
      expect(isBoardHookEntry(entry)).toBe(true);
    }
  });
});

describe('isBoardHookEntry', () => {
  test('leaves another tool\'s hook alone', () => {
    expect(isBoardHookEntry({ hooks: [{ command: '/opt/other/hook.sh' }] })).toBe(false);
    expect(isBoardHookEntry({ hooks: [{ command: 'chat-recall escalate' }] })).toBe(false);
  });

  test('recognises the retired shell wrapper so it gets cleaned up', () => {
    // The script is gone. A registration still naming it errors on every turn
    // until something removes it.
    expect(isBoardHookEntry({
      hooks: [{ command: '"/home/user/.chat-recall/hooks/chat_recall_task_hook.sh" --claim' }],
    })).toBe(true);
  });

  test('tolerates a malformed entry', () => {
    expect(isBoardHookEntry(null)).toBe(false);
    expect(isBoardHookEntry({})).toBe(false);
    expect(isBoardHookEntry({ hooks: [] })).toBe(false);
    expect(isBoardHookEntry({ hooks: [{ command: 42 }] })).toBe(false);
  });
});

describe('message hook registration', () => {
  const HOOK_POSIX = '/home/user/.local/lib/node_modules/chat-recall/dist/message-hook.js';
  const HOOK_WIN = 'C:\\Users\\First Last\\AppData\\Roaming\\npm\\node_modules\\chat-recall\\dist\\message-hook.js';

  test('the command runs the hook bundle, both paths quoted', () => {
    expect(messageHookCommand(NODE_WIN, HOOK_WIN)).toBe(`"${NODE_WIN}" "${HOOK_WIN}"`);
  });

  test('a turn run on four events and a waiter with asyncRewake on three, each recognised as ours', () => {
    const entries = messageHookEntries(NODE_POSIX, HOOK_POSIX);
    const turns = entries.filter(([, e]) => !e.hooks[0].asyncRewake);
    const waiters = entries.filter(([, e]) => e.hooks[0].asyncRewake);
    expect(turns.map(([ev]) => ev)).toEqual([...MESSAGE_HOOK_EVENTS]);
    expect(waiters.map(([ev]) => ev)).toEqual([...MESSAGE_WAITER_EVENTS]);
    for (const [, e] of waiters) {
      expect(e.hooks[0].command).toBe(`"${NODE_POSIX}" "${HOOK_POSIX}" --wait`);
      expect(isMessageWaiterEntry(e)).toBe(true);
    }
    for (const [, e] of turns) expect(isMessageWaiterEntry(e)).toBe(false);
    for (const [, e] of entries) expect(isMessageHookEntry(e)).toBe(true);
  });

  test('the two kinds of hook do not claim each other\'s entries', () => {
    for (const [, entry] of messageHookEntries(NODE_POSIX, HOOK_POSIX)) expect(isBoardHookEntry(entry)).toBe(false);
    for (const [, entry] of boardHookEntries(NODE_POSIX, CLI_POSIX)) expect(isMessageHookEntry(entry)).toBe(false);
    expect(isMessageHookEntry({ hooks: [{ command: '/opt/other/message-hook.sh' }] })).toBe(false);
  });

});
