/**
 * Cross-process single-writer lock for the collector.
 *
 * Its primary use today is the SYNC lock: every background sync (the watch
 * daemon, per-session MCP ticks, a manual `chat-recall sync`) serializes on one
 * lock so exactly one writer advances the sync ledger at a time. We don't use OS
 * file locking — an O_EXCL marker file with a PID + start-time payload. That's
 * portable, no native deps, and lets us detect a stale lock from a crashed
 * holder.
 *
 * Pattern:
 *
 *   const lock = acquireIndexLock({ kind: 'sync-incremental', staleAfterMs: 10*60_000 });
 *   if (!lock) return;          // someone else holds it; bail this tick
 *   try { ...write... } finally { lock.release(); }
 *
 * `staleAfterMs`: if a lock file exists but is older than this AND the PID
 * inside it is no longer alive, take it over. Default 10 minutes.
 *
 * (The name "index" and the `.compact.lock` marker are historical — this used
 * to guard a local LanceDB index's compaction. The thin collector keeps no
 * local index; the same primitive now guards the sync writer.)
 */

import { existsSync, mkdirSync, openSync, writeFileSync, readFileSync, rmSync, statSync, closeSync } from 'fs';
import { dirname, join } from 'path';
import { getIndexDir } from './paths.js';

export interface IndexLock {
  /** Drop the lock. Idempotent — safe to call from a `finally`. */
  release(): void;
  /** Lock holder identifier — what was written to the lock file. */
  readonly holder: { pid: number; kind: string; startedAt: number };
}

interface AcquireOpts {
  /** Diagnostic label that goes into the lock file payload. */
  kind: string;
  /** Treat a lock as stale if older than this AND its PID is dead. Default 10 min. */
  staleAfterMs?: number;
}

/**
 * Try to grab the index lock. Returns `null` if another live process
 * holds it (no waiting — caller decides whether to retry, defer, or
 * skip). If the lock file is from a dead PID and older than the
 * staleness window, we take it over.
 */
export function acquireIndexLock(opts: AcquireOpts): IndexLock | null {
  const lockPath = lockFilePath();
  mkdirSync(dirname(lockPath), { recursive: true });

  // 1. Try to detect + steal a stale lock first.
  if (existsSync(lockPath)) {
    if (!stealStaleLock(lockPath, opts.staleAfterMs ?? 10 * 60_000)) {
      return null;  // someone else has it; bail
    }
  }

  // 2. O_EXCL create — atomic against other contenders racing us.
  let fd: number;
  try {
    // 'wx' = write, fail if exists (O_EXCL).
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    // Another process beat us between the staleness check and now.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
  const holder = { pid: process.pid, kind: opts.kind, startedAt: Date.now() };
  try {
    writeFileSync(fd, JSON.stringify(holder));
  } finally {
    closeSync(fd);
  }

  let released = false;
  return {
    holder,
    release() {
      if (released) return;
      released = true;
      // Verify we're still the holder before unlinking — defensive against
      // a stale-lock-takeover happening underneath us if our process
      // hung past the staleness window.
      try {
        const current = JSON.parse(readFileSync(lockPath, 'utf-8')) as typeof holder;
        if (current.pid !== holder.pid || current.startedAt !== holder.startedAt) return;
      } catch { /* file gone — nothing to release */ return; }
      try { rmSync(lockPath, { force: true }); } catch { /* swallow */ }
    },
  };
}

function lockFilePath(): string {
  return join(getIndexDir(), '.compact.lock');
}

/** Grace before stealing from a DEAD holder. Short on purpose: a dead PID
 *  cannot still be working — the only thing the grace protects against is
 *  PID-reuse racing right at creation. (MCP tick processes get killed by
 *  their session's lifecycle mid-sync constantly; making everyone else wait
 *  the full stale window behind a corpse starved syncs for 10-min bites.) */
const DEAD_HOLDER_GRACE_MS = 30_000;

function stealStaleLock(lockPath: string, staleAfterMs: number): boolean {
  try {
    const s = statSync(lockPath);
    const age = Date.now() - s.mtimeMs;

    let payload: { pid: number; kind: string; startedAt: number };
    try { payload = JSON.parse(readFileSync(lockPath, 'utf-8')); }
    catch { rmSync(lockPath, { force: true }); return true; }  // corrupt → take over

    if (isProcessAlive(payload.pid)) {
      // A LIVE holder is only preempted after the full stale window — it may
      // legitimately be grinding a huge transcript.
      if (age < staleAfterMs) return false;
      return false; // live holder never stolen; it owns the lock until it exits
    }

    // Dead holder: steal after a short grace. Waiting the full stale window
    // behind a process that can never finish is pure starvation.
    if (age < DEAD_HOLDER_GRACE_MS) return false;
    rmSync(lockPath, { force: true });
    return true;
  } catch {
    // File vanished between exists() and statSync — race; treat as available.
    return true;
  }
}

/** Liveness check that doesn't require any tools. Sends signal 0; rejects on ESRCH. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';  // exists but not ours = alive
  }
}

/** Test-only escape hatch — drop any lingering lock between tests. */
export function _forceClearIndexLock(): void {
  const path = lockFilePath();
  try { rmSync(path, { force: true }); } catch { /* ignore */ }
}
