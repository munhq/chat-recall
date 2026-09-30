/**
 * A boot with no schema change runs no DDL.
 *
 * Every boot ran all of PG_SCHEMA, and an ALTER TABLE that changes nothing
 * still takes AccessExclusiveLock. During a rollout the outgoing pods still
 * ingest syncs, and one sync lost a deadlock to the boot DDL: 40P01 between a
 * RowExclusiveLock on session_metadata and an AccessExclusiveLock on
 * raw_sessions.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { ensurePgSchema, closePgPools, schemaHash } from './pg-pool.js';
import { PG_SCHEMA } from './pg-schema.js';
import { pgTestUrl } from '../../test-support/pg-urls.js';

const PG_URL = pgTestUrl();

(PG_URL ? describe : describe.skip)('schema bootstrap (postgres)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    await ensurePgSchema(PG_URL);
    client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await closePgPools();
  });

  test('the applied schema hash is recorded', async () => {
    const r = await client.query('SELECT schema_hash FROM schema_bootstrap WHERE id = 1');
    expect(r.rows[0].schema_hash).toBe(schemaHash(PG_SCHEMA));
  });

  test('THE FAILURE: a boot finishes while a sync holds a write lock on raw_sessions', async () => {
    await client.query('BEGIN');
    try {
      await client.query('LOCK TABLE raw_sessions IN ROW EXCLUSIVE MODE');
      await closePgPools(); // a new process: nothing memoised
      const started = Date.now();
      await ensurePgSchema(PG_URL);
      // The DDL would wait for the lock until lock_timeout (30 s) and retry.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  test('a changed or missing hash applies the schema again', async () => {
    await client.query("UPDATE schema_bootstrap SET schema_hash = 'stale' WHERE id = 1");
    await closePgPools();
    await ensurePgSchema(PG_URL);
    const r = await client.query('SELECT schema_hash FROM schema_bootstrap WHERE id = 1');
    expect(r.rows[0].schema_hash).toBe(schemaHash(PG_SCHEMA));
  });
});
