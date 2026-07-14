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

// Query-embedding cache — the same in-process, size-bounded Map pattern the
// server's QueryExpander uses (no Redis in this stack). A query→vector mapping
// is tenant-INDEPENDENT (same model + text ⇒ same embedding), so it's safe to
// share across tenants; keying includes the dimension so an embedder/model swap
// can't serve stale-space vectors. Kills the per-search GPU round-trip for
// repeated/near-repeated queries (the search box re-fires the same text often).
// Per-pod, which is fine: it only ever avoids an embed, never changes results.
const QUERY_EMBED_CACHE = new Map<string, number[]>();
const QUERY_EMBED_CACHE_MAX = Math.max(0, Number(process.env.QUERY_EMBED_CACHE_MAX) || 512);
function queryEmbedCacheGet(key: string): number[] | undefined {
  if (QUERY_EMBED_CACHE_MAX === 0) return undefined;
  const v = QUERY_EMBED_CACHE.get(key);
  if (v) { QUERY_EMBED_CACHE.delete(key); QUERY_EMBED_CACHE.set(key, v); } // LRU bump
  return v;
}
function queryEmbedCachePut(key: string, v: number[]): void {
  if (QUERY_EMBED_CACHE_MAX === 0) return;
  if (QUERY_EMBED_CACHE.size >= QUERY_EMBED_CACHE_MAX) {
    const oldest = QUERY_EMBED_CACHE.keys().next().value;
    if (oldest !== undefined) QUERY_EMBED_CACHE.delete(oldest);
  }
  QUERY_EMBED_CACHE.set(key, v);
}

// Optional SHARED L2 (Redis/Dragonfly). The Map above is L1 — per-pod, so with N
// replicas a query embedded on one pod is still a miss on the other N-1. When
// REDIS_URL is set we add a shared L2 so an embed by ANY pod is free for ALL of
// them (the self-host/CLI path leaves REDIS_URL unset → L1-only, no dependency
// loaded). Lazy + fail-safe: any Redis error degrades to L1, never breaks search.
let redisClient: any = null;
let redisInit = false;
async function getRedis(): Promise<any | null> {
  if (redisInit) return redisClient;
  redisInit = true;
  const url = process.env.REDIS_URL;
  if (!url || QUERY_EMBED_CACHE_MAX === 0) return null;
  let client: any = null;
  try {
    // ioredis ships CJS (`export =`); the constructable class lands on .default
    // under NodeNext but can vary by interop — resolve defensively.
    const mod: any = await import('ioredis');
    const Redis = mod.default ?? mod.Redis ?? mod;
    // lazyConnect + an explicit awaited connect(): establish the socket ONCE
    // here so the first get/set runs on a ready client (the earlier
    // enableOfflineQueue:false raced the connection — "Stream isn't writeable").
    // commandTimeout bounds every op so a later Redis hiccup degrades to a fresh
    // embed instead of hanging the search; a failed initial connect → disconnect
    // the client (so it stops reconnecting) and fall back to L1. Background
    // 'error' events are swallowed; the get/put try/catch + commandTimeout guard.
    client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 1000, connectTimeout: 1500 });
    client.on('error', () => {});
    await client.connect();
    redisClient = client;
  } catch { try { client?.disconnect(); } catch { /* ignore */ } redisClient = null; }
  return redisClient;
}
const REDIS_EMBED_TTL = Math.max(60, Number(process.env.QUERY_EMBED_TTL) || 86400);
// L1 → L2 read-through. Populates L1 on an L2 hit so the next same-pod repeat is
// instant. Returns undefined on any miss/error.
async function queryEmbedGet(key: string): Promise<number[] | undefined> {
  const l1 = queryEmbedCacheGet(key);
  if (l1) return l1;
  const r = await getRedis();
  if (!r) return undefined;
  try {
    const s = await r.get(`cr:qembed:${key}`);
    if (s) { const v = JSON.parse(s) as number[]; queryEmbedCachePut(key, v); return v; }
  } catch { /* Redis down/slow — fall through to a fresh embed */ }
  return undefined;
}
// Write L1 synchronously (immediate same-pod benefit); write L2 fire-and-forget
// with a TTL so a stale-space vector can't live forever (also see the dim in the
// key). Caller does not await this — the cache write never adds search latency.
function queryEmbedPut(key: string, v: number[]): void {
  queryEmbedCachePut(key, v);
  void (async () => {
    const r = await getRedis();
    if (!r) return;
    try { await r.set(`cr:qembed:${key}`, JSON.stringify(v), 'EX', REDIS_EMBED_TTL); } catch { /* ignore */ }
  })();
}

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
      // memory_vectors is HASH-partitioned by tenant so each tenant's semantic
      // search prunes to (and probes the HNSW index of) ONLY its own partition —
      // per-tenant cost + latency isolation at 1000+ tenants instead of every
      // query walking one global index. The ANN index is BINARY (binary_quantize
      // → bit(dim), hamming) so it stays tiny in RAM; the fp32 `embedding` column
      // lives on disk and is read only to rescore the shortlist (see search()).
      // Vectors are derived (the backfill re-embeds from memory_chunks), so on any
      // layout drift — dimension change OR a pre-partitioning regular table — we
      // DROP and recreate instead of running a hand migration.
      // All of the schema setup runs on ONE client inside a transaction guarded
      // by an advisory lock: on a rollout every pod calls init() at once, and
      // without this two pods race DROP TABLE against each other's CREATE (one
      // drops the table the other just built). The xact lock serializes them —
      // the loser waits, then sees relkind='p' and skips the rebuild — and it
      // auto-releases on COMMIT/ROLLBACK. Index builds here hit only the freshly
      // emptied partitions, so the lock is held briefly.
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('memory_vectors_schema'))`);
        const meta = await client.query(
          `SELECT (SELECT atttypmod FROM pg_attribute
                    WHERE attrelid = to_regclass('memory_vectors') AND attname='embedding') AS dim,
                  (SELECT relkind FROM pg_class WHERE relname='memory_vectors') AS relkind`);
        const existingDim = meta.rows[0]?.dim;
        const relkind = meta.rows[0]?.relkind;              // 'p' partitioned · 'r' regular · null absent
        const dimDrift = existingDim != null && existingDim > 0 && existingDim !== this.dim;
        const notPartitioned = relkind != null && relkind !== 'p';
        if (dimDrift || notPartitioned) {
          const reason = dimDrift ? `dim ${existingDim}→${this.dim}` : 'converting to tenant-partitioned';
          console.warn(`[vector] rebuilding memory_vectors (${reason}); vectors are derived — the backfill re-embeds from memory_chunks`);
          await client.query(`DROP TABLE IF EXISTS memory_vectors CASCADE`);
        }
        await client.query(
          `CREATE TABLE IF NOT EXISTS memory_vectors (
             tenant TEXT NOT NULL DEFAULT 'default', chunk_id TEXT NOT NULL, item_id TEXT NOT NULL,
             source_type TEXT NOT NULL, title TEXT DEFAULT '', text TEXT DEFAULT '', chunk_type TEXT DEFAULT '',
             project_path TEXT DEFAULT '', project_id TEXT DEFAULT '', file_path TEXT DEFAULT '', mtime BIGINT DEFAULT 0,
             embedding vector(${this.dim}), PRIMARY KEY (tenant, chunk_id))
           PARTITION BY HASH (tenant)`);
        // Materialize the hash partitions (idempotent). Bounded, fixed count — a
        // tenant hashes to exactly one, so equality on tenant prunes to it.
        const nparts = Math.max(1, Number(process.env.CHAT_RECALL_VECTOR_PARTITIONS) || 16);
        for (let i = 0; i < nparts; i++) {
          await client.query(
            `CREATE TABLE IF NOT EXISTS memory_vectors_p${i} PARTITION OF memory_vectors
               FOR VALUES WITH (MODULUS ${nparts}, REMAINDER ${i})`);
        }
        await client.query(`CREATE INDEX IF NOT EXISTS idx_vec_item ON memory_vectors(tenant, source_type, item_id)`);
        // Drop the legacy fp32 cosine HNSW index — its RAM footprint is the whole
        // reason we moved to binary. Build the binary hamming HNSW index instead
        // (propagates to every partition; the exact-cosine rescore in search()
        // recovers the precision quantization drops). Best-effort: pre-0.7 pgvector
        // lacks binary_quantize/bit ops — fall back to the sequential rescan.
        await client.query(`DROP INDEX IF EXISTS idx_vec_hnsw`);
        // SAVEPOINT so a failed index build (pre-0.7 pgvector) doesn't poison the
        // whole transaction — we roll back just this statement and still commit
        // the table + RLS, falling back to a sequential rescan for search.
        await client.query(`SAVEPOINT bin_idx`);
        try {
          await client.query(
            `CREATE INDEX IF NOT EXISTS idx_vec_bin_hnsw ON memory_vectors
               USING hnsw ((binary_quantize(embedding)::bit(${this.dim})) bit_hamming_ops)`);
          await client.query(`RELEASE SAVEPOINT bin_idx`);
        } catch (e) {
          await client.query(`ROLLBACK TO SAVEPOINT bin_idx`).catch(() => {});
          console.warn(`[vector] could not create binary HNSW index (semantic search will sequential-scan): ${e instanceof Error ? e.message : String(e)}`);
        }
        // RLS: memory_vectors lives outside pg-schema.ts, so wall it here too.
        await client.query(`ALTER TABLE memory_vectors ENABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE memory_vectors FORCE ROW LEVEL SECURITY`);
        await client.query(`DROP POLICY IF EXISTS tenant_isolation ON memory_vectors`);
        await client.query(`CREATE POLICY tenant_isolation ON memory_vectors USING (tenant = current_setting('app.tenant', true)) WITH CHECK (tenant = current_setting('app.tenant', true))`);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
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
    // Item 5 — embed-less policy. Plain `assistant` chatter (~64% of chunks) and
    // `subagent:*` internal fan-out (~8%) are low-signal for semantic recall and
    // stay fully keyword-searchable via FTS, so we DON'T vectorize them: ~72%
    // fewer vectors with ~zero semantic-recall loss. CLASSIFIED assistant chunks
    // (assistant:decision:impN, …) and user_context are high-value and kept.
    // Override with EMBED_INCLUDE_ALL_CHUNKS=1 to vectorize everything (e.g. to
    // A/B recall). No new bind params — the predicate is literal.
    const chunkFilter = process.env.EMBED_INCLUDE_ALL_CHUNKS
      ? ''
      : `AND NOT (c.chunk_type = 'assistant' OR c.chunk_type LIKE 'subagent%')`;
    return tenantTx(this.pool, this.t, async (client: any) => {
      const rows: any[] = (await client.query(
        `SELECT c.chunk_id, c.item_id, c.source_type, c.title, c.text, c.chunk_type, c.project_path, c.file_path, c.mtime
           FROM memory_chunks c
           WHERE c.tenant = $1 AND length(c.text) > 0
             AND NOT EXISTS (
               SELECT 1 FROM memory_vectors v WHERE v.tenant = c.tenant AND v.chunk_id = c.chunk_id)
             ${chunkFilter}
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

  /**
   * Self-healing re-window of OVER-LENGTH chunks. A chunk whose text exceeds a
   * hosted embedder's token window can only be embedded on its truncated prefix
   * (embedder.MAX_INPUT_CHARS) — its tail is invisible to vector search. Sources
   * that build their own chunks cap length at index time, but chunks can still
   * arrive over-length: synced from ANOTHER device (no local transcript to
   * re-window from), or from a not-yet-fixed source. This sweep windows any such
   * chunk IN PLACE from its stored text — no transcript needed — so every part
   * gets its own vector. Idempotent: once nothing exceeds `maxChars`, it no-ops.
   *
   * Matches the source-side windowing (sync.ts): the original id becomes the
   * first window (w0); the rest become `<id>:w<N>` rows. tsv is a GENERATED
   * column so FTS follows automatically. The original's now-stale vector is
   * dropped so the backfill sweep re-embeds w0 at its new length; the new
   * windows have no vector and get embedded on the same later sweep.
   */
  async rewindowOversized(opts: { maxChars?: number; window?: number; overlap?: number; maxWindows?: number; limit?: number } = {}):
    Promise<{ rewindowed: number; windowsAdded: number }> {
    if (!this.tableReady) return { rewindowed: 0, windowsAdded: 0 };
    const maxChars = Math.max(1, opts.maxChars ?? 8000);
    const win = Math.max(1, opts.window ?? 2000);
    const overlap = Math.max(0, Math.min(win - 1, opts.overlap ?? 100));
    const maxWindows = Math.max(1, opts.maxWindows ?? 120);
    const limit = Math.max(1, opts.limit ?? 50);
    const step = win - overlap;
    return tenantTx(this.pool, this.t, async (client: any) => {
      // Claim over-length chunks (SKIP LOCKED so replicas don't collide). Skip
      // any that already have a window sibling — a half-applied prior run — so
      // re-runs stay idempotent.
      const rows: any[] = (await client.query(
        `SELECT chunk_id, item_id, source_type, title, text, chunk_type, project_path, project_id, file_path, mtime
           FROM memory_chunks c
          WHERE c.tenant=$1 AND length(c.text) > $2
            AND NOT EXISTS (SELECT 1 FROM memory_chunks w
                             WHERE w.tenant=c.tenant AND w.chunk_id = c.chunk_id || ':w1')
          LIMIT $3
          FOR UPDATE SKIP LOCKED`,
        [this.t, maxChars, limit])).rows;
      let rewindowed = 0, windowsAdded = 0;
      for (const g of rows) {
        const text: string = g.text;
        const windows: string[] = [];
        for (let i = 0; i < text.length && windows.length < maxWindows; i += step) windows.push(text.slice(i, i + win));
        if (windows.length <= 1) continue; // shouldn't happen (len > maxChars ≥ win), but stay safe
        await client.query(`UPDATE memory_chunks SET text=$2 WHERE tenant=$1 AND chunk_id=$3`, [this.t, windows[0], g.chunk_id]);
        await client.query(`DELETE FROM memory_vectors WHERE tenant=$1 AND chunk_id=$2`, [this.t, g.chunk_id]);
        for (let wi = 1; wi < windows.length; wi++) {
          await client.query(
            `INSERT INTO memory_chunks (tenant, chunk_id, item_id, source_type, title, text, chunk_type, project_path, project_id, file_path, mtime)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (tenant, chunk_id) DO UPDATE SET text=EXCLUDED.text`,
            [this.t, `${g.chunk_id}:w${wi}`, g.item_id, g.source_type, `${g.title || ''} (${wi + 1})`,
             windows[wi], g.chunk_type || '', g.project_path || '', g.project_id || '', g.file_path || '', this.intMs(g.mtime)]);
          windowsAdded++;
        }
        rewindowed++;
      }
      return { rewindowed, windowsAdded };
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
    // FTS is the default tier. The vector/semantic tier runs ONLY when the caller
    // asks for it — options.semantic===true, which the server sets for an EXPLICIT
    // search (Enter / Search button); the debounced type-ahead leaves it false and
    // stays FTS-only (no embed). SEARCH_SEMANTIC=on forces it on globally. When on,
    // it embeds the query (cache-checked L1→L2), vector-searches its partition, and
    // RRF-fuses with FTS below. The intent gate lives in the caller, not a fragile
    // FTS-strength heuristic (which never discriminated — every query matched many).
    const semantic = (options as any).semantic === true || process.env.SEARCH_SEMANTIC === 'on';
    if (!semantic || !this.embedder || !this.vectorOk) return ftsResults;
    // Query embedding — cache-checked first (L1 in-process → shared L2 Redis when
    // configured), keyed by model dimension + text, so repeats across any pod
    // skip the gateway round-trip entirely.
    const cacheKey = `${this.dim}:${query}`;
    let qv = await queryEmbedGet(cacheKey);
    if (!qv) {
      try { qv = await (this.embedder as any).embedQuery(query) as number[]; } catch { return ftsResults; }
      queryEmbedPut(cacheKey, qv);
    }
    // Two-phase, so the binary index carries the cost and the fp32 column only
    // rescoring the shortlist restores precision:
    //   1. SHORTLIST via the tiny binary hamming HNSW index — cheap ANN over
    //      bit(dim) codes, tenant-pruned to one partition. Over-fetch generously
    //      to absorb what 1-bit quantization drops.
    //   2. RESCORE the shortlist with the exact fp32 cosine + the same
    //      demotion/recency/importance blend as searchFTS (pg.ts).
    const params: unknown[] = [this.t, this.vecLiteral(qv)];   // $1 tenant · $2 query vector
    let candWhere = `tenant=$1 AND embedding IS NOT NULL`;
    if ((options as any).sourceTypes?.length) { params.push((options as any).sourceTypes); candWhere += ` AND source_type = ANY($${params.length})`; }
    // Path SUBSTRING, not an exact project_id — see searchFTS (pg.ts). Keeps the
    // vector path consistent with FTS so `-p` filters identically either way.
    // Filters live INSIDE the shortlist so we don't spend candidates on rows
    // that'd be filtered out after rescoring.
    if ((options as any).projectIdFilter) { params.push(`%${(options as any).projectIdFilter}%`); candWhere += ` AND project_path ILIKE $${params.length}`; }
    // Shortlist size: generous over-fetch (binary loses precision) but bounded.
    // Tune via VECTOR_RESCORE_CANDIDATES; recover exact ranking in phase 2.
    const candN = Math.max(Number(process.env.VECTOR_RESCORE_CANDIDATES) || 0, 500, topK * 40);
    params.push(candN); const candP = params.length;
    // Age exponent clamped (LEAST(…, 60)) for the same reason as searchFTS:
    // Postgres RAISES underflow for exp() of a large negative, so one mtime=0
    // row would error every vector search.
    params.push(Date.now()); const nowP = params.length;
    params.push(topK * 5); const limP = params.length;
    const dim = this.dim;
    const sql = `WITH cand AS (
                   SELECT chunk_id, item_id, source_type, title, text, chunk_type, project_path, file_path, mtime, embedding
                     FROM memory_vectors
                    WHERE ${candWhere}
                    ORDER BY binary_quantize(embedding)::bit(${dim}) <~> binary_quantize($2::vector)::bit(${dim})
                    LIMIT $${candP})
                 SELECT chunk_id, item_id, source_type, title, text, chunk_type, project_path, file_path, mtime,
                        1/(1+(embedding <=> $2::vector)) AS score
                   FROM cand
                  ORDER BY (1/(1+(embedding <=> $2::vector)))
                           * (CASE WHEN chunk_type LIKE 'subagent%' THEN 0.55
                                   WHEN chunk_type LIKE 'tool_result%' THEN 0.5
                                   ELSE 1.0 END)
                           + 0.15 * exp(-LEAST(GREATEST($${nowP}::double precision - COALESCE(mtime, 0), 0) / (14.0 * 86400000), 60))
                           + 0.10 * (COALESCE(NULLIF(substring(chunk_type from 'imp([0-9])'), '')::int, 1) / 5.0) DESC
                  LIMIT $${limP}`;
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
    // Reciprocal Rank Fusion: score each item by Σ 1/(K + rank) across BOTH
    // ranked lists, then sort by the fused score. Unlike the old FTS-first
    // concat (where a vector-only match could never outrank the weakest keyword
    // hit), an item ranked highly by BOTH backends floats to the top, and a
    // strong semantic-only match can beat a weak keyword one. K=60 is the
    // standard RRF constant — damps the contribution of deep-rank items.
    const K = 60;
    const fused = new Map<string, { result: MemorySearchResult; score: number }>();
    const fuse = (list: MemorySearchResult[]) => {
      list.forEach((r, i) => {
        const key = `${r.sourceType}:${r.itemId}`;
        const add = 1 / (K + i + 1);
        const cur = fused.get(key);
        if (cur) cur.score += add;
        else fused.set(key, { result: r, score: add });
      });
    };
    fuse(ftsResults);
    fuse(vectorResults);
    const ranked = [...fused.values()].sort((a, b) => b.score - a.score).map((x) => x.result);
    // R4: drop near-duplicate items — the same content often lives in a session,
    // its subagent transcript, AND a paste; without this they eat 3 of 5 slots.
    // Signature = normalized 120-char text prefix.
    const out: MemorySearchResult[] = [];
    const seenSig = new Set<string>();
    for (const r of ranked) {
      const sig = (r.text || r.title || '').replace(/\s+/g, ' ').trim().slice(0, 120).toLowerCase();
      if (sig && seenSig.has(sig)) continue;
      if (sig) seenSig.add(sig);
      out.push(r);
      if (out.length >= topK) break;
    }
    return out;
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
