import { describe, it, expect } from 'vitest';
import { isOverMemoryLimit } from './memory-guard.js';

/**
 * The walk stops at the memory bound instead of letting the unit be killed.
 *
 * Measured on 2026-11-13: a file-change sync took the cgroup from 578 MB to
 * 1524 MB of anon in six seconds (one large opencode export plus the buffers of
 * the sessions before it), and systemd killed the unit for the peak. The walk
 * loop in sync-client.ts now reads `usedMb()` before each session and breaks,
 * and calls `releaseMemory()` after each session it builds.
 *
 * This mirrors that loop. `retained` is the part of a session's pages the
 * release does not give back — V8 keeps committed pages, and the page cache of
 * the files the session read stays until the kernel takes it. With `retained`
 * at the full per-session cost the loop reaches the bound and pauses; with it at
 * zero the loop finishes, which is what the release is for.
 */
function runWalk(sessions: number, startUsed: number, perSession: number, retained: number, limitMb: number) {
  let used = startUsed;
  let built = 0;
  let released = 0;
  let paused = false;
  for (let i = 0; i < sessions; i++) {
    if (isOverMemoryLimit(used, limitMb)) { paused = true; break; }
    used += perSession;
    built++;
    used = used - (perSession - retained);   // releaseMemory() returns the rest
    released++;
  }
  return { built, released, paused, used };
}

describe('walk memory bound', () => {
  it('stops the walk at the bound when the pages stay', () => {
    // 300 MB start, 40 MB per session, nothing returned, 512 MB bound:
    // the checks run at 300, 340, 380, 420, 460, 500 and the next is 540.
    const r = runWalk(50, 300, 40, 40, 512);
    expect(r.built).toBe(6);
    expect(r.paused).toBe(true);
    expect(r.released).toBe(6);
  });

  it('does no work when the walk starts over the bound', () => {
    const r = runWalk(50, 700, 40, 40, 512);
    expect(r.built).toBe(0);
    expect(r.paused).toBe(true);
  });

  it('finishes a small walk under the bound', () => {
    const r = runWalk(4, 200, 20, 20, 512);
    expect(r.built).toBe(4);
    expect(r.paused).toBe(false);
  });

  it('walks the whole list when every session gives its pages back', () => {
    const r = runWalk(50, 300, 40, 0, 512);
    expect(r.built).toBe(50);
    expect(r.paused).toBe(false);
  });

  it('releases the pages of every session it builds', () => {
    const r = runWalk(10, 100, 30, 10, 512);
    expect(r.released).toBe(r.built);
  });
});
