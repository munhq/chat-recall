/**
 * What the ingest transaction does to state that lives outside it.
 *
 * POST /api/sync runs its whole write inside store.withTransaction(). The
 * archive bytes live in object storage, which a ROLLBACK cannot reach, so each
 * case here makes the transaction fail after a write and checks that the
 * committed row and its object still agree.
 *
 * The object store is an in-memory double: these cases are about the order of
 * the object operations against COMMIT, which the double records exactly.
 * The store connects as the role in DATABASE_URL, which vitest.global-setup.ts
 * makes a role that RLS applies to: the archive writes are elevated past a
 * RESTRICTIVE policy, and a superuser skips RLS. Writes and purges run
 * as a named author, as a device-token sync does, on sessions whose metadata
 * row makes them visible to that author.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createStore } from './index.js';
import { createOutcomeCache } from './caches.js';
import { ObjectNotFound, resetObjectStore, setObjectStoreForTests, type RawObjectStore } from './object-store.js';
import { runWithAuthor } from './tenant-context.js';
import { pgAdminUrl, pgTestUrl } from '../../test-support/pg-urls.js';

const PG_URL = pgTestUrl();
const AUTHOR = { sub: 'ingest-tx-author', device: 'dev-1' };

class MemoryObjects implements RawObjectStore {
  readonly bucket = 'memory';
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer) { this.objects.set(key, Buffer.from(body)); }
  async get(key: string) {
    const b = this.objects.get(key);
    if (!b) throw new ObjectNotFound(key);
    return b;
  }
  async delete(key: string) { this.objects.delete(key); }
  keysFor(sessionId: string) { return [...this.objects.keys()].filter((k) => k.includes(`/${sessionId}`)); }
}

const gz = (tag: string) => Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.from(tag)]);
const LATER_STEP_FAILED = 'a later step of the ingest failed';

(PG_URL ? describe : describe.skip)('the ingest transaction and object storage', () => {
  let admin: any;
  let store: any;
  let objects: MemoryObjects;
  const tenant = `ingest_tx_${process.pid}`;

  beforeAll(async () => {
    const pg = (await import('pg')).default;
    admin = new pg.Pool({ connectionString: pgAdminUrl(), max: 2 });
    store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant } as any);
  }, 60000);
  afterAll(async () => {
    resetObjectStore();
    await store?.close();
    await admin?.end();
  });
  afterEach(() => resetObjectStore());

  const useObjects = () => { objects = new MemoryObjects(); setObjectStoreForTests(objects); };
  const asAuthor = <T>(fn: () => Promise<T>) => runWithAuthor(AUTHOR, fn);
  /** A session's metadata row, which is what makes its archive visible to its author. */
  const session = (id: string) => asAuthor(() => store.setItem({
    id, sourceType: 'session', title: id, projectPath: '/home/user/code/example',
    projectId: 'example-app', filePath: '', mtime: 1, contentPreview: id,
  }));
  const rowKey = async (sessionId: string): Promise<string> =>
    (await admin.query(`SELECT object_key FROM raw_sessions WHERE tenant=$1 AND session_id=$2`, [tenant, sessionId])).rows[0]?.object_key;

  // A member runs the sync route's purge. The retention sweeps and the admin
  // routes run with no author.
  test.each([
    ['a member', (fn: () => Promise<unknown>) => runWithAuthor(AUTHOR, fn)],
    ['no author', (fn: () => Promise<unknown>) => fn()],
  ])('a purge by %s that rolls back keeps the archive object its row names', async (who, as) => {
    useObjects();
    const id = `s-purge-rollback-${who.replace(/\s+/g, '-')}`;
    await session(id);
    await asAuthor(() => store.putRawSession(id, 'claude', 1000, gz('v1'), 100));
    const key = await rowKey(id);
    expect(objects.objects.has(key)).toBe(true);

    await expect(as(() => store.withTransaction(async () => {
      await store.purgeSessionsMany([id]);
      throw new Error(LATER_STEP_FAILED);
    }))).rejects.toThrow(LATER_STEP_FAILED);

    // The row came back with the rollback, so its object must still be there.
    expect(await rowKey(id)).toBe(key);
    const back = await store.getRawSession(id);
    expect(Buffer.compare(back!.gz, gz('v1'))).toBe(0);
  });

  test('a purge that commits deletes the object, after the COMMIT', async () => {
    useObjects();
    await session('s-purge-commit');
    await asAuthor(() => store.putRawSession('s-purge-commit', 'claude', 1000, gz('v1'), 100));
    const key = await rowKey('s-purge-commit');
    let presentBeforeCommit: boolean | undefined;
    await asAuthor(() => store.withTransaction(async () => {
      await store.purgeSessionsMany(['s-purge-commit']);
      presentBeforeCommit = objects.objects.has(key);
    }));
    expect(presentBeforeCommit).toBe(true);
    expect(objects.objects.has(key)).toBe(false);
    expect(await rowKey('s-purge-commit')).toBeUndefined();
  });

  test('a purge outside a transaction deletes the object once its own transaction commits', async () => {
    useObjects();
    await session('s-purge-plain');
    await asAuthor(() => store.putRawSession('s-purge-plain', 'claude', 1000, gz('v1'), 100));
    await asAuthor(() => store.purgeSession('s-purge-plain'));
    expect(objects.keysFor('s-purge-plain')).toEqual([]);
    expect(await rowKey('s-purge-plain')).toBeUndefined();
  });

  test('a purge run as a member removes every session-keyed row', async () => {
    useObjects();
    await session('s-member-purge');
    await asAuthor(() => store.putRawSession('s-member-purge', 'claude', 1000, gz('v1'), 100));
    await asAuthor(() => store.writeIngestBatch({
      compute: [{ sessionId: 's-member-purge', kind: 'markers', mtime: 1, data: { prompts: ['a'] } }],
    }));
    const outcomes = await createOutcomeCache({ backend: 'postgres', databaseUrl: PG_URL, tenant } as any);
    await asAuthor(() => outcomes.put({
      sessionId: 's-member-purge', tool: 'claude', status: 'completed' as any, reason: 'test', fileMtime: 1, fileSize: 1,
      contentHash: 'h', fileCount: 1, linesAdded: 1, linesRemoved: 0, commits: 0, isFull: true, classifiedAt: 1, lastScannedOffset: 0,
    }));
    const left = async () => (await admin.query(
      `SELECT (SELECT count(*) FROM raw_sessions WHERE tenant=$1 AND session_id=$2)::int AS raw,
              (SELECT count(*) FROM compute_cache WHERE tenant=$1 AND session_id=$2)::int AS compute,
              (SELECT count(*) FROM session_outcome_cache WHERE tenant=$1 AND session_id=$2)::int AS outcome,
              (SELECT count(*) FROM memory_metadata WHERE tenant=$1 AND id=$2)::int AS meta`,
      [tenant, 's-member-purge'])).rows[0];
    expect(await left()).toEqual({ raw: 1, compute: 1, outcome: 1, meta: 1 });

    await asAuthor(() => store.withTransaction(() => store.purgeSessionsMany(['s-member-purge'])));
    expect(await left()).toEqual({ raw: 0, compute: 0, outcome: 0, meta: 0 });
    expect(objects.keysFor('s-member-purge')).toEqual([]);
  });
});
