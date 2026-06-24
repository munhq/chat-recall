import { currentTenant } from './tenant-context.js';
import { tenantQuery } from './pg-pool.js';
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
    await ensurePgSchema(this.databaseUrl);
    // FTS store shares the pooled connection (openPgPool caches per URL) and
    // creates/owns the `memory_chunks` table in its own init().
    const { PgStore } = await import('./pg.js');
    this.fts = new PgStore(this.databaseUrl, this.t);
    await this.fts.init();
    try {
      await this.pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
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
    params.push(topK * 5); sql += ` ORDER BY embedding <=> $2::vector ASC LIMIT $${params.length}`;
    const rows = await this.q(sql, params);
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
    const totalChunks = (await this.q(`SELECT COUNT(*)::int AS n FROM memory_chunks WHERE tenant=$1`, [this.t]))[0]?.n ?? 0;
    const totalItems = (await this.q(`SELECT COUNT(DISTINCT item_id)::int AS n FROM memory_chunks WHERE tenant=$1`, [this.t]))[0]?.n ?? 0;
    const bySourceType: Record<string, { items: number; chunks: number }> = {};
    for (const r of await this.q(`SELECT source_type, COUNT(*)::int AS chunks, COUNT(DISTINCT item_id)::int AS items FROM memory_chunks WHERE tenant=$1 GROUP BY source_type`, [this.t]))
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
