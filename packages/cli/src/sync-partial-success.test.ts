/**
 * A walk that delivered data and then failed is not "never synced".
 *
 * `chat-recall doctor` reported "nothing has synced since 7h ago" on a machine
 * that had just pushed 38 batches, all 200, 3738 rows landed. The walk ended on
 * one fatal batch, the per-target outcome was a bare `ok: false`, and the
 * health file's `lastOkAt` only ever moved on `ok: true`. So the one place a
 * user looks to answer "is my data arriving" said no while it was arriving.
 *
 * Delivery and completion are different facts. These assert the health record
 * carries both — a recent `lastOkAt` AND the failure count — because reporting
 * only one of them is how this looked like a total outage for a day.
 */
import { describe, test, expect } from 'vitest';
import { applySyncOutcome, type TargetHealth } from '@chat-recall/engine/core/collector-health.js';

/**
 * The REAL rule, not a copy. The first version of this file re-implemented
 * `noteSyncOutcome` in its own harness, which is the trap the fleet-health test
 * header in this repo already documents: a copy passes while the real one is
 * broken. The rule now lives in the engine precisely so this can import it.
 */
const noteSyncOutcome = (
  t: TargetHealth | undefined, ok: boolean, accepted: number, err: string | undefined, now: number,
): TargetHealth => applySyncOutcome(t, { ok, accepted, error: err }, now);

const NOW = 1_800_000_000_000;
const fresh = (): TargetHealth => ({ lastOkAt: null, failures: 0 });

describe('a failed walk that still delivered', () => {
  test('THE FAILURE: data arrived, so the target is not stale', () => {
    const t = noteSyncOutcome(fresh(), false, 38, 'HTTP 524', NOW);
    expect(t.lastOkAt).toBe(NOW);
  });

  test('and the failure is still counted, so nothing is swept under', () => {
    const t = noteSyncOutcome(fresh(), false, 38, 'HTTP 524', NOW);
    expect(t.failures).toBe(1);
    expect(t.lastError).toBe('HTTP 524');
  });

  test('both facts survive together — recent data AND a live problem', () => {
    let t = noteSyncOutcome(fresh(), false, 10, 'HTTP 524', NOW);
    t = noteSyncOutcome(t, false, 12, 'HTTP 524', NOW + 60_000);
    expect(t.lastOkAt).toBe(NOW + 60_000);
    expect(t.failures).toBe(2);
  });
});

describe('a walk that delivered nothing', () => {
  test('stays stale, which is the case the health file already got right', () => {
    const t = noteSyncOutcome(fresh(), false, 0, 'ECONNREFUSED', NOW);
    expect(t.lastOkAt).toBeNull();
    expect(t.failures).toBe(1);
  });

  test('a refused target does not inherit a sibling target’s success', () => {
    // The older bug this file sits next to: one verdict applied to every
    // target. Each target is judged on what IT accepted.
    const good = noteSyncOutcome(fresh(), true, 5, undefined, NOW);
    const dead = noteSyncOutcome(fresh(), false, 0, 'ECONNREFUSED', NOW);
    expect(good.lastOkAt).toBe(NOW);
    expect(dead.lastOkAt).toBeNull();
  });
});

describe('a clean walk', () => {
  test('clears the failure streak', () => {
    let t = noteSyncOutcome(fresh(), false, 0, 'HTTP 500', NOW);
    t = noteSyncOutcome(t, true, 20, undefined, NOW + 1000);
    expect(t.failures).toBe(0);
    expect(t.lastError).toBeUndefined();
    expect(t.lastOkAt).toBe(NOW + 1000);
  });
});
