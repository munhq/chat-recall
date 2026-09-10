/**
 * The raw archive round-trip once the bytes live in object storage.
 *
 * raw_sessions.gz was 1232 MB of a 3564 MB production database, all of it
 * TOAST, and only getRawSession ever read it. The bytes now go to an S3
 * bucket and the row keeps the key.
 *
 * The cases that matter are the mixed ones: a deployment with no bucket
 * configured must keep writing bytes to Postgres, and a row written before the
 * move must still read back. Both shapes exist in the same table at once
 * during the backfill.
 *
 * Gated on DATABASE_URL. The object-storage cases additionally need
 * RAW_ARCHIVE_S3_ENDPOINT; without it they run the Postgres path, which is the
 * self-hosted default.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createStore } from './index.js';
import { resetObjectStore, objectStoreFromEnv, ObjectStore, rawObjectKey } from './object-store.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;
const HAS_OBJECTS = !!process.env.RAW_ARCHIVE_S3_ENDPOINT && !!process.env.RAW_ARCHIVE_S3_BUCKET;
const TENANT = 'raw-archive-test';

(PG_URL ? describe : describe.skip)('raw session archive', () => {
  let store: any;
  let sql: any;
  const gz = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);

  beforeAll(async () => {
    resetObjectStore();
    store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: TENANT } as any);
    // A direct connection for the assertions about column state. The store
    // exposes no raw query, and widening its interface for a test would be the
    // wrong direction.
    sql = new pg.Pool({ connectionString: PG_URL });
  }, 60000);
  afterAll(async () => { await store?.close(); await sql?.end(); });

  test('a stored archive reads back byte for byte', async () => {
    expect(await store.putRawSession('s-round-trip', 'claude', 1000, gz, 4096)).toBe('stored');
    const got = await store.getRawSession('s-round-trip');
    expect(got).not.toBeNull();
    expect(Buffer.compare(got!.gz, gz)).toBe(0);
    expect(got!.size).toBe(4096);
    expect(got!.tool).toBe('claude');
  });

  test('shrink protection still refuses a smaller capture', async () => {
    await store.putRawSession('s-shrink', 'claude', 1000, gz, 8192);
    expect(await store.putRawSession('s-shrink', 'claude', 2000, gz, 10)).toBe('shrink-protected');
  });

  test('an unchanged capture is not rewritten', async () => {
    await store.putRawSession('s-same', 'claude', 1000, gz, 2048);
    expect(await store.putRawSession('s-same', 'claude', 1000, gz, 2048)).toBe('unchanged');
  });

  test('a re-synced session keeps one archive, with the newer bytes', async () => {
    await store.putRawSession('s-grow', 'claude', 1000, gz, 100);
    const grown = Buffer.concat([gz, Buffer.from([0x42, 0x43])]);
    expect(await store.putRawSession('s-grow', 'claude', 2000, grown, 200)).toBe('stored');
    expect(Buffer.compare((await store.getRawSession('s-grow'))!.gz, grown)).toBe(0);
  });

  test('purge removes the archive', async () => {
    await store.putRawSession('s-purge', 'claude', 1000, gz, 512);
    await store.purgeSession('s-purge');
    expect(await store.getRawSession('s-purge')).toBeNull();
  });

  test('listRawSessionVersions reads metadata without fetching any bytes', async () => {
    await store.putRawSession('s-listed', 'claude', 4242, gz, 777);
    const row = (await store.listRawSessionVersions()).find((r: any) => r.session_id === 's-listed');
    expect(row).toMatchObject({ session_id: 's-listed', mtime: 4242, size: 777 });
  });

  (HAS_OBJECTS ? test : test.skip)('the bytes leave Postgres: gz is null and the key is set', async () => {
    await store.putRawSession('s-in-object', 'codex', 1000, gz, 321);
    const { rows } = await sql.query(
      `SELECT gz IS NULL AS gz_null, object_key FROM raw_sessions WHERE tenant=$1 AND session_id=$2`,
      [TENANT, 's-in-object']);
    expect(rows[0].gz_null).toBe(true);
    expect(rows[0].object_key).toBe(rawObjectKey(TENANT, 's-in-object'));
  });

  (HAS_OBJECTS ? test : test.skip)('a row written before the move still reads from Postgres', async () => {
    // Exactly the legacy shape: bytes in the column, no key.
    await sql.query(
      `INSERT INTO raw_sessions (tenant, session_id, tool, mtime, size, gz, object_key, captured_at)
       VALUES ($1,$2,'claude',1,64,$3,'',1)
       ON CONFLICT (tenant, session_id) DO UPDATE SET gz=excluded.gz, object_key=''`,
      [TENANT, 's-legacy', gz]);
    expect(Buffer.compare((await store.getRawSession('s-legacy'))!.gz, gz)).toBe(0);
  });

  (HAS_OBJECTS ? test : test.skip)('purge deletes the object, not only the row', async () => {
    await store.putRawSession('s-obj-purge', 'claude', 1000, gz, 99);
    const key = rawObjectKey(TENANT, 's-obj-purge');
    const objects = new ObjectStore(objectStoreFromEnv()!);
    expect(Buffer.compare(await objects.get(key), gz)).toBe(0);
    await store.purgeSession('s-obj-purge');
    await expect(objects.get(key)).rejects.toThrow();
  });
});
