import { describe, it, expect } from 'vitest';
import { shouldPause, startBudget, type MemoryBudget } from './memory-guard.js';

/**
 * The walk pauses on what it adds, and it builds at least one session per tick.
 *
 * Measured on 2026-11-13 on 0.7.44: the idle daemon held 535 to 580 MB and the
 * bound was 512 MB, so the check before the first session paused every walk
 * with zero builds. The log repeated `walk paused at the memory bound
 * (used=584MB) after 1 of 15 session(s)` every 13 seconds, the sessions never
 * shipped through the walk, and the daemon used 73 to 98 percent of a core on
 * the listing and the release of each tick.
 *
 * `runWalk` is the loop of sync-client.ts with `shouldPause` as its check.
 * `retained` is the part of a session's pages that the release does not give
 * back.
 */
function runWalk(sessions: number, startUsed: number, perSession: number, retained: number, budget: MemoryBudget) {
  let used = startUsed;
  let built = 0;
  let paused = false;
  for (let i = 0; i < sessions; i++) {
    if (shouldPause(used, budget, built)) { paused = true; break; }
    used += perSession;
    built++;
    used -= perSession - retained;
  }
  return { built, paused, used };
}

const env = {};

describe('walk memory bound', () => {
  it('builds sessions when the daemon idles above the old 512 MB bound', () => {
    const budget = startBudget(584, env);
    const r = runWalk(15, 584, 20, 0, budget);
    expect(r.built).toBe(15);
    expect(r.paused).toBe(false);
  });

  it('builds one session even when the first check is over the growth bound', () => {
    const budget = { baselineMb: 500, growthMb: 256, hardMb: 896 };
    const r = runWalk(50, 800, 40, 40, budget);
    expect(r.built).toBeGreaterThanOrEqual(1);
  });

  it('stops after the walk adds the growth bound', () => {
    const budget = { baselineMb: 560, growthMb: 256, hardMb: 2048 };
    const r = runWalk(50, 560, 40, 40, budget);
    // Checks run at 560, 600, 640, 680, 720 and 760; the next is 800, which is 240 above the start,
    // and 840 is 280 above it.
    expect(r.paused).toBe(true);
    expect(r.used - budget.baselineMb).toBeGreaterThanOrEqual(256);
    expect(r.used - 40 - budget.baselineMb).toBeLessThan(256);
  });

  it('stops at the absolute bound when the walk starts high', () => {
    const budget = { baselineMb: 880, growthMb: 256, hardMb: 896 };
    const r = runWalk(50, 880, 20, 20, budget);
    expect(r.built).toBe(1);
    expect(r.paused).toBe(true);
  });

  it('does not pause before the first session', () => {
    expect(shouldPause(5000, { baselineMb: 100, growthMb: 256, hardMb: 896 }, 0)).toBe(false);
  });

  it('reads the growth bound from the environment', () => {
    expect(startBudget(300, { CHAT_RECALL_WATCH_GROWTH_MAX_MB: '128' }).growthMb).toBe(128);
    expect(startBudget(300, { CHAT_RECALL_WATCH_GROWTH_MAX_MB: 'x' }).growthMb).toBe(256);
  });
});
