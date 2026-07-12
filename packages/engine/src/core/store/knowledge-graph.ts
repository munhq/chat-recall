import { currentTenant } from './tenant-context.js';
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

type AsyncMethod<M> = M extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

export interface KnowledgeGraphDriver {
  addEntity: AsyncMethod<KnowledgeGraph['addEntity']>;
  addTriple: AsyncMethod<KnowledgeGraph['addTriple']>;
  importTriple: AsyncMethod<KnowledgeGraph['importTriple']>;
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
  async invalidate(...a: Args<'invalidate'>) { return this.inner.invalidate(...a); }
  async queryEntity(...a: Args<'queryEntity'>) { return this.inner.queryEntity(...a); }
  async queryRelationship(...a: Args<'queryRelationship'>) { return this.inner.queryRelationship(...a); }
  async timeline(...a: Args<'timeline'>) { return this.inner.timeline(...a); }
  async stats(...a: Args<'stats'>) { return this.inner.stats(...a); }
  async listEntities(...a: Args<'listEntities'>) { return this.inner.listEntities(...a); }
  async close(...a: Args<'close'>) { return this.inner.close(...a); }
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

  private entityId(name: string): string { return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_'); }
  private async tripleId(subject: string, predicate: string, object: string): Promise<string> {
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(`${subject}|${predicate}|${object}|${Date.now()}`).digest('hex').slice(0, 12);
    return `t_${this.entityId(subject)}_${predicate}_${this.entityId(object)}_${hash}`;
  }

  async addEntity(...a: Args<'addEntity'>) {
    const [name, entityType, properties] = a;
    const eid = this.entityId(name);
    await this.q(
      `INSERT INTO kg_entities (tenant,id,name,type,properties) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant,id) DO UPDATE SET name=excluded.name, type=excluded.type, properties=excluded.properties`,
      [this.t, eid, name, entityType ?? 'unknown', JSON.stringify(properties ?? {})]);
    return eid;
  }

  async addTriple(...a: Args<'addTriple'>) {
    const [subject, predicate, object, options = {}] = a;
    const subId = this.entityId(subject); const objId = this.entityId(object);
    const pred = predicate.toLowerCase().replace(/\s+/g, '_');
    await this.q(`INSERT INTO kg_entities (tenant,id,name) VALUES ($1,$2,$3) ON CONFLICT (tenant,id) DO NOTHING`, [this.t, subId, subject]);
    await this.q(`INSERT INTO kg_entities (tenant,id,name) VALUES ($1,$2,$3) ON CONFLICT (tenant,id) DO NOTHING`, [this.t, objId, object]);
    const existing = (await this.q(`SELECT id FROM kg_triples WHERE tenant=$1 AND subject=$2 AND predicate=$3 AND object=$4 AND valid_to IS NULL`, [this.t, subId, pred, objId]))[0];
    if (existing) return existing.id;
    const { normalizeKgDate } = await import('../knowledge-graph.js');
    const validFrom = normalizeKgDate(options.validFrom);
    const validTo = normalizeKgDate(options.validTo);
    // Supersede a contradictory active fact (same subject+predicate, different
    // object) — see the sqlite reference impl. Opt-in via options.supersede.
    if (options.supersede) {
      const asOf = validFrom || new Date().toISOString().slice(0, 10);
      await this.q(`UPDATE kg_triples SET valid_to=$5 WHERE tenant=$1 AND subject=$2 AND predicate=$3 AND object<>$4 AND valid_to IS NULL`,
        [this.t, subId, pred, objId, asOf]);
    }
    const id = await this.tripleId(subject, pred, object);
    await this.q(
      `INSERT INTO kg_triples (tenant,id,subject,predicate,object,valid_from,valid_to,confidence,source_session,source_file,origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [this.t, id, subId, pred, objId, validFrom, validTo, options.confidence ?? 1.0, options.sourceSession || null, options.sourceFile || null, options.origin || 'extracted']);
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
    const id = await this.tripleId(t.subject, pred, t.object);
    await this.q(
      `INSERT INTO kg_triples (tenant,id,subject,predicate,object,valid_from,valid_to,confidence,source_session,source_file) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)`,
      [this.t, id, subId, pred, objId, t.valid_from ?? null, t.valid_to ?? null, t.confidence ?? 1.0, t.source_session ?? null]);
    return 'inserted' as const;
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
      for (const row of rows) results.push({ direction: 'outgoing', subject: name, predicate: row.predicate, object: row.obj_name, valid_from: row.valid_from, valid_to: row.valid_to, confidence: row.confidence, source_session: row.source_session, current: row.valid_to === null });
    }
    if (direction === 'incoming' || direction === 'both') {
      const params = asOf ? [this.t, eid, asOf] : [this.t, eid];
      const rows = await this.qRo(`SELECT t.*, e.name AS sub_name FROM kg_triples t JOIN kg_entities e ON e.tenant=t.tenant AND t.subject=e.id WHERE t.tenant=$1 AND t.object=$2${asOfClause}`, params);
      for (const row of rows) results.push({ direction: 'incoming', subject: row.sub_name, predicate: row.predicate, object: name, valid_from: row.valid_from, valid_to: row.valid_to, confidence: row.confidence, source_session: row.source_session, current: row.valid_to === null });
    }
    return results;
  }

  async queryRelationship(...a: Args<'queryRelationship'>) {
    const [predicate, asOf] = a;
    const pred = predicate.toLowerCase().replace(/\s+/g, '_');
    const asOfClause = asOf ? ` AND (t.valid_from IS NULL OR t.valid_from <= $3) AND (t.valid_to IS NULL OR t.valid_to >= $3)` : '';
    const params = asOf ? [this.t, pred, asOf] : [this.t, pred];
    const rows = await this.qRo(`SELECT t.*, s.name AS sub_name, o.name AS obj_name FROM kg_triples t JOIN kg_entities s ON s.tenant=t.tenant AND t.subject=s.id JOIN kg_entities o ON o.tenant=t.tenant AND t.object=o.id WHERE t.tenant=$1 AND t.predicate=$2${asOfClause}`, params);
    return rows.map(row => ({ direction: 'outgoing' as const, subject: row.sub_name, predicate: pred, object: row.obj_name, valid_from: row.valid_from, valid_to: row.valid_to, confidence: row.confidence, source_session: row.source_session, current: row.valid_to === null }));
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
