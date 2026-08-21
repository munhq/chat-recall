/**
 * ⚠️ RESERVED — NOT WIRED INTO THE PRODUCT. Do not assume this runs.
 *
 * This LanceDB on-disk vector index is the (currently disabled) local/offline
 * storage path. The shipped product is Postgres-only: `resolveBackend`
 * (store/index.ts) returns 'postgres' or throws, so this code is reached ONLY
 * via the 'sqlite' unit-test branch — never for a real user. It's kept
 * deliberately as a head-start for a possible future local mode, NOT because
 * it's active. If you're tracing how sessions get chunked/indexed in
 * production, this is the WRONG file — see `server/src/services/session-chunks.ts`
 * (chunksFromTurns) + the pg StorageDriver.
 *
 * ── original doc ──
 * LanceDB vector index for unified memory chunks. Stores all memory types in a
 * single `memory_chunks` table, enabling cross-type semantic search in one
 * query with optional source-type filtering.
 */

import lancedb from '@lancedb/lancedb';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

import type { Embedder } from './embedder.js';
import type { LanceTable } from './lancedb-types.js';
import type { SourceType, MemoryChunk, MemorySearchResult } from '../types/memory.js';
import { createStore } from './store/index.js';
import { resolveProjectId } from './project-resolver.js';
import { getIndexDir } from './paths.js';
import { createLogger } from './logger.js';

const log = createLogger('memory-index');

export interface MemoryChunkRecord {
  id: string;
  item_id: string;
  source_type: string;
  title: string;
  vector: number[];
  text: string;
  chunk_type: string;
  project_path: string;
  /**
   * Logical project identifier resolved by `project-resolver.resolveProjectId`.
   * Wide search/filter calls bucket on this column instead of `project_path`.
   * Added in the project-id migration; older tables that lack it trigger a
   * one-shot table drop+rebuild on `MemoryIndex.connect()`.
   */
  project_id: string;
  file_path: string;
  mtime: number;
}

export class MemoryIndex {
  static readonly TABLE_NAME = 'memory_chunks';
  /** Warn once when the embedder is unreachable and we fall back to FTS. */
  private static embedWarned = false;
  /** Default index directory — resolved lazily through `paths.ts` so tests
   *  can override via `CHAT_RECALL_DATA_DIR` and the legacy migration runs
   *  before any directory is created. */
  static getDefaultIndexPath(): string { return getIndexDir(); }

  private embedder: Embedder | null;
  private indexPath: string;
  private db: Awaited<ReturnType<typeof lancedb.connect>> | null = null;
  private table: LanceTable | null = null;
  private mtimeCache: Record<string, number> = {};
  private mtimeCachePath: string;

  /** Buffered chunks waiting to be flushed to LanceDB in a single write */
  private pendingChunks: MemoryChunk[] = [];
  /** Flush when buffer reaches this size */
  private static readonly FLUSH_THRESHOLD = 200;

  /** Buffered chunks waiting to be flushed to FTS5 */
  private pendingFTSChunks: MemoryChunk[] = [];

  /** Last Lance read error (string) — surfaced by getStats() so the UI can
   *  warn the user that vector search is degraded. Cleared on the next
   *  successful Lance read. */
  private lastLanceError: string | null = null;
  /** Bumped each time we drop a cached `db`/`table` after a Lance failure,
   *  so we don't loop forever auto-healing inside a single search call. */
  private lanceReopenAttempts = 0;
  private static readonly MAX_REOPEN_ATTEMPTS = 1;

  constructor(embedder: Embedder | null, indexPath?: string) {
    this.embedder = embedder;
    this.indexPath = indexPath || MemoryIndex.getDefaultIndexPath();
    this.mtimeCachePath = join(this.indexPath, 'memory_mtime_cache.json');

    if (!existsSync(this.indexPath)) {
      mkdirSync(this.indexPath, { recursive: true });
    }

    this.mtimeCache = this.loadMtimeCache();
  }

  async connect(): Promise<void> {
    if (!this.db) {
      this.db = await lancedb.connect(this.indexPath);

      const tableNames = await this.db.tableNames();
      if (tableNames.includes(MemoryIndex.TABLE_NAME)) {
        this.table = await this.db.openTable(MemoryIndex.TABLE_NAME) as unknown as LanceTable;
        await this.maybeMigrateTableForProjectId();
      }
    }
  }

  /**
   * LanceDB tables don't support online schema migration. When the existing
   * table predates the `project_id` column, the cleanest path is to drop it
   * — the auto-indexer's next pass will rebuild the table from
   * `memory_metadata` + freshly-embedded chunks. Until then, search
   * transparently falls back to FTS5 (already FTS5-first in `search()`).
   *
   * We detect "needs migration" by reading one row's keys; if `project_id`
   * isn't present, the table is from before the migration.
   */
  private async maybeMigrateTableForProjectId(): Promise<void> {
    if (!this.table || !this.db) return;
    try {
      const arrow = await this.table.toArrow();
      const sample = arrow.toArray()[0];
      if (sample && Object.prototype.hasOwnProperty.call(sample, 'project_id')) {
        return; // already migrated
      }
      // Old schema — drop the table. Rebuild happens on next addChunks call.
      log.error('LanceDB table predates project_id column; dropping for rebuild');
      await (this.db as unknown as { dropTable(name: string): Promise<void> }).dropTable(MemoryIndex.TABLE_NAME);
      this.table = null;
      // Force re-index of all chunks by clearing the mtime cache so
      // needsUpdate() returns true for every item on the next sweep.
      this.mtimeCache = {};
      this.saveMtimeCache();
    } catch {
      // Empty table or read failure: leave alone — addChunks will recreate
      // from scratch the next time it's called.
    }
  }

  private loadMtimeCache(): Record<string, number> {
    if (existsSync(this.mtimeCachePath)) {
      try {
        return JSON.parse(readFileSync(this.mtimeCachePath, 'utf-8'));
      } catch {
        return {};
      }
    }
    return {};
  }

  private saveMtimeCache(): void {
    writeFileSync(this.mtimeCachePath, JSON.stringify(this.mtimeCache));
  }

  /** Cache key combines source type and item ID for uniqueness */
  private cacheKey(sourceType: string, itemId: string): string {
    return `${sourceType}:${itemId}`;
  }

  needsUpdate(sourceType: string, itemId: string, mtime: number): boolean {
    const key = this.cacheKey(sourceType, itemId);
    const cachedMtime = this.mtimeCache[key] || 0;
    return mtime > cachedMtime;
  }

  async addChunks(chunks: MemoryChunk[], options?: { skipFTS?: boolean }): Promise<number> {
    if (chunks.length === 0) return 0;

    const validChunks = chunks.filter(c => c.text && c.text.trim().length > 0);
    if (validChunks.length === 0) return 0;

    // Write to FTS5 (always, unless already done by flushBuffer)
    if (!options?.skipFTS) {
      const store = await createStore();
      await store.addChunksFTS(validChunks);
      await store.close();
    }

    // Write to LanceDB only with a real embedder. The `none` provider yields a
    // NoneEmbedder (dimension 0) whose embed() throws — treat dimension-0 as
    // "no embedder" so FTS-only mode indexes cleanly instead of aborting each
    // item before it's registered.
    if (this.embedder && this.embedder.dimension > 0) {
      try {
      await this.connect();

      const texts = validChunks.map(c => c.text);
      const embeddings = await this.embedder.embed(texts);

      const records: MemoryChunkRecord[] = validChunks.map((chunk, i) => {
        // Resolve project_id once per chunk. Resolver is cached so the
        // per-chunk cost is just a Map lookup after the first hit per
        // projectPath; even on a 200-chunk batch this stays in the µs range.
        const resolved = chunk.projectPath ? resolveProjectId(chunk.projectPath) : null;
        const projectId = resolved && resolved.source !== 'ignored' ? resolved.id : '';
        return {
          id: chunk.chunkId,
          item_id: chunk.itemId,
          source_type: chunk.sourceType,
          title: chunk.title,
          vector: embeddings[i],
          text: chunk.text,
          chunk_type: chunk.chunkType,
          project_path: chunk.projectPath,
          project_id: projectId,
          file_path: chunk.filePath,
          mtime: chunk.mtime,
        };
      });

      if (this.table === null) {
        this.table = await this.db!.createTable(
          MemoryIndex.TABLE_NAME,
          records as unknown as Record<string, unknown>[]
        ) as unknown as LanceTable;
      } else {
        await this.table.add(records as unknown as Record<string, unknown>[]);
      }
      } catch (err) {
        // Embedder unreachable (e.g. Ollama not running) — FTS5 is already
        // written above, so degrade to keyword-only for this batch instead of
        // failing the whole item. Warn once to avoid log spam.
        if (!MemoryIndex.embedWarned) {
          MemoryIndex.embedWarned = true;
          log.warn({ err }, 'Vector indexing unavailable — using FTS5 keyword search. Start Ollama or set EMBEDDING_PROVIDER to enable semantic search.');
        }
      }
    }

    // Update mtime cache
    for (const chunk of validChunks) {
      const key = this.cacheKey(chunk.sourceType, chunk.itemId);
      this.mtimeCache[key] = Math.max(this.mtimeCache[key] || 0, chunk.mtime);
    }
    this.saveMtimeCache();

    return validChunks.length;
  }

  /**
   * Buffer chunks for a later flush. Use this in bulk indexing loops
   * to avoid creating a LanceDB version per item. Call flushBuffer()
   * when done (or when switching source types).
   * Auto-flushes when the buffer reaches FLUSH_THRESHOLD.
   */
  async bufferChunks(chunks: MemoryChunk[]): Promise<void> {
    const valid = chunks.filter(c => c.text && c.text.trim().length > 0);
    this.pendingChunks.push(...valid);
    this.pendingFTSChunks.push(...valid);

    // Update mtime cache immediately (so needsUpdate returns false for these)
    for (const chunk of valid) {
      const key = this.cacheKey(chunk.sourceType, chunk.itemId);
      this.mtimeCache[key] = Math.max(this.mtimeCache[key] || 0, chunk.mtime);
    }

    if (this.pendingChunks.length >= MemoryIndex.FLUSH_THRESHOLD) {
      await this.flushBuffer();
    }
  }

  /**
   * Flush all buffered chunks to LanceDB in a single write operation.
   * Returns the number of chunks written.
   */
  async flushBuffer(): Promise<number> {
    if (this.pendingChunks.length === 0 && this.pendingFTSChunks.length === 0) return 0;

    // Flush FTS5 first (always works, no dependencies)
    if (this.pendingFTSChunks.length > 0) {
      const ftsChunks = this.pendingFTSChunks;
      this.pendingFTSChunks = [];
      const store = await createStore();
      await store.addChunksFTS(ftsChunks);
      await store.close();
    }

    // Flush LanceDB (skip FTS5 since we just did it)
    const chunks = this.pendingChunks;
    this.pendingChunks = [];

    if (chunks.length === 0) {
      this.saveMtimeCache();
      return 0;
    }

    const count = await this.addChunks(chunks, { skipFTS: true });
    this.saveMtimeCache();
    return count;
  }

  /** Returns the number of chunks currently in the buffer */
  get pendingCount(): number {
    return this.pendingChunks.length;
  }

  async deleteItem(sourceType: string, itemId: string): Promise<void> {
    // Delete from FTS5
    const store = await createStore();
    await store.deleteItemFTS(sourceType, itemId);
    await store.close();

    // Delete from LanceDB
    await this.connect();
    if (this.table !== null) {
      const safeType = sourceType.replace(/"/g, '');
      const safeId = itemId.replace(/"/g, '');
      await this.table.delete(`source_type = "${safeType}" AND item_id = "${safeId}"`);
    }

    const key = this.cacheKey(sourceType, itemId);
    delete this.mtimeCache[key];
    this.saveMtimeCache();
  }

  async deleteSourceType(sourceType: string): Promise<void> {
    await this.connect();

    if (this.table !== null) {
      const safeType = sourceType.replace(/"/g, '');
      await this.table.delete(`source_type = "${safeType}"`);
    }

    // Remove matching entries from mtime cache
    const prefix = `${sourceType}:`;
    for (const key of Object.keys(this.mtimeCache)) {
      if (key.startsWith(prefix)) {
        delete this.mtimeCache[key];
      }
    }
    this.saveMtimeCache();
  }

  /**
   * Compact and optimize the LanceDB table.
   * Merges small data files, removes old versions and transactions.
   * Can reclaim significant disk space (e.g., 18GB → 2GB).
   *
   * Holds an exclusive index lock for the duration so a concurrent
   * writer can't slip a fragment in mid-compaction. Returns
   * `{ skipped: 'busy' | 'no-table' }` instead of throwing when the
   * caller can't run — auto-callers want to no-op in that case.
   *
   * `cleanupOlderThan` defaults to 24h. The old default of 1h was too
   * aggressive when the MCP server, indexer, and CLI share the index —
   * a long-running session can hold a 2h-old read snapshot. 24h is the
   * minimum that's safe across all our access patterns.
   */
  async optimize(opts: {
    /** Drop versions older than this. Default 24h. */
    cleanupOlderThanMs?: number;
    /** Diagnostic label written into the lock file. */
    lockKind?: string;
  } = {}): Promise<
    | { compactedFragments: number; prunedFiles: number; skipped?: undefined }
    | { skipped: 'busy' | 'no-table'; compactedFragments?: undefined; prunedFiles?: undefined }
  > {
    await this.connect();
    if (this.table === null) {
      return { skipped: 'no-table' };
    }

    const { acquireIndexLock } = await import('./index-lock.js');
    const lock = acquireIndexLock({ kind: opts.lockKind ?? 'optimize' });
    if (!lock) {
      return { skipped: 'busy' };
    }

    try {
      const cutoff = new Date(Date.now() - (opts.cleanupOlderThanMs ?? 24 * 60 * 60 * 1000));
      const stats = await this.table.optimize({
        cleanupOlderThan: cutoff,
        deleteUnverified: false, // Don't delete unverified data files — too aggressive
      });
      return {
        compactedFragments: stats.compaction?.fragmentsRemoved || 0,
        prunedFiles: stats.prune?.oldVersionsRemoved || 0,
      };
    } finally {
      lock.release();
    }
  }

  async search(
    query: string,
    options: {
      topK?: number;
      sourceTypes?: SourceType[];
      projectIdFilter?: string;
      // Vector/semantic tier control (honored by the pg VectorStore): true =
      // embed + vector-search + RRF-fuse; falsy = FTS only. Set true by the server
      // only for an explicit search. See store/vector.ts search(). Ignored here.
      semantic?: boolean;
      // Recency floor (epoch ms): only chunks with mtime >= sinceMs match. The
      // free tier's search window — undefined means no floor (paid/self-host).
      sinceMs?: number;
    } = {}
  ): Promise<MemorySearchResult[]> {
    const { topK = 20, sourceTypes, projectIdFilter, sinceMs } = options;

    // ── Hybrid search ──────────────────────────────────────────────────
    // Always run FTS5 first. Reasons:
    //   1. Vector search returns nearest-neighbor regardless of similarity,
    //      so a query for a literal token like "6438M" (CPU model, error
    //      code, hex id) returns nonsense top-N when no semantically
    //      similar chunk exists. FTS5 either matches the literal or
    //      returns zero rows — never garbage.
    //   2. FTS5 ranks by BM25, which weights rare tokens heavily, which
    //      is exactly what the user wants when typing a specific term.
    // The vector results are then unioned in as additional context. FTS5
    // hits keep their natural position; vector hits fill the rest.
    const ftsStore = await createStore();
    let ftsResults: MemorySearchResult[] = [];
    try {
      ftsResults = await ftsStore.searchFTS(query, { topK, sourceTypes, projectIdFilter, sinceMs });
    } finally {
      await ftsStore.close();
    }

    if (!this.embedder) {
      return ftsResults;
    }

    // Vector search path. Wrapped in try/catch so a stale Lance table handle
    // (common after auto-indexer compaction rewrites data files while the API
    // process holds an open table) auto-heals: we drop the cached handle,
    // re-open the table, and retry once. If retry also fails, we degrade to
    // FTS5 and record the error for the status UI.
    const validTypes: string[] = ['session', 'plan', 'task', 'claude_md', 'paste', 'history', 'diary'];
    const safeSourceTypes = sourceTypes && sourceTypes.length > 0
      ? sourceTypes.filter(t => validTypes.includes(t))
      : undefined;
    // Strip lance-unsafe characters; project_id never legitimately
    // contains backslashes or quotes, but defence-in-depth.
    const safeProjectId = projectIdFilter ? projectIdFilter.replace(/["'\\]/g, '') : undefined;

    const runVectorSearch = async (): Promise<Array<{
      item_id: string; source_type: string; title: string; _distance: number;
      chunk_type: string; text: string; project_path: string; file_path: string; mtime: number;
    }>> => {
      await this.connect();
      if (this.table === null) return [];

      const queryVector = await this.embedder!.embedQuery(query);
      let searchQuery = this.table.search(queryVector);

      const filters: string[] = [];
      if (safeSourceTypes && safeSourceTypes.length > 0) {
        const typeList = safeSourceTypes.map(t => `"${t}"`).join(', ');
        filters.push(`source_type IN (${typeList})`);
      }
      if (safeProjectId) {
        filters.push(`project_id = "${safeProjectId}"`);
      }
      if (sinceMs && Number.isFinite(sinceMs)) {
        filters.push(`mtime >= ${Math.floor(sinceMs)}`);
      }
      if (filters.length > 0 && searchQuery.where) {
        searchQuery = searchQuery.where(filters.join(' AND '));
      }
      return await searchQuery.limit(topK * 5).toArray() as any;
    };

    let results: Array<{
      item_id: string; source_type: string; title: string; _distance: number;
      chunk_type: string; text: string; project_path: string; file_path: string; mtime: number;
    }> = [];

    try {
      results = await runVectorSearch();
      // Vector path succeeded — table is healthy again.
      this.lastLanceError = null;
      this.lanceReopenAttempts = 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastLanceError = msg;
      // Auto-heal: drop cached handle and retry once. This recovers from the
      // common "stale data file" error after the auto-indexer compacts.
      if (this.lanceReopenAttempts < MemoryIndex.MAX_REOPEN_ATTEMPTS) {
        this.lanceReopenAttempts += 1;
        log.error({ err }, 'Lance read failed; reopening table and retrying once');
        this.db = null;
        this.table = null;
        try {
          results = await runVectorSearch();
          this.lastLanceError = null;
          this.lanceReopenAttempts = 0;
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          this.lastLanceError = msg2;
          log.error({ err: err2 }, 'Lance retry failed; falling back to FTS5');
          const store = await createStore();
          const fts = await store.searchFTS(query, { topK, sourceTypes, projectIdFilter, sinceMs });
          await store.close();
          return fts;
        }
      } else {
        const store = await createStore();
        const fts = await store.searchFTS(query, { topK, sourceTypes, projectIdFilter, sinceMs });
        await store.close();
        return fts;
      }
    }

    if (results.length === 0) {
      // No vector hits (empty/new Lance table, or genuinely nothing near) —
      // the FTS hits are still valid results, not something to discard.
      return ftsResults.slice(0, topK);
    }

    // Group by item_id + source_type
    const itemMap = new Map<string, {
      itemId: string;
      sourceType: SourceType;
      title: string;
      projectPath: string;
      filePath: string;
      mtime: number;
      chunks: Array<{ chunkType: string; text: string; score: number }>;
      bestScore: number;
    }>();

    for (const row of results) {
      const score = 1 / (1 + row._distance);
      const key = `${row.source_type}:${row.item_id}`;

      if (!itemMap.has(key)) {
        itemMap.set(key, {
          itemId: row.item_id,
          sourceType: row.source_type as SourceType,
          title: row.title,
          projectPath: row.project_path,
          filePath: row.file_path,
          mtime: row.mtime,
          chunks: [],
          bestScore: score,
        });
      }

      const item = itemMap.get(key)!;
      item.chunks.push({
        chunkType: row.chunk_type,
        text: row.text,
        score,
      });

      if (score > item.bestScore) {
        item.bestScore = score;
      }
    }

    // Convert to results
    const searchResults: MemorySearchResult[] = [];

    for (const [, item] of itemMap) {
      item.chunks.sort((a, b) => b.score - a.score);

      searchResults.push({
        itemId: item.itemId,
        sourceType: item.sourceType,
        title: item.title,
        text: item.chunks[0]?.text || '',
        score: item.bestScore,
        chunkType: item.chunks[0]?.chunkType || 'unknown',
        projectPath: item.projectPath,
        filePath: item.filePath,
        mtime: item.mtime,
        matchedChunks: item.chunks.slice(0, 3),
      });
    }

    searchResults.sort((a, b) => b.score - a.score);

    // Merge FTS5 hits in front of vector hits. FTS5 found literal-token
    // matches that vector almost never ranks correctly, and they're the
    // ones the user actually wanted. Vector hits backfill any remaining
    // topK slots after dedupe by (sourceType, itemId).
    if (ftsResults.length > 0) {
      const seen = new Set<string>();
      const merged: MemorySearchResult[] = [];
      for (const r of ftsResults) {
        const k = `${r.sourceType}:${r.itemId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(r);
        if (merged.length >= topK) break;
      }
      for (const r of searchResults) {
        if (merged.length >= topK) break;
        const k = `${r.sourceType}:${r.itemId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(r);
      }
      return merged;
    }

    return searchResults.slice(0, topK);
  }

  /** Returns the current Lance/vector index health. `ok` is true unless the
   *  most recent read raised. */
  getHealth(): { vectorOk: boolean; lastError: string | null; embedderConfigured: boolean } {
    return {
      vectorOk: this.lastLanceError === null,
      lastError: this.lastLanceError,
      embedderConfigured: this.embedder !== null,
    };
  }

  async getStats(): Promise<{
    totalChunks: number;
    totalItems: number;
    bySourceType: Record<string, { items: number; chunks: number }>;
    indexPath: string;
    vectorOk: boolean;
    vectorError: string | null;
  }> {
    let table: LanceTable | null = null;
    try {
      await this.connect();
      table = this.table;
    } catch (err) {
      this.lastLanceError = err instanceof Error ? err.message : String(err);
    }

    if (table === null) {
      return {
        totalChunks: 0,
        totalItems: 0,
        bySourceType: {},
        indexPath: this.indexPath,
        vectorOk: this.lastLanceError === null,
        vectorError: this.lastLanceError,
      };
    }

    let rows: Array<{ item_id: string; source_type: string }> = [];
    try {
      const data = await table.toArrow();
      rows = data.toArray() as Array<{ item_id: string; source_type: string }>;
      this.lastLanceError = null;
    } catch (err) {
      this.lastLanceError = err instanceof Error ? err.message : String(err);
      return {
        totalChunks: 0,
        totalItems: 0,
        bySourceType: {},
        indexPath: this.indexPath,
        vectorOk: false,
        vectorError: this.lastLanceError,
      };
    }

    const itemsByType = new Map<string, Set<string>>();
    const chunksByType = new Map<string, number>();

    for (const row of rows) {
      if (!itemsByType.has(row.source_type)) {
        itemsByType.set(row.source_type, new Set());
        chunksByType.set(row.source_type, 0);
      }
      itemsByType.get(row.source_type)!.add(row.item_id);
      chunksByType.set(row.source_type, (chunksByType.get(row.source_type) || 0) + 1);
    }

    const bySourceType: Record<string, { items: number; chunks: number }> = {};
    let totalItems = 0;

    for (const [type, items] of itemsByType) {
      bySourceType[type] = {
        items: items.size,
        chunks: chunksByType.get(type) || 0,
      };
      totalItems += items.size;
    }

    return {
      totalChunks: rows.length,
      totalItems,
      bySourceType,
      indexPath: this.indexPath,
      vectorOk: this.lastLanceError === null,
      vectorError: this.lastLanceError,
    };
  }

  async clear(): Promise<void> {
    await this.connect();

    const tableNames = await this.db!.tableNames();
    if (tableNames.includes(MemoryIndex.TABLE_NAME)) {
      await this.db!.dropTable(MemoryIndex.TABLE_NAME);
    }

    this.table = null;
    this.mtimeCache = {};
    this.saveMtimeCache();
  }
}
