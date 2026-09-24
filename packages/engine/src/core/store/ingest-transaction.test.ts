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
import { ObjectNotFound, rawObjectKey, resetObjectStore, setObjectStoreForTests, type RawObjectStore } from './object-store.js';
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

  test('a rewrite that rolls back leaves the committed row and its bytes in agreement', async () => {
    useObjects();
    await session('s-rewrite-rollback');
    await asAuthor(() => store.putRawSession('s-rewrite-rollback', 'claude', 1000, gz('v1'), 100));

    await expect(asAuthor(() => store.withTransaction(async () => {
      expect(await store.putRawSession('s-rewrite-rollback', 'claude', 2000, gz('v2-longer'), 200)).toBe('stored');
      throw new Error(LATER_STEP_FAILED);
    }))).rejects.toThrow(LATER_STEP_FAILED);

    const back = await store.getRawSession('s-rewrite-rollback');
    expect(back!.size).toBe(100);
    expect(back!.mtime).toBe(1000);
    expect(Buffer.compare(back!.gz, gz('v1'))).toBe(0);
  });

  test('a rewrite that commits goes to a new key and deletes the old object after the COMMIT', async () => {
    useObjects();
    await session('s-rewrite-commit');
    await asAuthor(() => store.putRawSession('s-rewrite-commit', 'claude', 1000, gz('v1'), 100));
    const oldKey = await rowKey('s-rewrite-commit');
    let oldPresentBeforeCommit: boolean | undefined;
    await asAuthor(() => store.withTransaction(async () => {
      await store.putRawSession('s-rewrite-commit', 'claude', 2000, gz('v2-longer'), 200);
      oldPresentBeforeCommit = objects.objects.has(oldKey);
    }));
    const newKey = await rowKey('s-rewrite-commit');
    expect(newKey).not.toBe(oldKey);
    expect(oldPresentBeforeCommit).toBe(true);
    expect(objects.keysFor('s-rewrite-commit')).toEqual([newKey]);
    const back = await store.getRawSession('s-rewrite-commit');
    expect(back!.size).toBe(200);
    expect(Buffer.compare(back!.gz, gz('v2-longer'))).toBe(0);
  });

  test('two rewrites of one session in one transaction keep only the last object', async () => {
    useObjects();
    await session('s-rewrite-twice');
    await asAuthor(() => store.putRawSession('s-rewrite-twice', 'claude', 1000, gz('v1'), 100));
    await asAuthor(() => store.withTransaction(async () => {
      await store.putRawSession('s-rewrite-twice', 'claude', 2000, gz('v2'), 200);
      await store.putRawSession('s-rewrite-twice', 'claude', 3000, gz('v3'), 300);
    }));
    expect(objects.keysFor('s-rewrite-twice')).toEqual([await rowKey('s-rewrite-twice')]);
    const back = await store.getRawSession('s-rewrite-twice');
    expect(Buffer.compare(back!.gz, gz('v3'))).toBe(0);
  });

  test('a row that names the unversioned key reads, and its object goes when a rewrite supersedes it', async () => {
    useObjects();
    const legacyKey = rawObjectKey(tenant, 's-legacy-key');
    await objects.put(legacyKey, gz('legacy'));
    // Exactly the shape every row written before versioned keys has. The
    // metadata row makes it visible to its author under author_visibility.
    await session('s-legacy-key');
    await admin.query(
      `INSERT INTO raw_sessions (tenant, session_id, tool, mtime, size, gz, object_key, captured_at)
       VALUES ($1,$2,'claude',1000,64,NULL,$3,1)`, [tenant, 's-legacy-key', legacyKey]);
    const legacy = await store.getRawSession('s-legacy-key');
    expect(Buffer.compare(legacy!.gz, gz('legacy'))).toBe(0);

    await asAuthor(() => store.withTransaction(() =>
      store.putRawSession('s-legacy-key', 'claude', 2000, gz('grown'), 128)));
    expect(objects.objects.has(legacyKey)).toBe(false);
    const back = await store.getRawSession('s-legacy-key');
    expect(Buffer.compare(back!.gz, gz('grown'))).toBe(0);
  });
});

(PG_URL ? describe : describe.skip)('the ingest batch writes the other stores on its own transaction', () => {
  let admin: any;
  let store: any;
  const tenant = `ingest_side_${process.pid}`;
  const item = (id: string) => ({
    id, sourceType: 'session' as const, title: id, projectPath: '/home/user/code/example',
    projectId: 'example-app', filePath: '', mtime: 1, contentPreview: 'first prompt',
  });
  const outcome = (sessionId: string, isFull: boolean, status = 'completed') => ({
    sessionId, tool: 'claude', status: status as any, reason: 'test', fileMtime: 1, fileSize: 1,
    contentHash: 'h', fileCount: 1, linesAdded: 1, linesRemoved: 0, commits: 0, isFull,
    classifiedAt: 1, lastScannedOffset: 0,
  });
  const count = async (table: string) =>
    (await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant=$1`, [tenant])).rows[0].n;

  beforeAll(async () => {
    const pg = (await import('pg')).default;
    admin = new pg.Pool({ connectionString: pgAdminUrl(), max: 2 });
    store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant } as any);
  }, 60000);
  afterAll(async () => {
    await store?.close();
    await admin?.end();
  });

  test('outcomes, tool titles and the knowledge graph commit with the batch, under RLS', async () => {
    const written = await runWithAuthor(AUTHOR, () => store.withTransaction(() => store.writeIngestBatch({
      items: [item('s-side')],
      sessionMeta: [{ sessionId: 's-side', firstPrompt: 'first prompt', summary: '', summarySource: 'original', mtime: 1, indexedAt: 1 } as any],
      // No metadata row exists or is written for s-no-parent, so no title row either.
      toolTitles: [{ sessionId: 's-side', title: 'first' }, { sessionId: 's-side', title: 'native title' }, { sessionId: 's-no-parent', title: 'x' }],
      // The outcome's session is not visible to the writer: it must still land.
      outcomes: [outcome('s-side', true), outcome('s-side', false, 'shipped'), outcome('s-elsewhere', false)],
      kgEntities: [{ name: 'Example-App', type: 'project', properties: {} }, { name: 'example-app', type: 'tool', properties: { a: 1 } }],
      kgTriples: [{ subject: 'example-app', predicate: 'uses', object: 'postgres' }, { subject: 'example-app', predicate: 'uses', object: 'postgres' }],
    })));
    // The repeated triple is stored once.
    expect(written.kgTriplesInserted).toBe(1);

    const titles = (await admin.query(`SELECT session_id, tool_title, author_sub FROM session_metadata WHERE tenant=$1 ORDER BY 1`, [tenant])).rows;
    expect(titles).toEqual([{ session_id: 's-side', tool_title: 'native title', author_sub: AUTHOR.sub }]);
    const outcomes = (await admin.query(`SELECT session_id, status, is_full FROM session_outcome_cache WHERE tenant=$1 ORDER BY 1`, [tenant])).rows;
    // The later row wins, and is_full stays once either row set it.
    expect(outcomes).toEqual([
      { session_id: 's-elsewhere', status: 'completed', is_full: 0 },
      { session_id: 's-side', status: 'shipped', is_full: 1 },
    ]);
    const ents = (await admin.query(`SELECT id, type FROM kg_entities WHERE tenant=$1 ORDER BY 1`, [tenant])).rows;
    expect(ents).toEqual([{ id: 'example-app', type: 'tool' }, { id: 'postgres', type: 'unknown' }]);

    // Re-importing the same triple inserts nothing.
    const again = await runWithAuthor(AUTHOR, () => store.withTransaction(() => store.writeIngestBatch({
      kgTriples: [{ subject: 'example-app', predicate: 'uses', object: 'postgres' }],
    })));
    expect(again.kgTriplesInserted).toBe(0);
  });

  test('a batch that rolls back leaves none of those rows', async () => {
    const before = {
      outcomes: await count('session_outcome_cache'), triples: await count('kg_triples'),
      entities: await count('kg_entities'), meta: await count('session_metadata'),
    };
    await expect(runWithAuthor(AUTHOR, () => store.withTransaction(async () => {
      await store.writeIngestBatch({
        items: [item('s-rolled-back')],
        toolTitles: [{ sessionId: 's-rolled-back', title: 'never' }],
        outcomes: [outcome('s-rolled-back', true)],
        kgEntities: [{ name: 'rolled-back-entity', type: 'tool', properties: {} }],
        kgTriples: [{ subject: 'rolled-back-entity', predicate: 'uses', object: 'nothing' }],
      });
      throw new Error(LATER_STEP_FAILED);
    }))).rejects.toThrow(LATER_STEP_FAILED);
    expect({
      outcomes: await count('session_outcome_cache'), triples: await count('kg_triples'),
      entities: await count('kg_entities'), meta: await count('session_metadata'),
    }).toEqual(before);
  });
});
