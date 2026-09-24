import { currentTenant, currentAuthor } from './tenant-context.js';
/**
 * Async driver for the temporal knowledge graph (knowledge_graph.db, a
 * separate SQLite file from cache.db). Same pattern as StorageDriver:
 * interface derived from the class, SQLite wrapper, Postgres stub (P1 will
 * back it with tables + pgvector for entity embeddings). Bound to the same
 * `storage` flag.
 */

import type { KnowledgeGraph } from '../knowledge-graph.js';
import { resolveBackend, type CreateStoreOptions } from './index.js';
import { openPgPool, openPgPoolRo, ensurePgSchema, pgTenant, tenantQuery } from './pg-pool.js';
import { normalizeKgDate, resolveValidFrom, kgToday, kgDay } from '../kg-dates.js';
import { createHash, randomBytes } from 'crypto';

type AsyncMethod<M> = M extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

export interface KnowledgeGraphDriver {
  addEntity: AsyncMethod<KnowledgeGraph['addEntity']>;
  addTriple: AsyncMethod<KnowledgeGraph['addTriple']>;
  importTriple: AsyncMethod<KnowledgeGraph['importTriple']>;
  /** Import many at once. See PgKnowledgeGraph.importTriples for why. */
  importTriples(ts: Parameters<KnowledgeGraph['importTriple']>[0][]): Promise<{ inserted: number; exists: number }>;
  invalidate: AsyncMethod<KnowledgeGraph['invalidate']>;
  queryEntity: AsyncMethod<KnowledgeGraph['queryEntity']>;
  queryRelationship: AsyncMethod<KnowledgeGraph['queryRelationship']>;
  timeline: AsyncMethod<KnowledgeGraph['timeline']>;
  stats: AsyncMethod<KnowledgeGraph['stats']>;
  listEntities: AsyncMethod<KnowledgeGraph['listEntities']>;
  close: AsyncMethod<KnowledgeGraph['close']>;
}

type Args<M extends keyof KnowledgeGraph> = KnowledgeGraph[M] extends (...a: infer A) => any ? A : never;

export class SqliteKnowledgeGraph implements KnowledgeGraphDriver {
  readonly inner: KnowledgeGraph;
  constructor(inner: KnowledgeGraph) { this.inner = inner; }

  async addEntity(...a: Args<'addEntity'>) { return this.inner.addEntity(...a); }
  async addTriple(...a: Args<'addTriple'>) { return this.inner.addTriple(...a); }
  async importTriple(...a: Args<'importTriple'>) { return this.inner.importTriple(...a); }
  async importTriples(ts: Args<'importTriple'>[0][]) {
    let inserted = 0, exists = 0;
    for (const t of ts) (this.inner.importTriple(t) === 'inserted') ? inserted++ : exists++;
    return { inserted, exists };
  }
  async invalidate(...a: Args<'invalidate'>) { return this.inner.invalidate(...a); }
  async queryEntity(...a: Args<'queryEntity'>) { return this.inner.queryEntity(...a); }
  async queryRelationship(...a: Args<'queryRelationship'>) { return this.inner.queryRelationship(...a); }
  async timeline(...a: Args<'timeline'>) { return this.inner.timeline(...a); }
  async stats(...a: Args<'stats'>) { return this.inner.stats(...a); }
  async listEntities(...a: Args<'listEntities'>) { return this.inner.listEntities(...a); }
  async close(...a: Args<'close'>) { return this.inner.close(...a); }
}

/** Run one statement and return its rows. */
export type KgExec = (sql: string, params: unknown[]) => Promise<any[]>;

/** The id an entity name is stored under. */
export function kgEntityId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_');
}

/**
 * A surrogate id for one triple row. Uniqueness is all it carries — the
 * LOGICAL key is (subject, predicate, object, valid_from, valid_to), and that
 * is what the indexes enforce.
 *
 * The entropy is random. `Date.now()` has millisecond
 * resolution and a batch insert builds far more than one row per millisecond,
 * so two rows in the same batch computed the same id and the second was
 * dropped by ON CONFLICT DO NOTHING. Caught by the two-validity-windows case
 * in kg-live-key.test.ts, which stored one row where it asserted two.
 */
function kgTripleId(subject: string, predicate: string, object: string): string {
  const hash = createHash('sha256')
    .update(`${subject}|${predicate}|${object}|${Date.now()}|${randomBytes(8).toString('hex')}`)
    .digest('hex').slice(0, 12);
  return `t_${kgEntityId(subject)}_${predicate}_${kgEntityId(object)}_${hash}`;
}

/**
 * Upsert many entities in one statement.
 *
 * kg_entities has no per-member SELECT gate (see pg-schema: shared tenant
 * vocabulary), so this upsert is safe for named members. DO UPDATE keeps
 * type/properties refreshed as extraction improves. Two entries with the same
 * id collapse to the later one, which is what writing them in order leaves.
 */
export async function upsertKgEntities(
  exec: KgExec, tenant: string,
  entities: Array<{ name: string; type?: string | null; properties?: Record<string, unknown> | null }>,
): Promise<void> {
  const byId = new Map<string, { name: string; type: string; properties: string }>();
  for (const e of entities) {
    byId.set(kgEntityId(e.name), { name: e.name, type: e.type ?? 'unknown', properties: JSON.stringify(e.properties ?? {}) });
  }
  if (byId.size === 0) return;
  // Sorted by the conflict key, so two concurrent batches lock in the same order.
  const list = [...byId.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const vals: unknown[] = [tenant];
  const tuples = list.map(([id, e]) => {
    vals.push(id, e.name, e.type, e.properties);
    const n = vals.length;
    return `($1,$${n - 3},$${n - 2},$${n - 1},$${n})`;
  });
  await exec(
    `INSERT INTO kg_entities (tenant,id,name,type,properties) VALUES ${tuples.join(',')}
     ON CONFLICT (tenant,id) DO UPDATE SET name=excluded.name, type=excluded.type, properties=excluded.properties`,
    vals);
}

/**
 * Import many triples in three queries for each 500.
 *
 * `importTriple` costs four sequential round trips: two entity upserts, a
 * lookup, an insert. The sync route called it in a loop, so one user syncing
 * 5905 triples issued ~23600 queries in sequence, each one a hop to the
 * pooler and back while holding a pooled connection for the whole request.
 * With PG_POOL_MAX at 20 per process and the deployment scaling to six pods,
 * that demands 120 server connections from a pooler configured for 20, and
 * everything else queues behind it until PgBouncer's 120s limit cuts it off —
 * which is what a 124997 ms ingest request is.
 *
 * Three queries per chunk: upsert the distinct entities, ask which triples
 * already exist, insert the rest. Chunked because Postgres takes at most
 * 65535 bind parameters per statement.
 *
 * `read` runs the existence lookup. The driver sends it to the replica; the
 * ingest runs it on its own transaction, whose writes the replica cannot see.
 */
export async function importKgTriples(
  exec: KgExec, read: KgExec, tenant: string,
  ts: Parameters<KnowledgeGraph['importTriple']>[0][],
): Promise<{ inserted: number; exists: number }> {
  let inserted = 0, exists = 0;
  const CHUNK = 500;
  for (let i = 0; i < ts.length; i += CHUNK) {
    const chunk = ts.slice(i, i + CHUNK);
    const rows = chunk.map((t) => ({
      t,
      sub: kgEntityId(t.subject),
      obj: kgEntityId(t.object),
      pred: t.predicate.toLowerCase().replace(/\s+/g, '_'),
      vf: t.valid_from ?? '',
      vt: t.valid_to ?? '',
    }));

    // 1. Entities. Distinct by id, because the same subject repeats across a
    //    batch and a duplicate inside one INSERT would conflict with itself.
    const ents = new Map<string, string>();
    for (const r of rows) { ents.set(r.sub, r.t.subject); ents.set(r.obj, r.t.object); }
    if (ents.size) {
      const vals: unknown[] = [tenant];
      const tuples = [...ents].map(([id, name]) => {
        vals.push(id, name);
        return `($1, $${vals.length - 1}, $${vals.length})`;
      });
      await exec(`INSERT INTO kg_entities (tenant,id,name) VALUES ${tuples.join(',')} ON CONFLICT (tenant,id) DO NOTHING`, vals);
    }

    // 2. Which of these already exist, matched on the same key importTriple
    //    uses — so a re-sync still inserts nothing.
    const seekVals: unknown[] = [tenant];
    const seekTuples = rows.map((r) => {
      seekVals.push(r.sub, r.pred, r.obj, r.vf, r.vt);
      const n = seekVals.length;
      return `($${n - 4}::text,$${n - 3}::text,$${n - 2}::text,$${n - 1}::text,$${n}::text)`;
    });
    const found = await read(
      `SELECT v.s, v.p, v.o, v.vf, v.vt FROM (VALUES ${seekTuples.join(',')}) AS v(s,p,o,vf,vt)
       WHERE EXISTS (SELECT 1 FROM kg_triples t WHERE t.tenant=$1
         AND t.subject=v.s AND t.predicate=v.p AND t.object=v.o
         AND COALESCE(t.valid_from,'')=v.vf AND COALESCE(t.valid_to,'')=v.vt)`,
      seekVals);
    const already = new Set(found.map((r: any) => [r.s, r.p, r.o, r.vf, r.vt].join('\u0000')));

    // 3. Insert what is left, in one statement. A triple that repeats inside
    //    the batch is inserted once: the second copy violated kg_triples_live_key
    //    and failed the whole statement.
    const fresh: typeof rows = [];
    for (const r of rows) {
      const key = [r.sub, r.pred, r.obj, r.vf, r.vt].join('\u0000');
      if (already.has(key)) continue;
      already.add(key);
      fresh.push(r);
    }
    exists += rows.length - fresh.length;
    if (fresh.length) {
      const author = currentAuthor().sub;
      const insVals: unknown[] = [tenant];
      const insTuples: string[] = [];
      for (const r of fresh) {
        const id = kgTripleId(r.t.subject, r.pred, r.t.object);
        insVals.push(id, r.sub, r.pred, r.obj, r.t.valid_from ?? null, r.t.valid_to ?? null,
          r.t.confidence ?? 1.0, r.t.source_session ?? null, author);
        const n = insVals.length;
        insTuples.push(`($1,$${n - 8},$${n - 7},$${n - 6},$${n - 5},$${n - 4},$${n - 3},$${n - 2},$${n - 1},NULL,$${n})`);
      }
      await exec(
        `INSERT INTO kg_triples (tenant,id,subject,predicate,object,valid_from,valid_to,confidence,source_session,source_file,author_sub)
         VALUES ${insTuples.join(',')} ON CONFLICT (tenant,id) DO NOTHING`, insVals);
      inserted += fresh.length;
    }
  }
  return { inserted, exists };
}

export class PgKnowledgeGraph implements KnowledgeGraphDriver {
  private pool: any;
  private poolRo: any;
  private readonly t: string;
  constructor(private readonly databaseUrl?: string, tenant?: string) { this.t = pgTenant(tenant); }
  async init(): Promise<void> { this.pool = await openPgPool(this.databaseUrl); this.poolRo = await openPgPoolRo(); await ensurePgSchema(this.databaseUrl); }
  private async q(sql: string, params: unknown[] = []): Promise<any[]> { return (await tenantQuery(this.pool, this.t, sql, params)).rows; }
  // Read-replica variant for pure KG read/query methods (display-only,
  // lag-tolerant). Falls back to the primary pool when no RO DSN is configured.
  // NOT used by the write methods (addTriple/importTriple read-before-write).
  private async qRo(sql: string, params: unknown[] = []): Promise<any[]> { return (await tenantQuery(this.poolRo, this.t, sql, params)).rows; }

  private entityId(name: string): string { return kgEntityId(name); }

  async addEntity(...a: Args<'addEntity'>) {
    const [name, entityType, properties] = a;
    await upsertKgEntities((sql, p) => this.q(sql, p), this.t, [{ name, type: entityType, properties }]);
    return this.entityId(name);
  }

  async addTriple(...a: Args<'addTriple'>) {
    const [subject, predicate, object, options = {}] = a;
    const subId = this.entityId(subject); const objId = this.entityId(object);
    const pred = predicate.toLowerCase().replace(/\s+/g, '_');
    await this.q(`INSERT INTO kg_entities (tenant,id,name) VALUES ($1,$2,$3) ON CONFLICT (tenant,id) DO NOTHING`, [this.t, subId, subject]);
    await this.q(`INSERT INTO kg_entities (tenant,id,name) VALUES ($1,$2,$3) ON CONFLICT (tenant,id) DO NOTHING`, [this.t, objId, object]);
    const existing = (await this.q(`SELECT id FROM kg_triples WHERE tenant=$1 AND subject=$2 AND predicate=$3 AND object=$4 AND valid_to IS NULL`, [this.t, subId, pred, objId]))[0];
    if (existing) return existing.id;
    // An asserted fact with no date given starts today — see resolveValidFrom.
    const validFrom = resolveValidFrom(options.validFrom, options.origin);
    const validTo = normalizeKgDate(options.validTo);
    // Supersede a contradictory active fact (same subject+predicate, different
    // object) — see the sqlite reference impl. Opt-in via options.supersede.
    if (options.supersede) {
      const asOf = validFrom || kgToday();
      await this.q(`UPDATE kg_triples SET valid_to=$5 WHERE tenant=$1 AND subject=$2 AND predicate=$3 AND object<>$4 AND valid_to IS NULL`,
        [this.t, subId, pred, objId, asOf]);
    }
    const id = kgTripleId(subject, pred, object);
    await this.q(
      `INSERT INTO kg_triples (tenant,id,subject,predicate,object,valid_from,valid_to,confidence,source_session,source_file,origin,author_sub) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [this.t, id, subId, pred, objId, validFrom, validTo, options.confidence ?? 1.0, options.sourceSession || null, options.sourceFile || null, options.origin || 'extracted', currentAuthor().sub]);
    return id;
  }

  async importTriple(...a: Args<'importTriple'>) {
    const [t] = a;
    const subId = this.entityId(t.subject); const objId = this.entityId(t.object);
    const pred = t.predicate.toLowerCase().replace(/\s+/g, '_');
    await this.q(`INSERT INTO kg_entities (tenant,id,name) VALUES ($1,$2,$3) ON CONFLICT (tenant,id) DO NOTHING`, [this.t, subId, t.subject]);
    await this.q(`INSERT INTO kg_entities (tenant,id,name) VALUES ($1,$2,$3) ON CONFLICT (tenant,id) DO NOTHING`, [this.t, objId, t.object]);
    const existing = (await this.q(
      `SELECT id FROM kg_triples WHERE tenant=$1 AND subject=$2 AND predicate=$3 AND object=$4 AND COALESCE(valid_from,'')=$5 AND COALESCE(valid_to,'')=$6`,
      [this.t, subId, pred, objId, t.valid_from ?? '', t.valid_to ?? '']))[0];
    if (existing) return 'exists' as const;
    const id = kgTripleId(t.subject, pred, t.object);
    await this.q(
      `INSERT INTO kg_triples (tenant,id,subject,predicate,object,valid_from,valid_to,confidence,source_session,source_file,author_sub) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10)`,
      [this.t, id, subId, pred, objId, t.valid_from ?? null, t.valid_to ?? null, t.confidence ?? 1.0, t.source_session ?? null, currentAuthor().sub]);
    return 'inserted' as const;
  }

  /** See importKgTriples. */
  async importTriples(ts: Args<'importTriple'>[0][]) {
    return importKgTriples((sql, p) => this.q(sql, p), (sql, p) => this.qRo(sql, p), this.t, ts);
  }

  async invalidate(...a: Args<'invalidate'>) {
    const [subject, predicate, object, ended] = a;
    const subId = this.entityId(subject); const objId = this.entityId(object);
    const pred = predicate.toLowerCase().replace(/\s+/g, '_');
    const endDate = ended || new Date().toISOString().split('T')[0];
    const r = await tenantQuery(this.pool, this.t, `UPDATE kg_triples SET valid_to=$5 WHERE tenant=$1 AND subject=$2 AND predicate=$3 AND object=$4 AND valid_to IS NULL`, [this.t, subId, pred, objId, endDate]);
    return r.rowCount || 0;
  }

  async queryEntity(...a: Args<'queryEntity'>) {
    const [name, asOf, direction = 'both'] = a;
    const eid = this.entityId(name);
    const results: any[] = [];
    const asOfClause = asOf ? ` AND (t.valid_from IS NULL OR t.valid_from <= $3) AND (t.valid_to IS NULL OR t.valid_to >= $3)` : '';
    if (direction === 'outgoing' || direction === 'both') {
      const params = asOf ? [this.t, eid, asOf] : [this.t, eid];
      const rows = await this.qRo(`SELECT t.*, e.name AS obj_name FROM kg_triples t JOIN kg_entities e ON e.tenant=t.tenant AND t.object=e.id WHERE t.tenant=$1 AND t.subject=$2${asOfClause}`, params);
      for (const row of rows) results.push({ direction: 'outgoing', subject: name, predicate: row.predicate, object: row.obj_name, valid_from: row.valid_from, valid_to: row.valid_to, confidence: row.confidence, source_session: row.source_session, current: row.valid_to === null, recorded_at: kgDay(row.extracted_at) });
    }
    if (direction === 'incoming' || direction === 'both') {
      const params = asOf ? [this.t, eid, asOf] : [this.t, eid];
      const rows = await this.qRo(`SELECT t.*, e.name AS sub_name FROM kg_triples t JOIN kg_entities e ON e.tenant=t.tenant AND t.subject=e.id WHERE t.tenant=$1 AND t.object=$2${asOfClause}`, params);
      for (const row of rows) results.push({ direction: 'incoming', subject: row.sub_name, predicate: row.predicate, object: name, valid_from: row.valid_from, valid_to: row.valid_to, confidence: row.confidence, source_session: row.source_session, current: row.valid_to === null, recorded_at: kgDay(row.extracted_at) });
    }
    return results;
  }

  async queryRelationship(...a: Args<'queryRelationship'>) {
    const [predicate, asOf] = a;
    const pred = predicate.toLowerCase().replace(/\s+/g, '_');
    const asOfClause = asOf ? ` AND (t.valid_from IS NULL OR t.valid_from <= $3) AND (t.valid_to IS NULL OR t.valid_to >= $3)` : '';
    const params = asOf ? [this.t, pred, asOf] : [this.t, pred];
    const rows = await this.qRo(`SELECT t.*, s.name AS sub_name, o.name AS obj_name FROM kg_triples t JOIN kg_entities s ON s.tenant=t.tenant AND t.subject=s.id JOIN kg_entities o ON o.tenant=t.tenant AND t.object=o.id WHERE t.tenant=$1 AND t.predicate=$2${asOfClause}`, params);
    return rows.map(row => ({ direction: 'outgoing' as const, subject: row.sub_name, predicate: pred, object: row.obj_name, valid_from: row.valid_from, valid_to: row.valid_to, confidence: row.confidence, source_session: row.source_session, current: row.valid_to === null, recorded_at: kgDay(row.extracted_at), author_sub: row.author_sub ?? null }));
  }

  async timeline(...a: Args<'timeline'>) {
    const [entityName, limit = 100] = a;
    let rows: any[];
    if (entityName) {
      const eid = this.entityId(entityName);
      rows = await this.qRo(`SELECT t.*, s.name AS sub_name, o.name AS obj_name FROM kg_triples t JOIN kg_entities s ON s.tenant=t.tenant AND t.subject=s.id JOIN kg_entities o ON o.tenant=t.tenant AND t.object=o.id WHERE t.tenant=$1 AND (t.subject=$2 OR t.object=$2) ORDER BY t.valid_from ASC NULLS LAST LIMIT $3`, [this.t, eid, limit]);
    } else {
      rows = await this.qRo(`SELECT t.*, s.name AS sub_name, o.name AS obj_name FROM kg_triples t JOIN kg_entities s ON s.tenant=t.tenant AND t.subject=s.id JOIN kg_entities o ON o.tenant=t.tenant AND t.object=o.id WHERE t.tenant=$1 ORDER BY t.valid_from ASC NULLS LAST LIMIT $2`, [this.t, limit]);
    }
    return rows.map(r => ({ subject: r.sub_name, predicate: r.predicate, object: r.obj_name, valid_from: r.valid_from, valid_to: r.valid_to, current: r.valid_to === null, confidence: r.confidence ?? 1.0, origin: r.origin ?? 'extracted' }));
  }

  async stats(..._a: Args<'stats'>) {
    const entities = (await this.qRo(`SELECT COUNT(*)::int AS cnt FROM kg_entities WHERE tenant=$1`, [this.t]))[0].cnt;
    const triples = (await this.qRo(`SELECT COUNT(*)::int AS cnt FROM kg_triples WHERE tenant=$1`, [this.t]))[0].cnt;
    const current = (await this.qRo(`SELECT COUNT(*)::int AS cnt FROM kg_triples WHERE tenant=$1 AND valid_to IS NULL`, [this.t]))[0].cnt;
    const predicates = (await this.qRo(`SELECT DISTINCT predicate FROM kg_triples WHERE tenant=$1 ORDER BY predicate`, [this.t])).map(r => r.predicate);
    return { entities, triples, current_facts: current, expired_facts: triples - current, relationship_types: predicates };
  }

  async listEntities(...a: Args<'listEntities'>) {
    const [limit = 100] = a;
    const rows = await this.qRo(`SELECT id, name, type, properties, created_at FROM kg_entities WHERE tenant=$1 ORDER BY created_at DESC LIMIT $2`, [this.t, limit]);
    return rows.map(r => ({ ...r, properties: JSON.parse(r.properties) }));
  }

  async close(..._a: Args<'close'>) { /* shared pool — see pg-pool.ts closePgPools */ }
}

export async function createKnowledgeGraph(opts: CreateStoreOptions = {}): Promise<KnowledgeGraphDriver> {
  if (resolveBackend(opts) === 'postgres') {
    const store = new PgKnowledgeGraph(opts.databaseUrl, opts.tenant ?? currentTenant());
    await store.init();
    return store;
  }
  const { KnowledgeGraph } = await import('../knowledge-graph.js');
  // KG uses its own db path (knowledge_graph.db); sqlitePath override is for tests.
  return new SqliteKnowledgeGraph(new KnowledgeGraph(opts.sqlitePath));
}
