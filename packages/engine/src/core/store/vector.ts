import { currentTenant } from './tenant-context.js';
import { tenantQuery, tenantTx, openPgPoolRo } from './pg-pool.js';
/**
 * VectorStore driver — abstracts the embedding/vector layer behind the same
 * storage flag as the relational stores.
 *
 *   storage: sqlite   → LanceVectorStore  — wraps MemoryIndex (LanceDB file)
 *   storage: postgres → PgVectorStore      — pgvector (stub until P1)
 *
 * MemoryIndex already does the LanceDB work and is async; LanceVectorStore is
 * a thin wrapper so the few sync methods (needsUpdate/getHealth) also satisfy
 * the all-async interface, exactly like SqliteStore wraps MemoryStore.
 *
 * NOTE: MemoryIndex internally instantiates MemoryStore for the FTS half;
 * that coupling is migrated to the StorageDriver in P0.10, independent of
 * this vector abstraction.
 */

import { MemoryIndex } from '../memory-index.js';
import { resolveBackend, type CreateStoreOptions } from './index.js';
import { resolveProjectId } from '../project-resolver.js';
import type { MemorySearchResult } from '../../types/memory.js';
import { createLogger } from '../logger.js';

const log = createLogger('vector');

type AsyncMethod<M> = M extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

type Embedder = ConstructorParameters<typeof MemoryIndex>[0];

export interface VectorStore {
  connect: AsyncMethod<MemoryIndex['connect']>;
  needsUpdate: AsyncMethod<MemoryIndex['needsUpdate']>;
  addChunks: AsyncMethod<MemoryIndex['addChunks']>;
  bufferChunks: AsyncMethod<MemoryIndex['bufferChunks']>;
  flushBuffer: AsyncMethod<MemoryIndex['flushBuffer']>;
  deleteItem: AsyncMethod<MemoryIndex['deleteItem']>;
  deleteSourceType: AsyncMethod<MemoryIndex['deleteSourceType']>;
  optimize: AsyncMethod<MemoryIndex['optimize']>;
  search: AsyncMethod<MemoryIndex['search']>;
  getHealth: AsyncMethod<MemoryIndex['getHealth']>;
  getStats: AsyncMethod<MemoryIndex['getStats']>;
  clear: AsyncMethod<MemoryIndex['clear']>;
}

type Args<M extends keyof MemoryIndex> = MemoryIndex[M] extends (...a: infer A) => any ? A : never;

export class LanceVectorStore implements VectorStore {
  readonly inner: MemoryIndex;
  constructor(inner: MemoryIndex) { this.inner = inner; }

  async connect(...a: Args<'connect'>) { return this.inner.connect(...a); }
  async needsUpdate(...a: Args<'needsUpdate'>) { return this.inner.needsUpdate(...a); }
  async addChunks(...a: Args<'addChunks'>) { return this.inner.addChunks(...a); }
  async bufferChunks(...a: Args<'bufferChunks'>) { return this.inner.bufferChunks(...a); }
  async flushBuffer(...a: Args<'flushBuffer'>) { return this.inner.flushBuffer(...a); }
  async deleteItem(...a: Args<'deleteItem'>) { return this.inner.deleteItem(...a); }
  async deleteSourceType(...a: Args<'deleteSourceType'>) { return this.inner.deleteSourceType(...a); }
  async optimize(...a: Args<'optimize'>) { return this.inner.optimize(...a); }
  async search(...a: Args<'search'>) { return this.inner.search(...a); }
  async getHealth(...a: Args<'getHealth'>) { return this.inner.getHealth(...a); }
  async getStats(...a: Args<'getStats'>) { return this.inner.getStats(...a); }
  async clear(...a: Args<'clear'>) { return this.inner.clear(...a); }
}

/**
 * Postgres + pgvector vector store. Degrades gracefully: with no embedder
 * (or no `vector` extension) it stores chunk rows but skips embeddings and
 * returns no semantic hits — keyword (FTS) search via PgStore still works, so
 * the app never breaks on Postgres for lack of an embedder.
 */
export class PgVectorStore implements VectorStore {
  private pool: any;
  private poolRo: any;
  private readonly t: string;
  private vectorOk = false;
  // Whether the `memory_vectors` table exists and is usable. Distinct from
  // `vectorOk` (which also requires an embedder): when the `pgvector`
  // extension is unavailable the table can't be created, so every vector op
  // must no-op and indexing falls back to FTS — the documented FTS-first path.
  private tableReady = false;
  private lastError: string | null = null;
  private buffer: import('../../types/memory.js').MemoryChunk[] = [];
  private dim = 768;
  // FTS half of the store. The LanceDB path bundles FTS + vector inside
  // MemoryIndex.addChunks; PgVectorStore must mirror that so `memory_chunks`
  // (tsvector) is populated even when pgvector is unavailable. Delegated to a
  // PgStore so the exact addChunksFTS/deleteItemFTS logic is reused verbatim.
  private fts: import('./pg.js').PgStore | null = null;

  constructor(private readonly embedder: Embedder, private readonly databaseUrl?: string, tenant?: string) {
    this.t = tenant || process.env.CHAT_RECALL_TENANT || 'default';
    if (embedder && (embedder as any).dimension) this.dim = (embedder as any).dimension;
  }

  async init(): Promise<void> {
    const { openPgPool, ensurePgSchema } = await import('./pg-pool.js');
    this.pool = await openPgPool(this.databaseUrl);
    this.poolRo = await openPgPoolRo();
    await ensurePgSchema(this.databaseUrl);
    // FTS store shares the pooled connection (openPgPool caches per URL) and
    // creates/owns the `memory_chunks` table in its own init().
    const { PgStore } = await import('./pg.js');
    this.fts = new PgStore(this.databaseUrl, this.t);
    await this.fts.init();
    try {
      await this.pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      // Self-heal dimension drift: the table is created with the embedder's
      // configured dimension, so an embedder/model swap (e.g. 768 → 1024)
      // leaves CREATE IF NOT EXISTS silently keeping the old width — every
      // insert then fails forever. Vectors are derived data (the sweep refills
      // them from memory_chunks), so on mismatch we drop and recreate at the
      // configured width instead of requiring a hand-run migration. Old-model
      // vectors would be a different vector space anyway — unusable for
      // similarity against new-model query embeddings, not worth preserving.
      const dimRow = await this.pool.query(
        `SELECT atttypmod AS dim FROM pg_attribute
          WHERE attrelid = to_regclass('memory_vectors') AND attname = 'embedding'`);
      const existingDim = dimRow.rows[0]?.dim;
      if (existingDim != null && existingDim > 0 && existingDim !== this.dim) {
        const n = await this.pool.query(`SELECT count(*)::int AS c FROM memory_vectors`);
        console.warn(`[vector] memory_vectors is vector(${existingDim}) but embedder is ${this.dim}-dim — dropping ${n.rows[0].c} stale vector(s) and recreating; the backfill sweep re-embeds from memory_chunks`);
        await this.pool.query(`DROP TABLE memory_vectors`);
      }
      await this.pool.query(
        `CREATE TABLE IF NOT EXISTS memory_vectors (
           tenant TEXT NOT NULL DEFAULT 'default', chunk_id TEXT NOT NULL, item_id TEXT NOT NULL,
           source_type TEXT NOT NULL, title TEXT DEFAULT '', text TEXT DEFAULT '', chunk_type TEXT DEFAULT '',
           project_path TEXT DEFAULT '', project_id TEXT DEFAULT '', file_path TEXT DEFAULT '', mtime BIGINT DEFAULT 0,
           embedding vector(${this.dim}), PRIMARY KEY (tenant, chunk_id))`);
      await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_vec_item ON memory_vectors(tenant, source_type, item_id)`);
      // RLS: memory_vectors lives outside pg-schema.ts, so wall it here too.
      await this.pool.query(`ALTER TABLE memory_vectors ENABLE ROW LEVEL SECURITY`);
      await this.pool.query(`ALTER TABLE memory_vectors FORCE ROW LEVEL SECURITY`);
      await this.pool.query(`DROP POLICY IF EXISTS tenant_isolation ON memory_vectors`);
      await this.pool.query(`CREATE POLICY tenant_isolation ON memory_vectors USING (tenant = current_setting('app.tenant', true)) WITH CHECK (tenant = current_setting('app.tenant', true))`);
      this.tableReady = true;
      this.vectorOk = !!this.embedder;
    } catch (e) {
      // Most common cause: the `pgvector` extension isn't installed on this
      // server. Leave tableReady/vectorOk false so the store no-ops and the
      // caller indexes via FTS instead of hard-failing every item.
      this.lastError = e instanceof Error ? e.message : String(e);
      this.tableReady = false;
      this.vectorOk = false;
    }
  }

  private q(sql: string, params: unknown[] = []) { return tenantQuery(this.pool, this.t, sql, params).then((r: any) => r.rows); }
  // Read-replica variant for pure, lag-tolerant SELECTs (vector similarity
  // search, status aggregations). Falls back to the primary pool when no RO DSN
  // is configured. NEVER for needsUpdate freshness in the index/embed write flow
  // or the embedMissing SKIP-LOCKED claim — those must stay on the primary.
  private qRo(sql: string, params: unknown[] = []) { return tenantQuery(this.poolRo, this.t, sql, params).then((r: any) => r.rows); }
  private vecLiteral(v: number[]) { return `[${v.join(',')}]`; }
  // memory_vectors.mtime is BIGINT; stat.mtimeMs is fractional. Floor to whole
  // ms at every bind/compare (same rationale as store/pg.ts `intMs`).
  private intMs(x: unknown): number { return Math.floor(Number(x) || 0); }

  async connect(): Promise<void> { /* pool opened in init() */ }

  async needsUpdate(...a: Args<'needsUpdate'>) {
    if (!this.tableReady) return true;
    const [sourceType, itemId, mtime] = a;
    const r = (await this.q(`SELECT MAX(mtime) AS m FROM memory_vectors WHERE tenant=$1 AND source_type=$2 AND item_id=$3`, [this.t, sourceType, itemId]))[0];
    return r?.m == null || r.m < this.intMs(mtime);
  }

  async addChunks(...a: Args<'addChunks'>) {
    const [chunks] = a;
    const valid = chunks.filter(c => c.text && c.text.trim().length > 0);
    if (valid.length === 0) return 0;
    // FTS first — always, exactly like MemoryIndex.addChunks. This is what
    // makes keyword search work in pg mode regardless of pgvector.
    if (this.fts) await this.fts.addChunksFTS(valid);
    if (!this.tableReady) return valid.length;
    const items = new Map<string, { s: string; i: string }>();
    for (const c of valid) items.set(`${c.sourceType}:${c.itemId}`, { s: c.sourceType, i: c.itemId });
    for (const { s, i } of items.values()) await this.q(`DELETE FROM memory_vectors WHERE tenant=$1 AND source_type=$2 AND item_id=$3`, [this.t, s, i]);
    let embeddings: number[][] | null = null;
    if (this.embedder && this.vectorOk) {
      try { embeddings = await (this.embedder as any).embed(valid.map(c => c.text)); }
      catch (e) { this.lastError = e instanceof Error ? e.message : String(e); embeddings = null; }
    }
    for (let k = 0; k < valid.length; k++) {
      const c = valid[k];
      const emb = embeddings?.[k];
      const resolved = c.projectPath ? resolveProjectId(c.projectPath) : null;
      const pid = resolved && resolved.source !== 'ignored' ? resolved.id : '';
      await this.q(
        `INSERT INTO memory_vectors (tenant,chunk_id,item_id,source_type,title,text,chunk_type,project_path,project_id,file_path,mtime,embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${emb ? `$12::vector` : 'NULL'})
         ON CONFLICT (tenant,chunk_id) DO UPDATE SET text=excluded.text, embedding=excluded.embedding`,
        emb ? [this.t, c.chunkId, c.itemId, c.sourceType, c.title, c.text, c.chunkType, c.projectPath, pid, c.filePath, this.intMs(c.mtime), this.vecLiteral(emb)]
            : [this.t, c.chunkId, c.itemId, c.sourceType, c.title, c.text, c.chunkType, c.projectPath, pid, c.filePath, this.intMs(c.mtime)]);
    }
    return valid.length;
  }

  // Auto-flush at the same threshold as MemoryIndex (200). Without it a large
  // source buffers all its chunks into one giant addChunks → one massive
  // sequential embed call; flushing in batches keeps embed latency bounded.
  private static readonly FLUSH_THRESHOLD = 200;
  async bufferChunks(...a: Args<'bufferChunks'>) {
    this.buffer.push(...a[0]);
    if (this.buffer.length >= PgVectorStore.FLUSH_THRESHOLD) await this.flushBuffer();
  }
  async flushBuffer(..._a: Args<'flushBuffer'>) {
    if (this.buffer.length === 0) return 0;
    const n = await this.addChunks(this.buffer);
    this.buffer = [];
    return n;
  }
  async deleteItem(...a: Args<'deleteItem'>) {
    // Delete FTS always (mirrors MemoryIndex.deleteItem), vector when present.
    if (this.fts) await this.fts.deleteItemFTS(a[0], a[1]);
    if (!this.tableReady) return;
    await this.q(`DELETE FROM memory_vectors WHERE tenant=$1 AND source_type=$2 AND item_id=$3`, [this.t, a[0], a[1]]);
  }
  async deleteSourceType(...a: Args<'deleteSourceType'>) {
    if (!this.tableReady) return;
    await this.q(`DELETE FROM memory_vectors WHERE tenant=$1 AND source_type=$2`, [this.t, a[0]]);
  }
  async optimize(..._a: Args<'optimize'>) { return { before: 0, after: 0, reclaimed: 0 } as any; }

  /**
   * Backfill embeddings for chunks that are in FTS (`memory_chunks`) but missing
   * from `memory_vectors` — the backlog created when the embedder was off, or
   * after a model switch. Embeds up to `limit` per call; returns how many were
   * embedded and how many were scanned (callers loop until scanned < limit).
   * Tenant-scoped via the same RLS context as every other store op. This is the
   * permanent mechanism behind the server's vector-backfill worker (no one-offs).
   */
  async embedMissing(limit = 200): Promise<{ embedded: number; scanned: number }> {
    if (!this.tableReady || !this.embedder || !this.vectorOk) return { embedded: 0, scanned: 0 };
    // WORK QUEUE via FOR UPDATE ... SKIP LOCKED. The whole claim→embed→insert
    // runs in ONE transaction: the SELECT locks a disjoint batch of un-embedded
    // chunks (SKIP LOCKED ⇒ a concurrent worker grabs a DIFFERENT batch, never
    // the same rows), the embed happens while the locks are held, the inserts
    // land, COMMIT releases the locks — and by then those rows have vectors so
    // they're never re-claimed. This makes the backfill safe to run on MANY
    // workers at once (chat-recall replicas) and across MANY tenants/customers
    // with zero duplicated embedding. Partial/failed rows just stay unlocked
    // without a vector and get claimed again on a later sweep.
    // Triage (same rule as the summary worker): skip TRIVIAL sessions — one-shot /
    // bot / automation runs. Embedding them wastes compute and pollutes semantic
    // search with noise nobody queries. Trivial = few turns AND little generated
    // output — turn count alone misclassifies subagent fan-outs (1 user turn,
    // tens of thousands of output tokens of real work). Generic (no hardcoded
    // patterns) and applies to source_type='session' only — plan/task/claude_md/
    // etc. chunks always embed. Both counters live in memory_metadata.extra_json.
    const minTurns = Math.max(0, Number(process.env.EMBED_MIN_TURNS ?? process.env.SUMMARY_MIN_TURNS) || 4);
    const maxTrivialOut = Math.max(0, Number(
      process.env.EMBED_TRIVIAL_MAX_OUTPUT_TOKENS ?? process.env.SUMMARY_TRIVIAL_MAX_OUTPUT_TOKENS) || 2000);
    return tenantTx(this.pool, this.t, async (client: any) => {
      const rows: any[] = (await client.query(
        `SELECT c.chunk_id, c.item_id, c.source_type, c.title, c.text, c.chunk_type, c.project_path, c.file_path, c.mtime
           FROM memory_chunks c
           WHERE c.tenant = $1 AND length(c.text) > 0
             AND NOT EXISTS (
               SELECT 1 FROM memory_vectors v WHERE v.tenant = c.tenant AND v.chunk_id = c.chunk_id)
             AND NOT (
               c.source_type = 'session'
               AND EXISTS (
                 SELECT 1 FROM memory_metadata m
                  WHERE m.tenant = c.tenant AND m.id = c.item_id AND m.source_type = 'session'
                    AND m.extra_json LIKE '{%'
                    AND COALESCE(NULLIF(m.extra_json::jsonb ->> 'messageCount', '')::int, 999) <= $3
                    AND COALESCE(NULLIF(m.extra_json::jsonb ->> 'outputTokens', '')::bigint, 0) < $4
               )
             )
           LIMIT $2
           FOR UPDATE OF c SKIP LOCKED`,
        [this.t, limit, minTurns, maxTrivialOut])).rows;
      if (rows.length === 0) return { embedded: 0, scanned: 0 };
      let embeddings: number[][] | null = null;
      try { embeddings = await (this.embedder as any).embed(rows.map((r: any) => r.text)); }
      catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        log.warn({ err: e, tenant: this.t, chunks: rows.length }, 'embedMissing: embed failed');
        return { embedded: 0, scanned: rows.length };
      }
      if (!embeddings) return { embedded: 0, scanned: rows.length };
      let n = 0;
      for (let k = 0; k < rows.length; k++) {
        const r = rows[k];
        const emb = embeddings[k];
        if (!emb) continue; // resilient embed left a hole — leave it for a later claim
        const resolved = r.project_path ? resolveProjectId(r.project_path) : null;
        const pid = resolved && resolved.source !== 'ignored' ? resolved.id : '';
        await client.query(
          `INSERT INTO memory_vectors (tenant,chunk_id,item_id,source_type,title,text,chunk_type,project_path,project_id,file_path,mtime,embedding)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::vector)
           ON CONFLICT (tenant,chunk_id) DO UPDATE SET text=excluded.text, embedding=excluded.embedding`,
          [this.t, r.chunk_id, r.item_id, r.source_type, r.title || '', r.text, r.chunk_type || '', r.project_path || '', pid, r.file_path || '', this.intMs(r.mtime), this.vecLiteral(emb)]);
        n++;
      }
      return { embedded: n, scanned: rows.length };
    });
  }

  async search(...a: Args<'search'>): Promise<MemorySearchResult[]> {
    const [query, options = {}] = a;
    const topK = (options as any).topK ?? 20;
    // FTS first — always — exactly like MemoryIndex.search: keyword hits are
    // never garbage, and they carry the result set when pgvector is absent.
    // Vector hits union in afterwards as additional context.
    let ftsResults: MemorySearchResult[] = [];
    if (this.fts) { try { ftsResults = await this.fts.searchFTS(query, options as any); } catch { ftsResults = []; } }
    if (!this.embedder || !this.vectorOk) return ftsResults;
    let qv: number[];
    try { qv = await (this.embedder as any).embedQuery(query); } catch { return ftsResults; }
    const params: unknown[] = [this.t, this.vecLiteral(qv)];
    let sql = `SELECT chunk_id, item_id, source_type, title, text, chunk_type, project_path, file_path, mtime,
                      1/(1+(embedding <=> $2::vector)) AS score
               FROM memory_vectors WHERE tenant=$1 AND embedding IS NOT NULL`;
    if ((options as any).sourceTypes?.length) { params.push((options as any).sourceTypes); sql += ` AND source_type = ANY($${params.length})`; }
    // Path SUBSTRING, not an exact project_id — see searchFTS (pg.ts). Keeps the
    // vector path consistent with FTS so `-p` filters identically either way.
    if ((options as any).projectIdFilter) { params.push(`%${(options as any).projectIdFilter}%`); sql += ` AND project_path ILIKE $${params.length}`; }
    // Same ranking posture as searchFTS (pg.ts): subagent chunks are
    // keyword/semantics-dense internal expansions — demoted so they never
    // bury the user's own conversations; a small bounded recency bonus makes
    // "when" a prior, not just a tiebreak. Age exponent clamped (LEAST(…, 60))
    // for the same reason as searchFTS: Postgres RAISES underflow for exp() of
    // a large negative, so one mtime=0 row would error every vector search.
    params.push(Date.now());
    const nowP = params.length;
    params.push(topK * 5);
    sql += ` ORDER BY (1/(1+(embedding <=> $2::vector)))
                      * (CASE WHEN chunk_type LIKE 'subagent%' THEN 0.55 ELSE 1.0 END)
                      + 0.15 * exp(-LEAST(GREATEST($${nowP}::double precision - COALESCE(mtime, 0), 0) / (14.0 * 86400000), 60)) DESC
             LIMIT $${params.length}`;
    const rows = await this.qRo(sql, params);
    // Group by item (best score wins), mirroring the FTS grouping.
    const byItem = new Map<string, any>();
    for (const r of rows) {
      const key = `${r.source_type}:${r.item_id}`;
      const score = Number(r.score) || 0;
      if (!byItem.has(key)) byItem.set(key, { itemId: r.item_id, sourceType: r.source_type, title: r.title, projectPath: r.project_path, filePath: r.file_path, mtime: r.mtime, chunks: [], bestScore: score });
      const it = byItem.get(key); it.chunks.push({ chunkType: r.chunk_type, text: r.text, score }); if (score > it.bestScore) it.bestScore = score;
    }
    const vectorResults: MemorySearchResult[] = [...byItem.values()].map(it => ({ itemId: it.itemId, sourceType: it.sourceType, title: it.title, text: it.chunks[0]?.text || '', score: it.bestScore, chunkType: it.chunks[0]?.chunkType || 'unknown', projectPath: it.projectPath, filePath: it.filePath, mtime: it.mtime, matchedChunks: it.chunks.slice(0, 3) }))
      .sort((a, b) => b.score - a.score);
    // Union: FTS hits keep their natural position, vector hits fill the rest.
    const seen = new Set(ftsResults.map(r => `${r.sourceType}:${r.itemId}`));
    const merged = [...ftsResults];
    for (const vr of vectorResults) {
      const key = `${vr.sourceType}:${vr.itemId}`;
      if (!seen.has(key)) { seen.add(key); merged.push(vr); }
    }
    return merged.slice(0, topK);
  }

  async getHealth(..._a: Args<'getHealth'>) {
    return { vectorOk: this.vectorOk, lastError: this.lastError, embedderConfigured: !!this.embedder };
  }
  async getStats(..._a: Args<'getStats'>) {
    // `totalChunks`/`totalItems` count the FTS table `memory_chunks`, NOT
    // `memory_vectors`. On the default deployment no embedder is configured, so
    // `memory_vectors` is empty even though search works off thousands of FTS
    // chunks — counting vectors made `/api/status` report `totalChunks: 0` while
    // data was fully searchable. `vectorOk`/`vectorError` still describe the
    // vector subsystem; the counts describe what's actually indexed and queryable.
    const totalChunks = (await this.qRo(`SELECT COUNT(*)::int AS n FROM memory_chunks WHERE tenant=$1`, [this.t]))[0]?.n ?? 0;
    const totalItems = (await this.qRo(`SELECT COUNT(DISTINCT item_id)::int AS n FROM memory_chunks WHERE tenant=$1`, [this.t]))[0]?.n ?? 0;
    const bySourceType: Record<string, { items: number; chunks: number }> = {};
    for (const r of await this.qRo(`SELECT source_type, COUNT(*)::int AS chunks, COUNT(DISTINCT item_id)::int AS items FROM memory_chunks WHERE tenant=$1 GROUP BY source_type`, [this.t]))
      bySourceType[r.source_type] = { items: r.items, chunks: r.chunks };
    return { totalChunks, totalItems, bySourceType, indexPath: 'postgres', vectorOk: this.vectorOk, vectorError: this.lastError ?? undefined } as any;
  }
  async clear(..._a: Args<'clear'>) { if (!this.tableReady) return; await this.q(`DELETE FROM memory_vectors WHERE tenant=$1`, [this.t]); }
}

export async function createVectorStore(
  embedder: Embedder,
  opts: CreateStoreOptions & { indexPath?: string } = {},
): Promise<VectorStore> {
  if (resolveBackend(opts) === 'postgres') {
    const store = new PgVectorStore(embedder, opts.databaseUrl, opts.tenant ?? currentTenant());
    await store.init();
    return store;
  }
  return new LanceVectorStore(new MemoryIndex(embedder, opts.indexPath));
}
