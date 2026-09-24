/**
 * The fleet-health query must actually run.
 *
 * It did not. It passed five parameters and referenced four, and Postgres
 * cannot infer a type for a parameter no part of the statement uses — so every
 * scrape died with 42P18 "could not determine data type of parameter $3". The
 * route catches that on purpose (a diagnosis panel must never void a scrape
 * that also carries the gauges which page), so the only trace was a warn line,
 * every 30 seconds, for the life of the pod. Fleet health was simply never
 * recorded.
 *
 * No unit test could have caught it: an unreferenced parameter is legal
 * JavaScript and legal SQL text. Only a real parse fails. So this runs the
 * real query against a real Postgres, and asserts the thing the route cannot:
 * that it did not throw.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { collectFleetHealth } from './metrics.js';
import { pgAdminUrl } from '@chat-recall/engine/test-support/pg-urls.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;

// The two devices report under different tenants. client_events is RLS-scoped
// by tenant, so the query must count inside each one and add them up.
const TENANTS = ['default', 'fleet_other'];

(PG_URL ? describe : describe.skip)('the fleet-health query', () => {
  let pool: any;
  // Seeds and cleans past RLS: client_events is tenant-walled, and these rows
  // stand for devices in any tenant.
  let admin: any;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL });
    admin = new pg.Pool({ connectionString: pgAdminUrl() });
    await admin.query(`CREATE TABLE IF NOT EXISTS client_events (
      tenant TEXT NOT NULL DEFAULT 'default', device_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL, ts BIGINT NOT NULL, payload JSONB NOT NULL DEFAULT '{}')`);
    await admin.query(`DELETE FROM client_events WHERE device_id IN ('laptop','desktop')`);
    const now = Date.now();
    await admin.query(
      `INSERT INTO client_events (tenant, device_id, kind, ts) VALUES
        ('default','laptop','collector_heartbeat',$1), ('default','laptop','sync',$1),
        ('fleet_other','desktop','collector_heartbeat',$2), ('fleet_other','desktop','sync',$2),
        ('default','laptop','breaker_trip',$1)`,
      [now - 60_000, now - 3 * 60 * 60 * 1000]);
  }, 30000);

  afterAll(async () => {
    try { await admin.query(`DELETE FROM client_events WHERE device_id IN ('laptop','desktop')`); } catch { /* best effort */ }
    await pool?.end();
    await admin?.end();
  });

  test('THE FAILURE: the query runs, so the panel gets numbers', async () => {
    // NOT "it did not throw" — the route catches its own error and returns
    // zeros, so a resolves-assertion passes just as happily on the broken
    // query. The only observable difference between a query that ran and one
    // that died is whether the counts are real. Verified by reintroducing the
    // spare parameter: this test fails, a resolves-assertion does not.
    const r = await collectFleetHealth(pool, TENANTS);
    expect(r.active, 'zero active devices means the query never ran').toBeGreaterThan(0);
  });

  test('it counts an active device and the failures it reported', async () => {
    const r = await collectFleetHealth(pool, TENANTS);
    expect(r.active).toBeGreaterThanOrEqual(2);
    expect(r.failures.breaker_trip).toBeGreaterThanOrEqual(1);
  });

  test('a device whose heartbeat stopped is stale, one beating now is not', async () => {
    // desktop last beat 3h ago against a 30-minute rule; laptop beat a minute ago.
    const r = await collectFleetHealth(pool, TENANTS);
    expect(r.stale).toBeGreaterThanOrEqual(1);
  });
});
