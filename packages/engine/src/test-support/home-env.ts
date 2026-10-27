/**
 * Point `os.homedir()` at a sandbox, on every platform.
 *
 * ── The bug this ends ─────────────────────────────────────────────────────
 * Around thirty test files redirected the home directory with
 *
 *     process.env.HOME = tmpDir;
 *
 * which is a POSIX-only instruction. `os.homedir()` reads `$HOME` on Linux and
 * macOS, and `%USERPROFILE%` on Windows — so on Windows every one of those tests
 * silently kept reading the REAL home directory of whoever ran them. On CI that
 * meant 31 test files failing against `C:\Users\runneradmin\.claude`; on a
 * contributor's machine it means a test suite that reads, and in a few cases
 * writes, their own `~/.claude`, `~/.gemini` and `~/.codex`.
 *
 * The product itself was always right: it calls `os.homedir()`, which resolves
 * correctly on all three platforms. Only the tests assumed one of them.
 *
 * Use `useHomeDir()` to point it somewhere, and the snapshot pair to put it
 * back. Both variables are set and restored together, because a test that sets
 * one and restores the other leaks a sandbox path into the rest of the run.
 */

import { join } from 'path';

export interface HomeEnvSnapshot {
  HOME?: string;
  USERPROFILE?: string;
  CHAT_RECALL_HERMES_HOME?: string;
  CHAT_RECALL_PI_HOME?: string;
}

/**
 * Make `os.homedir()` return `dir` on Linux, macOS and Windows, and point the
 * Hermes home at `dir/.hermes`. Hermes's default home is not under the home
 * directory on Windows (%LOCALAPPDATA%\hermes), so it needs its own override.
 */
export function useHomeDir(dir: string): void {
  process.env.HOME = dir;        // POSIX: what uv_os_homedir reads
  process.env.USERPROFILE = dir; // Windows: what uv_os_homedir reads
  process.env.CHAT_RECALL_HERMES_HOME = join(dir, '.hermes');
  process.env.CHAT_RECALL_PI_HOME = join(dir, '.pi', 'agent');
}

/** Capture the home variables so a test can restore exactly what it found. */
export function homeEnvSnapshot(): HomeEnvSnapshot {
  return {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CHAT_RECALL_HERMES_HOME: process.env.CHAT_RECALL_HERMES_HOME,
    CHAT_RECALL_PI_HOME: process.env.CHAT_RECALL_PI_HOME,
  };
}

/**
 * Put both variables back — DELETING the ones that were absent.
 *
 * `process.env.HOME = undefined` assigns the four-character string "undefined",
 * so a naive restore leaves a home directory literally named that. On Windows
 * `HOME` is usually unset, which is exactly when that happens.
 */
export function restoreHomeEnv(snapshot: HomeEnvSnapshot): void {
  if (snapshot.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = snapshot.HOME;
  if (snapshot.USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = snapshot.USERPROFILE;
  if (snapshot.CHAT_RECALL_HERMES_HOME === undefined) delete process.env.CHAT_RECALL_HERMES_HOME;
  else process.env.CHAT_RECALL_HERMES_HOME = snapshot.CHAT_RECALL_HERMES_HOME;
  if (snapshot.CHAT_RECALL_PI_HOME === undefined) delete process.env.CHAT_RECALL_PI_HOME;
  else process.env.CHAT_RECALL_PI_HOME = snapshot.CHAT_RECALL_PI_HOME;
}
