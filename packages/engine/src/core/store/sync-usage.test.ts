/**
 * The sync-usage meter — what the free tier's quota and storage cap read.
 *
 * The properties that matter:
 *   1. Increments ACCUMULATE per (tenant, month) — the upsert must add, not
 *      replace, or a month of usage collapses to the last batch's size.
 *   2. getSyncUsage answers BOTH numbers in one shape: the named month and the
 *      all-time total (the storage cap has no reset; the quota does).
 *   3. Tenants never see each other's bytes.
 *   4. resetSyncUsage zeroes everything for one tenant only — it backs the
 *      delete-all path, where "storage used" must restart with the data.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createControlPlane, type ControlPlane } from './control-plane.js';

let tmp: string;
let cp: ControlPlane;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cr-usage-'));
  cp = await createControlPlane({ sqlitePath: join(tmp, 'cache.db') });
});
afterEach(async () => {
  await cp.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('sync usage meter', () => {
  test('increments accumulate within a month', async () => {
    await cp.addSyncUsage('t1', '2026-08', 100);
    await cp.addSyncUsage('t1', '2026-08', 250);
    const u = await cp.getSyncUsage('t1', '2026-08');
    expect(u.monthBytes).toBe(350);
    expect(u.totalBytes).toBe(350);
  });

  test('total spans months, monthBytes does not', async () => {
    await cp.addSyncUsage('t1', '2026-07', 1000);
    await cp.addSyncUsage('t1', '2026-08', 200);
    const u = await cp.getSyncUsage('t1', '2026-08');
    expect(u.monthBytes).toBe(200);
    expect(u.totalBytes).toBe(1200);
  });

  test('a tenant with no rows reads as zero, not as an error', async () => {
    const u = await cp.getSyncUsage('never-synced', '2026-08');
    expect(u).toEqual({ monthBytes: 0, totalBytes: 0 });
  });

  test('tenants are isolated', async () => {
    await cp.addSyncUsage('t1', '2026-08', 500);
    await cp.addSyncUsage('t2', '2026-08', 7);
    expect((await cp.getSyncUsage('t2', '2026-08')).totalBytes).toBe(7);
  });

  test('negative and fractional inputs cannot corrupt the meter', async () => {
    // A negative add would let a crafted batch REFUND quota; clamp to zero.
    await cp.addSyncUsage('t1', '2026-08', -5000);
    await cp.addSyncUsage('t1', '2026-08', 10.9);
    const u = await cp.getSyncUsage('t1', '2026-08');
    expect(u.monthBytes).toBe(10);
  });

  test('resetSyncUsage zeroes one tenant only', async () => {
    await cp.addSyncUsage('t1', '2026-07', 100);
    await cp.addSyncUsage('t1', '2026-08', 100);
    await cp.addSyncUsage('t2', '2026-08', 42);
    await cp.resetSyncUsage('t1');
    expect((await cp.getSyncUsage('t1', '2026-08')).totalBytes).toBe(0);
    expect((await cp.getSyncUsage('t2', '2026-08')).totalBytes).toBe(42);
  });

  test('resetSyncUsage with keepMonth preserves the quota meter — the delete-all loophole', async () => {
    // Without keepMonth, delete-all + re-sync was an infinite monthly quota:
    // wipe the data, wipe the meter, sync 50 MB again, repeat.
    await cp.addSyncUsage('t1', '2026-07', 100);
    await cp.addSyncUsage('t1', '2026-08', 40);
    await cp.resetSyncUsage('t1', '2026-08');
    const u = await cp.getSyncUsage('t1', '2026-08');
    expect(u.monthBytes).toBe(40);   // quota consumption survives the wipe
    expect(u.totalBytes).toBe(40);   // storage restarts at this month's bytes
  });

  test('a zero-byte add is PRESENCE: hasSyncActivity sees it, the meters do not', async () => {
    // A refused batch (over a meter) records bytes=0 — enough for the
    // retention sweep to know the tenant is still here, without touching quota.
    await cp.addSyncUsage('t1', '2026-08', 0);
    expect(await cp.hasSyncActivity('t1', ['2026-08'])).toBe(true);
    expect(await cp.hasSyncActivity('t1', ['2026-07'])).toBe(false);
    expect(await cp.hasSyncActivity('t1', [])).toBe(false);
    expect((await cp.getSyncUsage('t1', '2026-08')).monthBytes).toBe(0);
  });
});

// The pg driver runs the same contract when a database is provided — this is
// the code path prod actually executes, and its upsert-increment SQL differs
// from sqlite's, so it gets its own pass rather than trust by symmetry.
const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
(PG_URL ? describe : describe.skip)('sync usage meter — Postgres driver', () => {
  const T = `usage-pg-${process.pid}`;
  test('accumulates, spans months, resets — against real Postgres', async () => {
    const pg = await createControlPlane({ backend: 'postgres', databaseUrl: PG_URL } as never);
    try {
      await pg.resetSyncUsage(T);
      await pg.addSyncUsage(T, '2026-07', 1000);
      await pg.addSyncUsage(T, '2026-08', 200);
      await pg.addSyncUsage(T, '2026-08', 300);
      const u = await pg.getSyncUsage(T, '2026-08');
      expect(u.monthBytes).toBe(500);
      expect(u.totalBytes).toBe(1500);
      await pg.resetSyncUsage(T);
      expect((await pg.getSyncUsage(T, '2026-08')).totalBytes).toBe(0);
    } finally {
      await pg.close();
    }
  });
});
