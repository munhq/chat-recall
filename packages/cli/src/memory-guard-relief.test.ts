/**
 * A walk that reads transcripts fills the page cache of the cgroup faster than
 * the resident tick returns it. The walk releases the heap and the file pages
 * before it decides to pause, and decides on the number after.
 */
import { describe, it, expect } from 'vitest';
import { usedAfterRelief, shouldPause, type MemoryBudget } from './memory-guard.js';

const budget: MemoryBudget = { baselineMb: 400, growthMb: 800, hardMb: 1500 };

describe('usedAfterRelief', () => {
  it('collects the heap and reclaims the file pages, in that order, then measures', () => {
    const calls: string[] = [];
    const used = usedAfterRelief(() => { calls.push('measure'); return 600; }, () => { calls.push('gc'); return true; }, () => { calls.push('reclaim'); return true; });
    expect(calls).toEqual(['gc', 'reclaim', 'measure']);
    expect(used).toBe(600);
  });

  it('a walk at 1,338 MB with 700 MB of file pages is not paused after the release', () => {
    let cache = 700;
    const used = usedAfterRelief(() => 638 + cache, () => true, () => { cache = 64; return true; });
    expect(shouldPause(1338, budget, 168)).toBe(true);
    expect(shouldPause(used, budget, 168)).toBe(false);
  });

  it('a walk whose memory is anonymous is still paused after the release', () => {
    const used = usedAfterRelief(() => 1450, () => true, () => false);
    expect(shouldPause(used, { ...budget, growthMb: 800 }, 168)).toBe(true);
  });
});
