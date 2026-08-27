/**
 * Tests for the filesystem advisory lock used to serialize index
 * mutations. Properties under test:
 *   - mutual exclusion (second acquire returns null)
 *   - release lets a follow-up acquire succeed
 *   - stale-lock takeover works when the recorded PID is dead
 *   - stale-lock takeover does NOT happen if the PID is alive
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { acquireIndexLock, _forceClearIndexLock } from './index-lock.js';

let tmp: string;
const ORIG_DATA_DIR = process.env.CHAT_RECALL_DATA_DIR;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cr-lock-'));
  process.env.CHAT_RECALL_DATA_DIR = join(tmp, 'data');
  // Ensure a fresh index dir exists so the lock has somewhere to live.
  mkdirSync(join(tmp, 'data', 'index'), { recursive: true });
  _forceClearIndexLock();
});

afterEach(() => {
  if (ORIG_DATA_DIR !== undefined) process.env.CHAT_RECALL_DATA_DIR = ORIG_DATA_DIR;
  else delete process.env.CHAT_RECALL_DATA_DIR;
  _forceClearIndexLock();
  rmSync(tmp, { recursive: true, force: true });
});

describe('index-lock', () => {
  test('first acquire succeeds; second concurrent acquire returns null', () => {
    const a = acquireIndexLock({ kind: 'test-a' });
    expect(a).not.toBeNull();
    const b = acquireIndexLock({ kind: 'test-b' });
    expect(b).toBeNull();
    a!.release();
  });

  test('release allows the next acquire to succeed', () => {
    const a = acquireIndexLock({ kind: 'test-a' });
    expect(a).not.toBeNull();
    a!.release();
    const b = acquireIndexLock({ kind: 'test-b' });
    expect(b).not.toBeNull();
    b!.release();
  });

  test('release is idempotent', () => {
    const a = acquireIndexLock({ kind: 'test' });
    expect(a).not.toBeNull();
    a!.release();
    expect(() => a!.release()).not.toThrow();
  });

  test('stale lock from a dead PID is taken over after the staleness window', () => {
    const lockPath = join(tmp, 'data', 'index', '.compact.lock');
    // A GUARANTEED-ALIVE PID, and it must not be 1. PID 1 is init only on a
    // POSIX system; on Windows there is no such process, so `process.kill(1, 0)`
    // threw ESRCH, the holder was judged dead, and the lock WAS stolen — this
    // assertion failed on Windows alone. This process is alive by definition on
    // every platform, and nothing in the lock treats its own pid specially.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, kind: 'fake', startedAt: 0 }));
    // Backdate it so it qualifies on age alone.
    const old = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(lockPath, old, old);
    // The holder is alive — must NOT take it over.
    const stillBusy = acquireIndexLock({ kind: 'taker', staleAfterMs: 1_000 });
    expect(stillBusy).toBeNull();

    // Replace with a guaranteed-dead PID. Pick a synthetic large value
    // we can be confident isn't running on this machine.
    const deadPid = 2 ** 22;  // way above any realistic pid_max
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, kind: 'fake', startedAt: 0 }));
    utimesSync(lockPath, old, old);
    const taken = acquireIndexLock({ kind: 'taker', staleAfterMs: 1_000 });
    expect(taken).not.toBeNull();
    expect(taken!.holder.kind).toBe('taker');
    taken!.release();
  });

  test('non-stale lock from a dead PID is NOT taken over until window elapses', () => {
    const lockPath = join(tmp, 'data', 'index', '.compact.lock');
    const deadPid = 2 ** 22;
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, kind: 'fake', startedAt: Date.now() }));
    // Lock file is fresh — even though PID is dead, the staleness window
    // hasn't elapsed; we must not steal.
    const r = acquireIndexLock({ kind: 'taker', staleAfterMs: 60 * 60_000 });
    expect(r).toBeNull();
    // The original lock file is still there.
    expect(existsSync(lockPath)).toBe(true);
  });

  test('release does not unlink a lock that has been taken over', () => {
    // Acquire, then simulate someone else stealing by overwriting.
    const a = acquireIndexLock({ kind: 'first' });
    expect(a).not.toBeNull();
    const lockPath = join(tmp, 'data', 'index', '.compact.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, kind: 'second', startedAt: Date.now() + 1 }));
    // Original holder releases — must NOT delete the file (would bump
    // out the new holder).
    a!.release();
    expect(existsSync(lockPath)).toBe(true);
  });
});
