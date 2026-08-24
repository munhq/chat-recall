/**
 * The sync badge said "syncing 99%" on a fully synced install, and nothing
 * caught it because the decision lived inline in a route handler that needs a
 * Postgres tenant and a live collector to exercise.
 *
 * These call the real `readWalkProgress` the route now delegates to. Each case
 * below is written to FAIL against the original logic, which was
 * `if (!p.complete && p.total > 0 && fresh)` — so this file is a regression
 * test, not a description of the current code.
 *
 * The live value that identified the bug, kept as the first case:
 *   done = 15736  total = 15736  complete = false  age = 11s
 */
import { describe, test, expect } from 'vitest';
import { readWalkProgress, PROGRESS_STALE_MS } from './walk-progress.js';

const NOW = 1_800_000_000_000;
const report = (o: Partial<{ done: number; total: number; complete: boolean; at: number }> = {}) =>
  JSON.stringify({ done: 0, total: 100, complete: false, at: NOW - 5_000, ...o });

describe('a finished walk is not "in progress"', () => {
  test('THE BUG: done === total with complete:false reports no progress', () => {
    // Verbatim from production. The collector sets complete:true only after its
    // last upload, so the flag never ships when there is nothing left to send.
    const raw = report({ done: 15736, total: 15736, complete: false, at: NOW - 11_000 });
    expect(readWalkProgress(raw, NOW).progress).toBeNull();
  });

  test('done past total also counts as finished', () => {
    // Belt and braces: a walk that grew its denominator mid-run could overshoot.
    const raw = report({ done: 120, total: 100, complete: false });
    expect(readWalkProgress(raw, NOW).progress).toBeNull();
  });

  test('the explicit complete flag is still honoured', () => {
    const raw = report({ done: 40, total: 100, complete: true });
    expect(readWalkProgress(raw, NOW).progress).toBeNull();
  });
});

describe('a walk genuinely in flight still reports', () => {
  test('mid-walk progress survives', () => {
    const raw = report({ done: 6_200, total: 15_736, complete: false, at: NOW - 3_000 });
    expect(readWalkProgress(raw, NOW).progress).toEqual({ done: 6_200, total: 15_736 });
  });

  test('one item short of the end is still in flight', () => {
    // The boundary that matters: this must NOT be swallowed by the done>=total
    // rule, or a real walk would go silent just before finishing.
    const raw = report({ done: 99, total: 100, complete: false });
    expect(readWalkProgress(raw, NOW).progress).toEqual({ done: 99, total: 100 });
  });

  test('a collector that died mid-walk goes quiet rather than freezing the UI', () => {
    const raw = report({ done: 6_200, total: 15_736, at: NOW - PROGRESS_STALE_MS - 1 });
    expect(readWalkProgress(raw, NOW).progress).toBeNull();
  });

  test('total of zero is not a walk', () => {
    expect(readWalkProgress(report({ done: 0, total: 0 }), NOW).progress).toBeNull();
  });
});

describe('lastSyncAgeMs answers "is sync working", separately from progress', () => {
  test('reported for a FINISHED walk — the case that needs it most', () => {
    // The badge falls back to this once progress is gone. If it were only
    // populated for in-flight walks the badge would have nothing to say exactly
    // when everything is healthy.
    const raw = report({ done: 15_736, total: 15_736, complete: false, at: NOW - 90_000 });
    const v = readWalkProgress(raw, NOW);
    expect(v.progress).toBeNull();
    expect(v.lastSyncAgeMs).toBe(90_000);
  });

  test('reported even when the walk report is stale', () => {
    // "Last sync was 3 days ago" is the most useful thing to say about a dead
    // collector, so staleness must not blank it.
    const raw = report({ at: NOW - 3 * 86_400_000 });
    expect(readWalkProgress(raw, NOW).lastSyncAgeMs).toBe(3 * 86_400_000);
  });

  test('never negative, even if a client clock runs ahead', () => {
    expect(readWalkProgress(report({ at: NOW + 60_000 }), NOW).lastSyncAgeMs).toBe(0);
  });

  test('absent when no collector has ever reported', () => {
    expect(readWalkProgress(null, NOW)).toEqual({ progress: null, lastSyncAgeMs: null });
    expect(readWalkProgress(undefined, NOW).lastSyncAgeMs).toBeNull();
  });

  test('absent when the report carries no usable timestamp', () => {
    expect(readWalkProgress(report({ at: 0 }), NOW).lastSyncAgeMs).toBeNull();
  });
});

describe('a bad value degrades instead of failing the endpoint', () => {
  test('malformed JSON', () => {
    expect(readWalkProgress('{not json', NOW)).toEqual({ progress: null, lastSyncAgeMs: null });
  });

  test('right shape, wrong types', () => {
    const raw = JSON.stringify({ done: 'lots', total: 'more', complete: false, at: NOW });
    expect(readWalkProgress(raw, NOW)).toEqual({ progress: null, lastSyncAgeMs: null });
  });

  test('empty string', () => {
    expect(readWalkProgress('', NOW).progress).toBeNull();
  });
});
