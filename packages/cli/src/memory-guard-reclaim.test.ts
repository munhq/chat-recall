import { describe, it, expect } from 'vitest';

import { shouldReclaim, DEFAULT_RECLAIM_FILE_MB } from './memory-guard.js';

/**
 * The resident tick returns the page cache only above the ceiling.
 *
 * Measured on 2026-11-13: the watch unit held 1.5 GiB of file pages in
 * `memory.current` while the live heap was 91 MB (report at 14:16:20), and a
 * second report at 842 MB of peak still showed a 139 MB heap. The pass reclaims
 * at its own boundaries, but the pages keep growing between them, so a tick
 * every 30 s asks `shouldReclaim` and returns the surplus.
 *
 * A missing reading means there is no cgroup to write, and that must not
 * trigger a write or an error.
 */
describe('shouldReclaim', () => {
  it('returns the page cache above the default ceiling', () => {
    expect(shouldReclaim(DEFAULT_RECLAIM_FILE_MB + 1)).toBe(true);
  });

  it('leaves the page cache at or below the ceiling', () => {
    expect(shouldReclaim(DEFAULT_RECLAIM_FILE_MB)).toBe(false);
    expect(shouldReclaim(12)).toBe(false);
    expect(shouldReclaim(0)).toBe(false);
  });

  it('does nothing without a reading', () => {
    expect(shouldReclaim(null)).toBe(false);
  });

  it('honours a custom ceiling', () => {
    expect(shouldReclaim(40, 32)).toBe(true);
    expect(shouldReclaim(31, 32)).toBe(false);
  });
});
