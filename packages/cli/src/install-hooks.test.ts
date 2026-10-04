import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_HOOKS, ensureHooks, installHooks, isOurEntry, uninstallHooks, claudeSettingsFiles,
} from './install-hooks.js';
import { isMessageHookEntry, isMessageWaiterEntry, isBoardHookEntry } from './board-hooks.js';

const here = dirname(fileURLToPath(import.meta.url));
const saved = { home: process.env.CHAT_RECALL_CLAUDE_HOME, data: process.env.CHAT_RECALL_DATA_DIR };
let root: string;
let profile: string;
let settingsFile: string;

const read = (f: string) => JSON.parse(readFileSync(f, 'utf-8'));
const commands = (cfg: any, event: string): string[] =>
  (cfg.hooks?.[event] ?? []).map((h: any) => h.hooks?.[0]?.command ?? '');
const FOREIGN = { matcher: '', hooks: [{ type: 'command', command: '/opt/other/notify.sh' }] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cr-install-hooks-'));
  profile = join(root, 'claude');
  mkdirSync(join(profile, 'projects'), { recursive: true });
  settingsFile = join(profile, 'settings.json');
  process.env.CHAT_RECALL_CLAUDE_HOME = profile;
  process.env.CHAT_RECALL_DATA_DIR = join(root, 'data');
});
afterEach(() => {
  process.env.CHAT_RECALL_CLAUDE_HOME = saved.home;
  process.env.CHAT_RECALL_DATA_DIR = saved.data;
  if (saved.home === undefined) delete process.env.CHAT_RECALL_CLAUDE_HOME;
  if (saved.data === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('installHooks', () => {
  test('registers every hook in settings.json, the file Claude Code reads', async () => {
    const r = await installHooks(here);
    expect(r.written).toEqual([settingsFile]);
    const cfg = read(settingsFile);
    expect(commands(cfg, 'SessionStart').some((c) => c.includes('message-hook'))).toBe(true);
    expect(cfg.hooks.Stop.some(isMessageWaiterEntry)).toBe(true);
    expect(cfg.hooks.Stop.find(isMessageWaiterEntry).hooks[0].asyncRewake).toBe(true);
    expect(cfg.hooks.PostToolUse).toBeUndefined();
    expect(cfg.hooks.UserPromptSubmit.some(isBoardHookEntry)).toBe(true);
    if (process.platform !== 'win32') {
      expect(commands(cfg, 'Stop').some((c) => c.includes('chat_recall_save_hook.sh'))).toBe(true);
      expect(commands(cfg, 'SessionStart').some((c) => c.includes('chat_recall_wakeup_hook.sh'))).toBe(true);
      expect(commands(cfg, 'PreToolUse').some((c) => c.includes('chat_recall_guard_hook.sh'))).toBe(true);
      // The scripts are copied where the commands point, and every path is quoted.
      for (const c of commands(cfg, 'Stop')) {
        const path = c.match(/^"([^"]+)"/)?.[1];
        expect(path && existsSync(path)).toBe(true);
      }
    }
  });

  test('keeps every other setting and every foreign hook', async () => {
    writeFileSync(settingsFile, JSON.stringify({ model: 'opus', hooks: { Stop: [FOREIGN] }, permissions: { allow: ['Bash(ls)'] } }));
    await installHooks(here);
    const cfg = read(settingsFile);
    expect(cfg.model).toBe('opus');
    expect(cfg.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(cfg.hooks.Stop[0]).toEqual(FOREIGN);
  });

  test('a second run replaces its entries and adds no duplicate', async () => {
    await installHooks(here);
    const first = read(settingsFile);
    await installHooks(here);
    expect(read(settingsFile)).toEqual(first);
  });

  test('a hand-wired copy of one of our scripts is replaced, so it runs once', async () => {
    writeFileSync(settingsFile, JSON.stringify({ hooks: { SessionStart: [
      { matcher: 'startup', hooks: [{ type: 'command', command: '/home/user/code/example/hooks/chat_recall_wakeup_hook.sh' }] },
    ] } }));
    await installHooks(here);
    const wake = commands(read(settingsFile), 'SessionStart').filter((c) => c.includes('chat_recall_wakeup_hook.sh'));
    expect(wake).toHaveLength(process.platform === 'win32' ? 0 : 1);
  });

  test('moves our entries out of hooks.json and leaves foreign ones there', async () => {
    const legacy = join(profile, 'hooks.json');
    writeFileSync(legacy, JSON.stringify({ hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/x/chat_recall_save_hook.sh' }] }, FOREIGN],
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: '"/usr/bin/node" "/x/dist/cli.js" task-hook --claim' }] }],
    } }));
    const r = await installHooks(here);
    expect(r.migrated).toBe(2);
    expect(read(legacy)).toEqual({ hooks: { Stop: [FOREIGN] } });
  });

  test('an earlier PostToolUse registration of the message hook is removed', async () => {
    writeFileSync(settingsFile, JSON.stringify({ hooks: { PostToolUse: [
      { matcher: '', hooks: [{ type: 'command', command: '"/usr/bin/node" "/x/dist/message-hook.js"' }] }, FOREIGN,
    ] } }));
    await installHooks(here);
    expect(read(settingsFile).hooks.PostToolUse).toEqual([FOREIGN]);
  });

  test('a hooks.json that held only our entries is removed', async () => {
    const legacy = join(profile, 'hooks.json');
    writeFileSync(legacy, JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/x/chat_recall_save_hook.sh' }] }] } }));
    await installHooks(here);
    expect(existsSync(legacy)).toBe(false);
  });

  test('an unparseable settings.json is left exactly as it was', async () => {
    writeFileSync(settingsFile, '{ "model": "opus", ');
    const r = await installHooks(here);
    expect(r.skipped).toEqual([settingsFile]);
    expect(readFileSync(settingsFile, 'utf-8')).toBe('{ "model": "opus", ');
  });

  test('a selection leaves the hooks that were turned off out', async () => {
    await installHooks(here, { ...ALL_HOOKS, messages: false, taskBoard: false });
    const cfg = read(settingsFile);
    const all = Object.values(cfg.hooks).flat();
    expect(all.some(isMessageHookEntry)).toBe(false);
    expect(all.some(isBoardHookEntry)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('a settings.json shared through a symlink', () => {
  test('stays a symlink, and is written once', async () => {
    const shared = join(root, 'shared-settings.json');
    writeFileSync(shared, JSON.stringify({ model: 'opus' }));
    symlinkSync(shared, settingsFile);
    const r = await installHooks(here);
    expect(r.written).toEqual([settingsFile]);
    expect(lstatSync(settingsFile).isSymbolicLink()).toBe(true);
    expect(read(shared).model).toBe('opus');
    expect(read(shared).hooks.Stop.some(isMessageWaiterEntry)).toBe(true);
  });
});

describe('uninstallHooks', () => {
  test('removes ours from settings.json and hooks.json, and keeps foreign hooks', async () => {
    writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [FOREIGN] } }));
    await installHooks(here);
    const r = await uninstallHooks();
    expect(r.removed).toBeGreaterThan(0);
    const cfg = read(settingsFile);
    expect(Object.values(cfg.hooks).flat().some(isOurEntry)).toBe(false);
    expect(cfg.hooks.Stop).toEqual([FOREIGN]);
  });
});

describe('ensureHooks — the repair the MCP server runs at start', () => {
  test('installs on a machine that never ran init', async () => {
    const r = await ensureHooks(here);
    expect(r?.written).toEqual([settingsFile]);
  });

  test('does nothing when this version already installed them', async () => {
    await installHooks(here);
    expect(await ensureHooks(here)).toBeNull();
  });

  test('repairs a profile whose hooks were lost', async () => {
    await installHooks(here);
    writeFileSync(settingsFile, JSON.stringify({ model: 'opus' }));
    const r = await ensureHooks(here);
    expect(r?.written).toEqual([settingsFile]);
    expect(read(settingsFile).hooks.Stop.some(isMessageWaiterEntry)).toBe(true);
    expect(read(settingsFile).model).toBe('opus');
  });

  test('reaches a profile added after the install', async () => {
    await installHooks(here);
    // A sibling profile is found only without a pinned home, so pin a second one.
    const second = join(root, 'claude-work');
    mkdirSync(join(second, 'projects'), { recursive: true });
    process.env.CHAT_RECALL_CLAUDE_HOME = second;
    expect(claudeSettingsFiles()).toEqual([join(second, 'settings.json')]);
    const r = await ensureHooks(here);
    expect(r?.written).toEqual([join(second, 'settings.json')]);
  });

  test('keeps out of a machine where the user uninstalled the hooks', async () => {
    await installHooks(here);
    await uninstallHooks();
    expect(await ensureHooks(here)).toBeNull();
    expect(Object.values(read(settingsFile).hooks ?? {}).flat().some(isOurEntry)).toBe(false);
  });

  test('repairs with the selection the user chose', async () => {
    await installHooks(here, { ...ALL_HOOKS, guard: false });
    writeFileSync(settingsFile, '{}');
    await ensureHooks(here);
    expect(commands(read(settingsFile), 'PreToolUse').some((c) => c.includes('chat_recall_guard_hook.sh'))).toBe(false);
  });
});
