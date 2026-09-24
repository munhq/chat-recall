/**
 * Let a long-running MCP daemon sync with the CLI that is installed now.
 *
 * A daemon keeps the code it loaded. Auto-update installs a new version on
 * disk and then restarts the watch service, and a machine that syncs through
 * its MCP daemon alone has no watch service to restart. One such daemon ran
 * 0.6.1 for 19 days while 0.6.5 sat on disk, and every sync it made in that
 * time used the old code.
 *
 * The daemon cannot restart itself: each open session's relay exits when its
 * socket closes, and the session then loses its tools. So it keeps serving
 * them, and runs each background sync as a child process of the installed
 * CLI. `npm install -g` replaces the package in place, so the `cli.js` beside
 * this bundle IS the installed version.
 */
import { spawn } from 'node:child_process';

import { compareVersions } from './auto-update.js';

/** True when the version on disk is newer than the one this process runs. */
export function installedIsNewer(running: string, installed: string | null): boolean {
  return !!installed && compareVersions(installed, running) > 0;
}

/** A background sync must never hang the daemon's tick loop. */
const CHILD_TIMEOUT_MS = 20 * 60_000;

/**
 * Run `chat-recall sync` with the installed CLI and wait for it. Resolves with
 * the exit code, or null when the child could not start or timed out.
 */
export function runInstalledSync(cliPath: string, timeoutMs = CHILD_TIMEOUT_MS): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code: number | null) => { if (!settled) { settled = true; resolve(code); } };
    let child;
    try {
      child = spawn(process.execPath, [cliPath, 'sync'], { env: process.env, stdio: ['ignore', 'ignore', 'inherit'] });
    } catch {
      done(null);
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } done(null); }, timeoutMs);
    timer.unref?.();
    child.on('error', () => { clearTimeout(timer); done(null); });
    child.on('exit', (code) => { clearTimeout(timer); done(code); });
  });
}
