import { describe, test, expect, vi } from 'vitest';
import { applySchemaWithRetry } from './pg-pool.js';

/**
 * The schema bootstrap runs on every pod at boot. During a rolling deploy the
 * OUTGOING pods are still serving traffic, so an ordinary SELECT holds
 * AccessShareLock on a table the incoming pod's DDL wants AccessExclusiveLock
 * on. Production hit exactly that between memory_chunks and session_metadata:
 * Postgres picked the DDL session as the deadlock victim, the error propagated
 * out of boot, and the pod crash-looped through every rollout.
 *
 * The advisory lock in ensurePgSchema does not help here — it serialises the
 * APPLIERS, and this conflict is applier-vs-reader.
 */

const pgErr = (code: string) => Object.assign(new Error(`pg error ${code}`), { code });
const noSleep = async () => {};

describe('applySchemaWithRetry', () => {
  test('applies once when there is no conflict', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await expect(applySchemaWithRetry(run, 'CREATE TABLE x', { sleep: noSleep })).resolves.toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('retries a deadlock (40P01) and succeeds — the production failure', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(pgErr('40P01'))
      .mockRejectedValueOnce(pgErr('40P01'))
      .mockResolvedValue(undefined);
    await expect(applySchemaWithRetry(run, 'DDL', { sleep: noSleep })).resolves.toBe(3);
    expect(run).toHaveBeenCalledTimes(3);
  });

  test('retries lock_timeout (55P03) too', async () => {
    const run = vi.fn().mockRejectedValueOnce(pgErr('55P03')).mockResolvedValue(undefined);
    await expect(applySchemaWithRetry(run, 'DDL', { sleep: noSleep })).resolves.toBe(2);
  });

  test('gives up after maxAttempts rather than retrying forever', async () => {
    const run = vi.fn().mockRejectedValue(pgErr('40P01'));
    await expect(applySchemaWithRetry(run, 'DDL', { maxAttempts: 3, sleep: noSleep }))
      .rejects.toMatchObject({ code: '40P01' });
    expect(run).toHaveBeenCalledTimes(3);
  });

  test('a non-lock error is NOT retried — a syntax error must surface at once', async () => {
    const run = vi.fn().mockRejectedValue(pgErr('42601')); // syntax_error
    await expect(applySchemaWithRetry(run, 'DDL', { sleep: noSleep }))
      .rejects.toMatchObject({ code: '42601' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('an error with no SQLSTATE is not retried', async () => {
    const run = vi.fn().mockRejectedValue(new Error('socket hang up'));
    await expect(applySchemaWithRetry(run, 'DDL', { sleep: noSleep })).rejects.toThrow('socket hang up');
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('backoff grows and is jittered, so two pods do not retry in lockstep', async () => {
    const waits: number[] = [];
    const run = vi.fn().mockRejectedValue(pgErr('40P01'));
    await applySchemaWithRetry(run, 'DDL', {
      maxAttempts: 5,
      sleep: async (ms) => { waits.push(ms); },
    }).catch(() => {});

    expect(waits).toHaveLength(4);
    // Base doubles (250/500/1000/2000) with up to 250ms of jitter on top.
    expect(waits[0]).toBeGreaterThanOrEqual(250);
    expect(waits[0]).toBeLessThan(500);
    expect(waits[3]).toBeGreaterThanOrEqual(2000);
    expect(waits[3]).toBeLessThan(2250);
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThan(waits[i - 1]);
  });

  test('jitter actually varies between runs', async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 12; i++) {
      const run = vi.fn().mockRejectedValue(pgErr('40P01'));
      await applySchemaWithRetry(run, 'DDL', {
        maxAttempts: 2,
        sleep: async (ms) => { seen.add(ms); },
      }).catch(() => {});
    }
    // Identical backoff on every run would mean the jitter is not applied.
    expect(seen.size).toBeGreaterThan(1);
  });
});
