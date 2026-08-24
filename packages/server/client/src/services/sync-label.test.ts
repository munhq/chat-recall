/**
 * Two shipped bugs, both from reading the wrong number:
 *
 *   1. "syncing 99%" forever on a fully synced install — a percentage clamped
 *      to 99 that could only ever bind in the one case that is not syncing.
 *   2. "1h behind" and a red "nothing is arriving, go debug your machine"
 *      banner on a healthy install that had simply been idle — both read
 *      newestSessionAgeMs (how old your newest TRANSCRIPT is) as though it were
 *      sync health (how long since the COLLECTOR reported).
 *
 * Every case below is written to fail against the original logic. The point of
 * the file is that those two numbers are not interchangeable.
 */
import { describe, test, expect } from 'vitest';
import {
  syncLabel, syncTone, syncPct, staleSyncAlert, ago, STALE_SYNC_MS, SYNC_OK_MS,
} from './sync-label';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('the percentage is real, with no clamp', () => {
  test('THE BUG: a finished walk is not reported as 99%', () => {
    // floor(100 * done / total) hits 100 only when done === total, so the old
    // Math.min(99, …) could never bind for a walk actually in flight. All it did
    // was turn a finished-but-unflagged walk into a permanent 99.
    expect(syncPct({ done: 15_736, total: 15_736 })).toBe(100);
  });

  test('mid-walk values are floored, not rounded up', () => {
    expect(syncPct({ done: 6_200, total: 15_736 })).toBe(39);
    // 99.99% must read 99, not 100: the walk has not finished.
    expect(syncPct({ done: 9_999, total: 10_000 })).toBe(99);
  });

  test('a zero denominator does not produce NaN in the UI', () => {
    expect(syncPct({ done: 0, total: 0 })).toBe(0);
  });
});

describe('the badge reports the SYNC, not the data', () => {
  test('THE BUG: a synced install that has been idle for an hour', () => {
    // Synced 90s ago, newest transcript an hour old because nobody has opened an
    // AI tool. Nothing is behind — there is nothing to fetch.
    const label = syncLabel({ lastSyncAgeMs: 90 * 1000, newestSessionAgeMs: HOUR });
    expect(label).toBe('synced 2m ago');
    expect(label).not.toContain('behind');
  });

  test('an in-flight walk outranks everything else', () => {
    // During a first sync the session age is large and says nothing useful.
    expect(syncLabel({
      progress: { done: 6_200, total: 15_736 },
      lastSyncAgeMs: 2_000,
      newestSessionAgeMs: 40 * DAY,
    })).toBe('syncing 39%');
  });

  test('a walk with a zero total is not treated as in flight', () => {
    expect(syncLabel({ progress: { done: 0, total: 0 }, lastSyncAgeMs: 30_000 }))
      .toBe('synced just now');
  });

  test('sync ages read naturally across the scale', () => {
    expect(syncLabel({ lastSyncAgeMs: 5_000 })).toBe('synced just now');
    expect(syncLabel({ lastSyncAgeMs: 12 * MIN })).toBe('synced 12m ago');
    expect(syncLabel({ lastSyncAgeMs: 5 * HOUR })).toBe('synced 5h ago');
    expect(syncLabel({ lastSyncAgeMs: 3 * DAY })).toBe('synced 3d ago');
  });

  test('data freshness is the fallback ONLY where no collector ever reported', () => {
    // A server nobody has synced to yet: the session age is all there is.
    expect(syncLabel({ newestSessionAgeMs: 30_000 })).toBe('live');
    expect(syncLabel({ newestSessionAgeMs: 25 * MIN })).toBe('25m behind');
    expect(syncLabel({ newestSessionAgeMs: 4 * HOUR })).toBe('4h behind');
  });

  test('nothing known at all', () => {
    expect(syncLabel({})).toBe('—');
  });
});

describe('the dot colour tracks sync health, not idleness', () => {
  test('THE BUG: idle but healthy is green, not amber', () => {
    expect(syncTone({ lastSyncAgeMs: 2 * MIN, newestSessionAgeMs: 6 * HOUR })).toBe('ok');
  });

  test('busy while walking', () => {
    expect(syncTone({ progress: { done: 1, total: 100 }, lastSyncAgeMs: 1_000 })).toBe('busy');
  });

  test('amber once a sync genuinely has not run', () => {
    expect(syncTone({ lastSyncAgeMs: SYNC_OK_MS + 1 })).toBe('warn');
  });

  test('the boundary is inclusive of ok', () => {
    expect(syncTone({ lastSyncAgeMs: SYNC_OK_MS - 1 })).toBe('ok');
  });

  test('unknown when there is nothing to judge', () => {
    expect(syncTone({})).toBe('unknown');
  });
});

describe('the stale banner accuses the collector, not the calendar', () => {
  test('THE BUG: a two-week holiday raises no alarm', () => {
    // Collector reported 5 minutes ago; newest transcript is 14 days old.
    // The old condition fired a red error here.
    expect(staleSyncAlert(
      { lastSyncAgeMs: 5 * MIN, newestSessionAgeMs: 14 * DAY },
      2,
    )).toBeNull();
  });

  test('a genuinely silent collector does raise one', () => {
    expect(staleSyncAlert({ lastSyncAgeMs: 3 * DAY }, 1)).toEqual({ ageH: 72 });
  });

  test('nothing fires without an active device', () => {
    // With no device the "no-device" banner is the right message instead.
    expect(staleSyncAlert({ lastSyncAgeMs: 10 * DAY }, 0)).toBeNull();
  });

  test('the threshold boundary does not fire early', () => {
    expect(staleSyncAlert({ lastSyncAgeMs: STALE_SYNC_MS }, 1)).toBeNull();
    expect(staleSyncAlert({ lastSyncAgeMs: STALE_SYNC_MS + 1 }, 1)).not.toBeNull();
  });

  test('falls back to session age only when no collector ever reported', () => {
    // Otherwise a real outage on a never-synced server would go unreported.
    expect(staleSyncAlert({ newestSessionAgeMs: 5 * DAY }, 1)).toEqual({ ageH: 120 });
    expect(staleSyncAlert({}, 1)).toBeNull();
  });
});

describe('ago()', () => {
  test('rounds to something a person would say', () => {
    expect(ago(0)).toBe('just now');
    expect(ago(89_000)).toBe('just now');
    expect(ago(90_000)).toBe('2m ago');
    expect(ago(59 * MIN)).toBe('59m ago');
    expect(ago(23 * HOUR)).toBe('23h ago');
    expect(ago(2 * DAY)).toBe('2d ago');
  });
});
