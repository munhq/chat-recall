/**
 * The watch daemon notices when its own code changes, and comes back on the new
 * code instead of running the old one indefinitely.
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * A long-lived daemon holds whatever bundle it started with. Node has already
 * parsed it; replacing the file on disk changes nothing about the running
 * process. So a fix can be committed, built, installed and still not be in
 * effect — with no signal anywhere that the process is stale.
 *
 * That has caused three separate incidents in this codebase:
 *   - the trufflehog /tmp leak kept accreting 34MB per sync for a day after the
 *     fix shipped, because the daemon predated it;
 *   - the cross-home union landed and the collector kept reading one home for
 *     another day, stranding 694 records of a live session;
 *   - the ledger ack fix, where the daemon had been restarted just BEFORE the
 *     commit and so needed restarting a third time.
 *
 * `auto-update.ts` already handles the published-release path (fetch, verify,
 * `npm i -g`, restart) which is what real customers hit. This covers the other
 * case: the bundle changing underneath a running daemon — a linked dev build, a
 * manual `npm i -g`, or a package manager upgrading the CLI without touching the
 * service.
 *
 * ── How it comes back matters more than how it notices ───────────────────
 * Exiting is only safe when something will start us again, and that differs:
 *
 *   systemd   Restart=on-failure  → must exit NON-ZERO (a clean exit stays down)
 *   launchd   KeepAlive=true      → restarts on any exit
 *   schtasks  /sc onlogon         → NEVER restarts; exiting means down until the
 *                                   next logon, which is worse than stale code,
 *                                   so we re-exec ourselves instead
 *   foreground (no supervisor)    → exiting would just kill the user's process;
 *                                   warn loudly and keep running
 *
 * Getting that wrong turns a staleness fix into an outage, which is why the exit
 * code is 75 (EX_TEMPFAIL) rather than 0: it satisfies the `on-failure` policy
 * that is already installed on every existing machine, so this works without
 * re-rendering anyone's unit file.
 */

import { spawn } from 'child_process';
import { statSync } from 'fs';

/** Non-zero so systemd's `Restart=on-failure` picks it up. EX_TEMPFAIL. */
export const EXIT_CODE_CODE_CHANGED = 75;

export interface CodeFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Identity of the bundle we are running. The build produces a single bundled
 * `watch.js` (engine included), so one stat answers "did my code change?" —
 * no need to walk node_modules.
 */
export function codeFingerprint(entry = process.argv[1]): CodeFingerprint | null {
  if (!entry) return null;
  try {
    const st = statSync(entry);
    return { path: entry, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;   // running from a pipe/eval — nothing to watch
  }
}

export function sameFingerprint(a: CodeFingerprint | null, b: CodeFingerprint | null): boolean {
  if (!a || !b) return true;              // unknown ⇒ don't act
  return a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

export type Supervisor = 'systemd' | 'launchd' | 'windows-task' | 'none';

/**
 * Who, if anyone, will restart us. systemd exports INVOCATION_ID (and
 * JOURNAL_STREAM) to its units; launchd exports XPC_SERVICE_NAME. Neither is
 * something a normal shell has, so their presence is a reliable "I am
 * supervised" signal.
 */
export function detectSupervisor(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Supervisor {
  if (env.INVOCATION_ID || env.JOURNAL_STREAM) return 'systemd';
  if (env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== '0') return 'launchd';
  if (platform === 'win32') return 'windows-task';
  return 'none';
}

export type RestartAction =
  | { kind: 'exit'; code: number }        // a supervisor will bring us back
  | { kind: 'reexec' }                    // nothing will; start a replacement
  | { kind: 'warn' };                     // foreground — the user decides

/** What to do about a detected code change, given who is supervising. */
export function restartActionFor(sup: Supervisor): RestartAction {
  switch (sup) {
    case 'systemd':                                  // Restart=on-failure
    case 'launchd':                                  // KeepAlive
      return { kind: 'exit', code: EXIT_CODE_CODE_CHANGED };
    case 'windows-task':                             // onlogon — nothing restarts us
      return { kind: 'reexec' };
    default:
      return { kind: 'warn' };
  }
}

/** Detach a replacement process running the NEW bundle, then let the caller exit. */
function reexec(log: (m: string) => void): void {
  const args = process.argv.slice(1);
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    log(`[self-restart] launched a replacement process (pid ${child.pid}) on the new bundle`);
  } catch (err) {
    log(`[self-restart] could not re-exec (${err instanceof Error ? err.message : err}) — staying on the OLD code`);
  }
}

export interface SelfRestartOptions {
  /** Fingerprint captured at boot. */
  boot: CodeFingerprint | null;
  log?: (m: string) => void;
  /** Test seam. */
  now?: () => CodeFingerprint | null;
  supervisor?: Supervisor;
  /** Test seam — defaults to actually exiting. */
  exit?: (code: number) => void;
}

/**
 * Check whether our bundle changed and act on it. Returns true when a restart
 * was triggered (so callers can stop scheduling work).
 *
 * Opt out with CHAT_RECALL_SELF_RESTART=0 — the escape hatch for anyone
 * debugging with a hot-reloading build who does not want the process bouncing.
 */
export function checkSelfRestart(opts: SelfRestartOptions): boolean {
  const log = opts.log ?? ((m: string) => console.error(m));
  if ((process.env.CHAT_RECALL_SELF_RESTART || '').trim() === '0') return false;

  const current = (opts.now ?? (() => codeFingerprint()))();
  if (sameFingerprint(opts.boot, current)) return false;

  const sup = opts.supervisor ?? detectSupervisor();
  const action = restartActionFor(sup);
  log(
    `[self-restart] my own bundle changed on disk (${opts.boot?.size ?? '?'} → ${current?.size ?? '?'} bytes). ` +
    `Running code is now stale; supervisor=${sup}, action=${action.kind}.`,
  );

  if (action.kind === 'warn') {
    log('[self-restart] no supervisor would restart me, so I am STAYING UP on the old code — restart manually to pick up the change.');
    return false;
  }
  if (action.kind === 'reexec') reexec(log);

  const exit = opts.exit ?? ((code: number) => process.exit(code));
  exit(action.kind === 'exit' ? action.code : 0);
  return true;
}
