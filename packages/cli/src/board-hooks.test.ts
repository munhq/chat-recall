import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOARD_HOOKS, boardHookCommand, boardHookEntries, isBoardHookEntry,
  mergeBoardHooks, removeBoardHooks, registerBoardHooks,
} from './board-hooks.js';

/** Synthetic paths — a POSIX one and a Windows one that contains a space. */
const NODE_POSIX = '/usr/bin/node';
const CLI_POSIX = '/home/user/.local/lib/node_modules/chat-recall/dist/cli.js';
const NODE_WIN = 'C:\\Program Files\\nodejs\\node.exe';
const CLI_WIN = 'C:\\Users\\First Last\\AppData\\Roaming\\npm\\node_modules\\chat-recall\\dist\\cli.js';

const temps: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cr-board-hooks-'));
  temps.push(d);
  return d;
};
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

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

  test('a stale wrapper entry is replaced by the CLI command', () => {
    const stale = { matcher: '', hooks: [{ type: 'command', command: '"/x/chat_recall_task_hook.sh" --claim' }] };
    const config = { hooks: { UserPromptSubmit: [stale] } as Record<string, unknown[]> };
    mergeBoardHooks(config, NODE_POSIX, CLI_POSIX);
    const cmds = (config.hooks.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>)
      .map((h) => h.hooks[0].command);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('task-hook --claim');
  });

  test('tolerates a malformed entry', () => {
    expect(isBoardHookEntry(null)).toBe(false);
    expect(isBoardHookEntry({})).toBe(false);
    expect(isBoardHookEntry({ hooks: [] })).toBe(false);
    expect(isBoardHookEntry({ hooks: [{ command: 42 }] })).toBe(false);
  });
});

describe('mergeBoardHooks', () => {
  test('adds both entries to an empty config', () => {
    const config: { hooks?: Record<string, unknown[]> } = {};
    mergeBoardHooks(config, NODE_POSIX, CLI_POSIX);
    expect(config.hooks!.UserPromptSubmit).toHaveLength(1);
    expect(config.hooks!.SessionEnd).toHaveLength(1);
  });

  test('keeps a hook that is not ours on the same event', () => {
    const other = { matcher: '', hooks: [{ type: 'command', command: '/x/resume_hook.sh' }] };
    const config = { hooks: { UserPromptSubmit: [other] } };
    mergeBoardHooks(config, NODE_POSIX, CLI_POSIX);
    expect(config.hooks.UserPromptSubmit[0]).toBe(other);
    expect(config.hooks.UserPromptSubmit).toHaveLength(2);
  });

  test('a second run replaces rather than stacks', () => {
    const config: { hooks?: Record<string, unknown[]> } = {};
    mergeBoardHooks(config, NODE_POSIX, CLI_POSIX);
    mergeBoardHooks(config, NODE_POSIX, CLI_POSIX);
    expect(config.hooks!.UserPromptSubmit).toHaveLength(1);
  });

  test('an upgrade to a new bundle path replaces the stale command', () => {
    const config: { hooks?: Record<string, unknown[]> } = {};
    mergeBoardHooks(config, NODE_POSIX, '/old/dist/cli.js');
    mergeBoardHooks(config, NODE_POSIX, '/new/dist/cli.js');
    const cmds = (config.hooks!.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>)
      .map((h) => h.hooks[0].command);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('/new/dist/cli.js');
  });
});

describe('removeBoardHooks', () => {
  test('takes ours out and leaves the rest', () => {
    const other = { matcher: '', hooks: [{ type: 'command', command: '/x/resume_hook.sh' }] };
    const config = { hooks: { UserPromptSubmit: [other] } as Record<string, unknown[]> };
    mergeBoardHooks(config, NODE_POSIX, CLI_POSIX);
    expect(removeBoardHooks(config)).toBe(2);
    expect(config.hooks.UserPromptSubmit).toEqual([other]);
    expect(config.hooks.SessionEnd).toBeUndefined();
  });

  test('removing from a config without them counts nothing', () => {
    expect(removeBoardHooks({ hooks: {} })).toBe(0);
    expect(removeBoardHooks({})).toBe(0);
  });
});

describe('registerBoardHooks', () => {
  test('writes every profile, creating a missing file', () => {
    const dir = tempDir();
    const files = [join(dir, 'a', 'hooks.json'), join(dir, 'b', 'hooks.json')];
    const written = registerBoardHooks(files, NODE_POSIX, CLI_POSIX);
    expect(written).toEqual(files);
    for (const f of files) {
      const cfg = JSON.parse(readFileSync(f, 'utf-8'));
      expect(cfg.hooks.UserPromptSubmit[0].hooks[0].command).toContain('task-hook --claim');
      expect(cfg.hooks.SessionEnd[0].hooks[0].command).toContain('task-hook --close');
    }
  });

  test('an unparseable profile is skipped, not overwritten', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'broken'), { recursive: true });
    const broken = join(dir, 'broken', 'hooks.json');
    writeFileSync(broken, '{ this is not json');
    const ok = join(dir, 'ok', 'hooks.json');

    expect(registerBoardHooks([broken, ok], NODE_POSIX, CLI_POSIX)).toEqual([ok]);
    expect(readFileSync(broken, 'utf-8')).toBe('{ this is not json');
  });

  test('the events it registers are the ones the loop needs', () => {
    expect(BOARD_HOOKS.map((h) => h.event)).toEqual(['UserPromptSubmit', 'SessionEnd']);
  });
});
