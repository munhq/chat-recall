/**
 * A replica going away must not 500 a read the primary can serve.
 *
 * THE INCIDENT. A CloudNativePG failover took the read replica away while the
 * server was running. `PgStore.init` validates the replica ONCE, at startup, and
 * degrades to the primary if it cannot be reached — but that check had already
 * passed hours earlier, and the metadata caches call `openPgPoolRo()` directly
 * with no such guard. So `/api/conversations/recent` answered 500 while the
 * primary was healthy and serving every write. The log line that WAS emitted —
 * "using primary for reads" — came from the one path that did fall back, which
 * made the outage read like a different bug entirely.
 *
 * The fallback therefore belongs to the query rather than to startup. These tests
 * drive it with fake pools, because what needs proving is the DECISION — retry an
 * unavailable replica on the primary, and never retry a query that is simply
 * wrong — not that Postgres works.
 */
import { describe, test, expect, vi } from 'vitest';
import { tenantQueryRo } from './pg-pool.js';

/** A pool whose single connection either answers or throws what we hand it. */
function fakePool(name: string, opts: { throws?: unknown } = {}) {
  const calls: string[] = [];
  const client = {
    on() {}, removeListener() {}, release() {},
    async query(sql: string) {
      // BEGIN / SET / COMMIT bookkeeping is not what this test is about.
      if (/^(BEGIN|COMMIT|ROLLBACK|SET|SELECT set_config)/i.test(sql.trim())) return { rows: [] };
      calls.push(sql);
      if (opts.throws) throw opts.throws;
      return { rows: [{ from: name }] };
    },
  };
  return { pool: { async connect() { return client; } }, calls };
}

const pgErr = (o: Record<string, unknown>) => Object.assign(new Error('boom'), o);

describe('a read whose replica has gone away', () => {
  test('THE POINT: a FATAL from the replica is retried on the primary', async () => {
    // Exactly what the failover produced: "the database system is shutting down".
    const ro = fakePool('replica', { throws: pgErr({ code: '08P01', severity: 'FATAL' }) });
    const rw = fakePool('primary');

    const r = await tenantQueryRo(ro.pool, rw.pool, 't1', 'SELECT 1');
    expect(r.rows).toEqual([{ from: 'primary' }]);
    expect(ro.calls).toHaveLength(1);   // it did try the replica first
    expect(rw.calls).toHaveLength(1);   // …and only then the primary
  });

  test.each([
    ['08006', 'connection failure'],
    ['08001', 'cannot connect'],
    ['57P03', 'cannot connect now'],
    ['57P01', 'admin shutdown'],
    ['ECONNREFUSED', 'socket refused'],
    ['ETIMEDOUT', 'socket timeout'],
  ])('%s (%s) falls back', async (code) => {
    const ro = fakePool('replica', { throws: pgErr({ code }) });
    const rw = fakePool('primary');
    expect((await tenantQueryRo(ro.pool, rw.pool, 't1', 'SELECT 1')).rows).toEqual([{ from: 'primary' }]);
  });

  test('a WRONG query is not retried — it fails the same way on either pool', async () => {
    // 42601 is a syntax error. Retrying doubles the work, hides the cause, and
    // cannot succeed. The distinction is the whole point of the predicate.
    const ro = fakePool('replica', { throws: pgErr({ code: '42601', severity: 'ERROR' }) });
    const rw = fakePool('primary');

    await expect(tenantQueryRo(ro.pool, rw.pool, 't1', 'SELEKT 1')).rejects.toThrow();
    expect(rw.calls).toHaveLength(0);
  });

  test('a healthy replica serves the read and the primary is never touched', async () => {
    const ro = fakePool('replica');
    const rw = fakePool('primary');
    expect((await tenantQueryRo(ro.pool, rw.pool, 't1', 'SELECT 1')).rows).toEqual([{ from: 'replica' }]);
    expect(rw.calls).toHaveLength(0);
  });

  test('no separate replica configured ⇒ straight to the primary, no double attempt', async () => {
    const rw = fakePool('primary');
    expect((await tenantQueryRo(rw.pool, rw.pool, 't1', 'SELECT 1')).rows).toEqual([{ from: 'primary' }]);
    expect(rw.calls).toHaveLength(1);
    // …and a null RO pool behaves the same rather than throwing.
    const rw2 = fakePool('primary');
    expect((await tenantQueryRo(null, rw2.pool, 't1', 'SELECT 1')).rows).toEqual([{ from: 'primary' }]);
  });

  test('the primary failing too surfaces ITS error, not the replica-s', async () => {
    const ro = fakePool('replica', { throws: pgErr({ code: '08P01', severity: 'FATAL' }) });
    const rw = fakePool('primary', { throws: pgErr({ code: '53300', message: 'too many connections' }) });
    await expect(tenantQueryRo(ro.pool, rw.pool, 't1', 'SELECT 1'))
      .rejects.toMatchObject({ code: '53300' });
  });

  test('the degraded-read warning is rate limited, not one per query', async () => {
    const logger = { warn: vi.fn() };
    vi.doMock('../logger.js', () => ({ createLogger: () => logger }));
    const rw = fakePool('primary');
    for (let i = 0; i < 5; i++) {
      const ro = fakePool('replica', { throws: pgErr({ code: '08P01', severity: 'FATAL' }) });
      await tenantQueryRo(ro.pool, rw.pool, 't1', 'SELECT 1');
    }
    expect(rw.calls).toHaveLength(5);          // every read still served
    expect(logger.warn.mock.calls.length).toBeLessThanOrEqual(1);
    vi.doUnmock('../logger.js');
  });
});
