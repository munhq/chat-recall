/**
 * Filesystem advisory lock for index-mutating operations.
 *
 * Two writers contending on a LanceDB index can produce wedged versions
 * (a partial compaction colliding with an in-flight insert). We don't
 * actually use OS file locking — we use an O_EXCL marker file with a
 * PID + start-time payload. That's portable, no native deps, and lets
 * us detect a stale lock from a crashed indexer.
 *
 * Pattern:
 *
 *   const lock = await acquireIndexLock('compact', { staleAfterMs: 10*60_000 });
 *   if (!lock) return;          // someone else holds it; bail
 *   try { ...write... } finally { lock.release(); }
 *
 * `staleAfterMs`: if a lock file exists but is older than this AND the
 * PID inside it is no longer alive, take it over. Default 10 minutes.
 *
 * Reader-side: tasks that ONLY read the index don't take this lock.
 * The lock guards mutations (compaction, schema change, full reindex).
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

function stealStaleLock(lockPath: string, staleAfterMs: number): boolean {
  try {
    const s = statSync(lockPath);
    const age = Date.now() - s.mtimeMs;
    if (age < staleAfterMs) return false;

    let payload: { pid: number; kind: string; startedAt: number };
    try { payload = JSON.parse(readFileSync(lockPath, 'utf-8')); }
    catch { rmSync(lockPath, { force: true }); return true; }  // corrupt → take over

    if (isProcessAlive(payload.pid)) return false;

    // Stale + dead PID — take it over.
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
