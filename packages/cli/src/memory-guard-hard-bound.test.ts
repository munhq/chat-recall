import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HARD_MAX_MB,
  HARD_BOUND_MIN_UPTIME_MS,
  HARD_BOUND_TICKS,
  hardMaxMb,
  shouldRestartForMemory,
} from './memory-guard.js';

// The collector's last-resort bound (issue #16). `memory.reclaim` returns file
// pages only, so the anonymous memory a long-lived isolate committed stays. Two
// ticks above the bound in a row end the process, and `Restart=always` starts a
// clean one.

const LONG = HARD_BOUND_MIN_UPTIME_MS + 1;

describe('hardMaxMb — the hard bound of the collector', () => {
  it('defaults to 720 MB', () => {
    expect(hardMaxMb({} as NodeJS.ProcessEnv)).toBe(DEFAULT_HARD_MAX_MB);
    expect(DEFAULT_HARD_MAX_MB).toBe(720);
  });

  it('takes CHAT_RECALL_WATCH_HARD_MAX_MB', () => {
    expect(hardMaxMb({ CHAT_RECALL_WATCH_HARD_MAX_MB: '500' } as NodeJS.ProcessEnv)).toBe(500);
  });

  it('falls back on a value that is not a positive number', () => {
    expect(hardMaxMb({ CHAT_RECALL_WATCH_HARD_MAX_MB: 'lots' } as NodeJS.ProcessEnv)).toBe(DEFAULT_HARD_MAX_MB);
    expect(hardMaxMb({ CHAT_RECALL_WATCH_HARD_MAX_MB: '0' } as NodeJS.ProcessEnv)).toBe(DEFAULT_HARD_MAX_MB);
  });
});

describe('shouldRestartForMemory — when the collector ends itself', () => {
  it('stays while the memory is below the bound', () => {
    expect(shouldRestartForMemory(300, 720, 5, LONG)).toBe(false);
  });

  it('does not end a process that just crossed the bound once', () => {
    expect(shouldRestartForMemory(800, 720, 1, LONG)).toBe(false);
  });

  it('ends a process that stays above the bound for two ticks', () => {
    expect(shouldRestartForMemory(800, 720, HARD_BOUND_TICKS, LONG)).toBe(true);
  });

  it('resets the count when the memory comes back down', () => {
    // The caller resets on a single tick below the bound, so a process that
    // peaks and returns is never ended.
    expect(shouldRestartForMemory(300, 720, 1, LONG)).toBe(false);
  });

  it('is exact at the bound: 720 is not above 720', () => {
    expect(shouldRestartForMemory(720, 720, HARD_BOUND_TICKS, LONG)).toBe(false);
    expect(shouldRestartForMemory(721, 720, HARD_BOUND_TICKS, LONG)).toBe(true);
  });

  it('never ends a process that is younger than five minutes', () => {
    // A startup pass costs memory; ending it there would be a restart loop.
    expect(shouldRestartForMemory(900, 720, 9, HARD_BOUND_MIN_UPTIME_MS - 1)).toBe(false);
    expect(shouldRestartForMemory(900, 720, 9, HARD_BOUND_MIN_UPTIME_MS)).toBe(true);
  });

  it('is off when the bound is not positive', () => {
    expect(shouldRestartForMemory(900, 0, 9, LONG)).toBe(false);
  });
});
