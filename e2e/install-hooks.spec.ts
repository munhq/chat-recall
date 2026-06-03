/**
 * `chat-recall install-hooks` end-to-end test.
 *
 * Spawns the CLI with HOME pointed at a sandbox tmpdir, asserts that:
 *  - both hook scripts (save + resume-hint) are copied + executable
 *  - ~/.claude/hooks.json gains Stop, PreCompact, and UserPromptSubmit entries
 *  - re-running install does not duplicate our entries (idempotent)
 *  - pre-existing third-party entries are left untouched on every event
 *  - --uninstall removes only our entries from all three events
 */
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const CLI = join(REPO, 'packages/cli/dist', 'cli.js');

function runCli(home: string, ...args: string[]) {
  return spawnSync('node', [CLI, ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });
}

test.describe('install-hooks CLI', () => {
  test.skip(!existsSync(CLI), 'dist/cli.js not built — run `npm run build` first');

  test('installs Stop + PreCompact + UserPromptSubmit hooks idempotently and leaves third-party entries alone', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'crh-'));
    try {
      const claudeDir = join(sandbox, '.claude');
      mkdirSync(claudeDir, { recursive: true });

      // Pre-populate hooks.json with third-party entries we must not clobber.
      const initial = {
        hooks: {
          Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/usr/bin/echo external' }] }],
          UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: '/usr/bin/echo prompt' }] }],
        },
      };
      writeFileSync(join(claudeDir, 'hooks.json'), JSON.stringify(initial, null, 2));

      // First install — adds our entries to all three events.
      const r1 = runCli(sandbox, 'install-hooks');
      expect(r1.status).toBe(0);

      // Both hook scripts copied + executable.
      const saveHook = join(claudeDir, 'chat-recall-hooks', 'chat_recall_save_hook.sh');
      const resumeHook = join(claudeDir, 'chat-recall-hooks', 'chat_recall_resume_hook.sh');
      expect(existsSync(saveHook)).toBe(true);
      expect(existsSync(resumeHook)).toBe(true);
      expect(statSync(saveHook).mode & 0o100).toBeTruthy();
      expect(statSync(resumeHook).mode & 0o100).toBeTruthy();

      // hooks.json: Stop has external + ours, PreCompact has ours, UserPromptSubmit has external + ours.
      const after1 = JSON.parse(readFileSync(join(claudeDir, 'hooks.json'), 'utf-8'));
      expect(after1.hooks.Stop.length).toBe(2);
      expect(after1.hooks.PreCompact.length).toBe(1);
      expect(after1.hooks.UserPromptSubmit.length).toBe(2);
      expect(after1.hooks.PreCompact[0].hooks[0].command).toContain('chat_recall_save_hook.sh --precompact');
      const ourResume = after1.hooks.UserPromptSubmit.find((h: any) =>
        (h.hooks?.[0]?.command || '').includes('chat_recall_resume_hook.sh'));
      expect(ourResume).toBeTruthy();

      // Re-run: idempotent — every event still has exactly one of ours.
      const r2 = runCli(sandbox, 'install-hooks');
      expect(r2.status).toBe(0);
      const after2 = JSON.parse(readFileSync(join(claudeDir, 'hooks.json'), 'utf-8'));
      expect(after2.hooks.Stop.length).toBe(2);
      expect(after2.hooks.PreCompact.length).toBe(1);
      expect(after2.hooks.UserPromptSubmit.length).toBe(2);
      const ourStop = after2.hooks.Stop.filter((h: any) => (h.hooks?.[0]?.command || '').includes('chat_recall_save_hook.sh'));
      expect(ourStop.length).toBe(1);
      const oursInUPS = after2.hooks.UserPromptSubmit.filter((h: any) =>
        (h.hooks?.[0]?.command || '').includes('chat_recall_resume_hook.sh'));
      expect(oursInUPS.length).toBe(1);

      // Uninstall removes only ours from all three events.
      const r3 = runCli(sandbox, 'install-hooks', '--uninstall');
      expect(r3.status).toBe(0);
      const after3 = JSON.parse(readFileSync(join(claudeDir, 'hooks.json'), 'utf-8'));
      expect(after3.hooks.Stop.length).toBe(1);
      expect(after3.hooks.Stop[0].hooks[0].command).toBe('/usr/bin/echo external');
      expect(after3.hooks.PreCompact).toBeUndefined();
      expect(after3.hooks.UserPromptSubmit.length).toBe(1);
      expect(after3.hooks.UserPromptSubmit[0].hooks[0].command).toBe('/usr/bin/echo prompt');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('--no-resume-hint skips the UserPromptSubmit registration', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'crh-'));
    try {
      mkdirSync(join(sandbox, '.claude'), { recursive: true });
      const r = runCli(sandbox, 'install-hooks', '--no-resume-hint');
      expect(r.status).toBe(0);
      const cfg = JSON.parse(readFileSync(join(sandbox, '.claude', 'hooks.json'), 'utf-8'));
      expect(cfg.hooks.Stop.length).toBe(1);
      expect(cfg.hooks.PreCompact.length).toBe(1);
      expect(cfg.hooks.UserPromptSubmit).toBeUndefined();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
