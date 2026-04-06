/**
 * LanceDB vector index for unified memory chunks.
 *
 * Stores all memory types in a single `memory_chunks` table alongside
 * the existing `session_chunks` table, enabling cross-type semantic
 * search in one query with optional source type filtering.
 */

import lancedb from '@lancedb/lancedb';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { Embedder } from './embedder.js';
import type { LanceTable } from './lancedb-types.js';
import type { SourceType, MemoryChunk, MemorySearchResult } from '../types/memory.js';
import { MemoryStore } from './memory-store.js';

export interface MemoryChunkRecord {
  id: string;
  item_id: string;
  source_type: string;
  title: string;
  vector: number[];
  text: string;
  chunk_type: string;
  project_path: string;
  file_path: string;
  mtime: number;
}

export class MemoryIndex {
  static readonly TABLE_NAME = 'memory_chunks';
  static readonly DEFAULT_INDEX_PATH = join(homedir(), '.claude', 'chat-recall-index');

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

  constructor(embedder: Embedder | null, indexPath?: string) {
    this.embedder = embedder;
    this.indexPath = indexPath || MemoryIndex.DEFAULT_INDEX_PATH;
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
      }
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
      const store = new MemoryStore();
      store.addChunksFTS(validChunks);
      store.close();
    }

    // Write to LanceDB if embedder available
    if (this.embedder) {
      await this.connect();

      const texts = validChunks.map(c => c.text);
      const embeddings = await this.embedder.embed(texts);

      const records: MemoryChunkRecord[] = validChunks.map((chunk, i) => ({
        id: chunk.chunkId,
        item_id: chunk.itemId,
        source_type: chunk.sourceType,
        title: chunk.title,
        vector: embeddings[i],
        text: chunk.text,
        chunk_type: chunk.chunkType,
        project_path: chunk.projectPath,
        file_path: chunk.filePath,
        mtime: chunk.mtime,
      }));

      if (this.table === null) {
        this.table = await this.db!.createTable(
          MemoryIndex.TABLE_NAME,
          records as unknown as Record<string, unknown>[]
        ) as unknown as LanceTable;
      } else {
        await this.table.add(records as unknown as Record<string, unknown>[]);
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
      const store = new MemoryStore();
      store.addChunksFTS(ftsChunks);
      store.close();
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
    const store = new MemoryStore();
    store.deleteItemFTS(sourceType, itemId);
    store.close();

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
   */
  async optimize(): Promise<{ compactedFragments: number; prunedFiles: number }> {
    await this.connect();

    if (this.table === null) {
      return { compactedFragments: 0, prunedFiles: 0 };
    }

    // Keep versions from the last hour to avoid deleting data files
    // still referenced by recent writes
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const stats = await this.table.optimize({
      cleanupOlderThan: oneHourAgo,
      deleteUnverified: false, // Don't delete unverified data files — too aggressive
    });

    return {
      compactedFragments: stats.compaction?.fragmentsRemoved || 0,
      prunedFiles: stats.prune?.oldVersionsRemoved || 0,
    };
  }

  async search(
    query: string,
    options: {
      topK?: number;
      sourceTypes?: SourceType[];
      projectFilter?: string;
    } = {}
  ): Promise<MemorySearchResult[]> {
    const { topK = 20, sourceTypes, projectFilter } = options;

    // If no embedder, use FTS5 search
    if (!this.embedder) {
      const store = new MemoryStore();
      const results = store.searchFTS(query, { topK, sourceTypes, projectFilter });
      store.close();
      return results;
    }

    // Vector search path (existing behavior)
    await this.connect();

    if (this.table === null) {
      // Fall back to FTS5 if LanceDB table doesn't exist yet
      const store = new MemoryStore();
      const results = store.searchFTS(query, { topK, sourceTypes, projectFilter });
      store.close();
      return results;
    }

    const queryVector = await this.embedder.embedQuery(query);

    const limit = topK * 5;

    let searchQuery = this.table.search(queryVector);

    // Build filter
    const filters: string[] = [];
    if (sourceTypes && sourceTypes.length > 0) {
      // Validate source types against known values to prevent injection
      const validTypes: string[] = ['session', 'plan', 'task', 'claude_md', 'paste', 'history'];
      const safeTypes = sourceTypes.filter(t => validTypes.includes(t));
      if (safeTypes.length > 0) {
        const typeList = safeTypes.map(t => `"${t}"`).join(', ');
        filters.push(`source_type IN (${typeList})`);
      }
    }
    if (projectFilter) {
      // Sanitize: strip quotes and backslashes to prevent LanceDB filter injection
      const safeFilter = projectFilter.replace(/["'\\%_]/g, '');
      if (safeFilter) {
        filters.push(`project_path LIKE "%${safeFilter}%"`);
      }
    }
    if (filters.length > 0) {
      const filter = filters.join(' AND ');
      if (searchQuery.where) {
        searchQuery = searchQuery.where(filter);
      }
    }

    const results = await searchQuery.limit(limit).toArray() as Array<{
      item_id: string; source_type: string; title: string; _distance: number;
      chunk_type: string; text: string; project_path: string; file_path: string; mtime: number;
    }>;

    if (results.length === 0) {
      return [];
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

    return searchResults.slice(0, topK);
  }

  async getStats(): Promise<{
    totalChunks: number;
    totalItems: number;
    bySourceType: Record<string, { items: number; chunks: number }>;
    indexPath: string;
  }> {
    await this.connect();

    if (this.table === null) {
      return {
        totalChunks: 0,
        totalItems: 0,
        bySourceType: {},
        indexPath: this.indexPath,
      };
    }

    const data = await this.table.toArrow();
    const rows = data.toArray() as Array<{ item_id: string; source_type: string }>;

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
