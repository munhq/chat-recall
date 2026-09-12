/**
 * The guard's registration in the four tools that are not Claude Code.
 *
 * Each merge writes one tool's own shape, so these assert the shape each
 * harness documents — a wrong key is written silently and the hook never runs.
 */
import { describe, test, expect } from 'vitest';
import {
  registerGuard, unregisterGuard, guardCommand, guardTargets, GUARD_ID,
  guardWrapperName, guardWrapperSource,
} from './guard-registration.js';

const HOOK = '/home/user/.chat-recall/hooks/chat_recall_guard_codex.sh';

describe('the command a harness runs', () => {
  test('a path without a space is written bare, so an argv split still finds it', () => {
    expect(guardCommand(HOOK)).toBe(HOOK);
  });

  test('a path with a space is quoted', () => {
    expect(guardCommand('/Users/first last/hook.sh')).toBe('"/Users/first last/hook.sh"');
  });
});

describe('the per-tool wrapper', () => {
  test('names one harness and execs the shared hook', () => {
    const src = guardWrapperSource('agy', '/home/user/.chat-recall/hooks/chat_recall_guard_hook.sh');
    expect(src.startsWith('#!/bin/sh')).toBe(true);
    expect(src).toContain('CHAT_RECALL_GUARD_HARNESS=agy');
    expect(src).toContain('exec "/home/user/.chat-recall/hooks/chat_recall_guard_hook.sh"');
  });

  test('every tool gets its own file name', () => {
    const names = (['codex', 'agy', 'cursor', 'opencode'] as const).map(guardWrapperName);
    expect(new Set(names).size).toBe(4);
  });
});

describe('Codex', () => {
  test('registers a PreToolUse command hook', () => {
    const c = registerGuard('codex', {}, guardCommand(HOOK));
    const entry = c.hooks.PreToolUse[0];
    expect(entry.matcher).toContain('Bash');
    expect(entry.hooks[0].type).toBe('command');
    expect(entry.hooks[0].command).toContain('chat_recall_guard_codex');
  });

  test('a second install leaves one registration', () => {
    let c = registerGuard('codex', {}, guardCommand(HOOK));
    c = registerGuard('codex', c, guardCommand(HOOK));
    expect(c.hooks.PreToolUse).toHaveLength(1);
  });

  test("somebody else's hook survives both install and uninstall", () => {
    const theirs = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './mine.sh' }] }] } };
    const installed = registerGuard('codex', theirs, guardCommand(HOOK));
    expect(installed.hooks.PreToolUse).toHaveLength(2);
    const { config, removed } = unregisterGuard('codex', installed);
    expect(removed).toBe(1);
    expect(config.hooks.PreToolUse).toHaveLength(1);
    expect(config.hooks.PreToolUse[0].hooks[0].command).toBe('./mine.sh');
  });
});

describe('Antigravity', () => {
  test('registers under a named group', () => {
    const c = registerGuard('agy', {}, guardCommand(HOOK));
    expect(c[GUARD_ID].enabled).toBe(true);
    expect(c[GUARD_ID].PreToolUse[0].matcher).toContain('run_command');
  });

  test('another group is left alone', () => {
    const theirs = { 'safety-gate': { PreToolUse: [] } };
    const c = registerGuard('agy', theirs, guardCommand(HOOK));
    const { config, removed } = unregisterGuard('agy', c);
    expect(removed).toBe(1);
    expect(config['safety-gate']).toBeDefined();
    expect(config[GUARD_ID]).toBeUndefined();
  });
});

describe('Cursor', () => {
  test('registers both events and stamps the version', () => {
    const c = registerGuard('cursor', {}, guardCommand(HOOK));
    expect(c.version).toBe(1);
    expect(c.hooks.beforeShellExecution).toHaveLength(1);
    expect(c.hooks.afterFileEdit).toHaveLength(1);
  });

  test('an existing version number is kept', () => {
    const c = registerGuard('cursor', { version: 2 }, guardCommand(HOOK));
    expect(c.version).toBe(2);
  });

  test('uninstall removes both entries and keeps the rest', () => {
    const theirs = { version: 1, hooks: { beforeShellExecution: [{ command: './format.sh' }] } };
    const installed = registerGuard('cursor', theirs, guardCommand(HOOK));
    const { config, removed } = unregisterGuard('cursor', installed);
    expect(removed).toBe(2);
    expect(config.hooks.beforeShellExecution).toEqual([{ command: './format.sh' }]);
    expect(config.hooks.afterFileEdit).toBeUndefined();
  });
});

describe('the targets', () => {
  test('every tool names a config file and the directory that tool owns', () => {
    const targets = guardTargets();
    expect(targets.map((t) => t.tool).sort()).toEqual(['agy', 'codex', 'cursor', 'opencode']);
    for (const t of targets) {
      expect(t.configPath.startsWith(t.homeDir) || t.tool === 'opencode').toBe(true);
      expect(t.label.length).toBeGreaterThan(0);
    }
  });
});
