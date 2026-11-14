/**
 * The tombstone guard of the sync route (issue #24). On 2026-11-12 one
 * collector sent 11,977 tombstones, and the server answered 200 to every later
 * push of those sessions without storing them.
 */
import { describe, test, expect } from 'vitest';
import {
  tombstoneBatchTooLarge, tombstoneMaxShare, splitTombstoned, TombstoneBatchRefused,
  DEFAULT_TOMBSTONE_MAX_SHARE, TOMBSTONE_GUARD_MIN_BATCH,
} from './tombstone-guard.js';

describe('tombstoneBatchTooLarge', () => {
  test('the batch of 2026-11-12 is refused', () => {
    expect(tombstoneBatchTooLarge({ batch: 11_977, stored: 12_199 })).toBe(true);
  });

  test('a batch above 5 percent of the stored sessions is refused', () => {
    expect(tombstoneBatchTooLarge({ batch: 101, stored: 2000 })).toBe(true);
  });

  test('a batch of 5 percent or less is accepted', () => {
    expect(tombstoneBatchTooLarge({ batch: 100, stored: 2000 })).toBe(false);
  });

  test('a batch of 50 sessions or fewer is accepted whatever the share', () => {
    expect(tombstoneBatchTooLarge({ batch: TOMBSTONE_GUARD_MIN_BATCH, stored: 60 })).toBe(false);
    expect(tombstoneBatchTooLarge({ batch: 3, stored: 0 })).toBe(false);
  });

  test('a tenant with no stored sessions refuses a batch above 50', () => {
    expect(tombstoneBatchTooLarge({ batch: 51, stored: 0 })).toBe(true);
  });

  test('the share comes from the variable', () => {
    expect(tombstoneBatchTooLarge({ batch: 200, stored: 2000, maxShare: 0.2 })).toBe(false);
    expect(tombstoneBatchTooLarge({ batch: 201, stored: 2000, maxShare: 0.1 })).toBe(true);
  });
});

describe('tombstoneMaxShare', () => {
  test('the default is 5 percent', () => {
    expect(tombstoneMaxShare({})).toBe(DEFAULT_TOMBSTONE_MAX_SHARE);
    expect(DEFAULT_TOMBSTONE_MAX_SHARE).toBe(0.05);
  });
  test('a number from 0 to 1 is honoured', () => {
    expect(tombstoneMaxShare({ CHAT_RECALL_TOMBSTONE_MAX_SHARE: '0.25' })).toBe(0.25);
  });
  test('a value that does not parse, or is out of range, keeps the default', () => {
    for (const v of ['', 'abc', '-1', '1.5', 'NaN']) {
      expect(tombstoneMaxShare({ CHAT_RECALL_TOMBSTONE_MAX_SHARE: v })).toBe(DEFAULT_TOMBSTONE_MAX_SHARE);
    }
  });
});

describe('TombstoneBatchRefused', () => {
  test('carries the answer code and the counts', () => {
    const err = new TombstoneBatchRefused(11_977, 12_199);
    expect(err.code).toBe('tombstone_batch_too_large');
    expect(err.batch).toBe(11_977);
    expect(err.stored).toBe(12_199);
  });
});

describe('splitTombstoned', () => {
  const at = new Map([['gone', 1_000], ['mistake', 1_000]]);

  test('a tombstoned session with a newer mtime is lifted and not dead', () => {
    const { dead, lift } = splitTombstoned([{ session_id: 'mistake', mtime: 2_000 }], at);
    expect([...dead]).toEqual([]);
    expect(lift).toEqual(['mistake']);
  });

  test('a tombstoned session with the same or an older mtime stays dead', () => {
    const { dead, lift } = splitTombstoned([
      { session_id: 'gone', mtime: 1_000 },
      { session_id: 'mistake', mtime: 500 },
    ], at);
    expect([...dead].sort()).toEqual(['gone', 'mistake']);
    expect(lift).toEqual([]);
  });

  test('a session without a tombstone is neither dead nor lifted', () => {
    const { dead, lift } = splitTombstoned([{ session_id: 'live', mtime: 5 }], at);
    expect(dead.size).toBe(0);
    expect(lift).toEqual([]);
  });

  test('a session that one push sends twice, old and new, stays dead', () => {
    const { dead, lift } = splitTombstoned([
      { session_id: 'mistake', mtime: 2_000 },
      { session_id: 'mistake', mtime: 10 },
    ], at);
    expect([...dead]).toEqual(['mistake']);
    expect(lift).toEqual([]);
  });

  test('an mtime that is missing counts as 0 and stays dead', () => {
    const { dead } = splitTombstoned([{ session_id: 'gone' }], at);
    expect([...dead]).toEqual(['gone']);
  });
});
