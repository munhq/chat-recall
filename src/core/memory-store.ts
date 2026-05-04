/**
 * SQLite storage for memory metadata and links.
 *
 * Adds memory_metadata and memory_links tables to the same SQLite db that
 * holds session_metadata — see `src/core/paths.ts` for the canonical
 * location (env-overridable).
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

import type {
  SourceType,
  MemoryItem,
  MemoryLink,
  MemoryChunk,
  MemoryMetadataRow,
  MemoryLinkRow,
  MemorySearchResult,
} from '../types/memory.js';
import { getCacheDbPath } from './paths.js';

export class MemoryStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath || getCacheDbPath();

    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_metadata (
        id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        title TEXT NOT NULL,
        project_path TEXT NOT NULL DEFAULT '',
        content_preview TEXT NOT NULL DEFAULT '',
        file_path TEXT NOT NULL DEFAULT '',
        mtime INTEGER NOT NULL DEFAULT 0,
        indexed_at INTEGER NOT NULL,
        extra_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (id, source_type)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_source_type
        ON memory_metadata(source_type);
      CREATE INDEX IF NOT EXISTS idx_memory_project
        ON memory_metadata(project_path);
      CREATE INDEX IF NOT EXISTS idx_memory_mtime
        ON memory_metadata(mtime);

      CREATE TABLE IF NOT EXISTS memory_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        UNIQUE(source_type, source_id, target_type, target_id, link_type)
      );

      CREATE TABLE IF NOT EXISTS content_cache (
        id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        content_json TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        PRIMARY KEY (id, source_type)
      );

      -- Generic KV store for agent state. Sits alongside diary (narrative)
      -- and the knowledge graph (structured facts) — KV is the third
      -- primitive: small persistent values keyed by namespaced strings.
      -- Use cases: "current PR url", "branch I'm working on", user prefs.
      CREATE TABLE IF NOT EXISTS kv_store (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv_store(scope);

      CREATE INDEX IF NOT EXISTS idx_links_source
        ON memory_links(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_links_target
        ON memory_links(target_type, target_id);
      CREATE INDEX IF NOT EXISTS idx_links_type
        ON memory_links(link_type);

      -- FTS5 full-text search index for chunk text
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
        chunk_id,
        item_id,
        source_type,
        title,
        text,
        chunk_type,
        project_path,
        file_path,
        mtime UNINDEXED
      );
    `);
  }

  /** Upsert a memory item's metadata */
  setItem(item: MemoryItem): void {
    // When a session is re-indexed, clear cached summary — the content may have
    // changed (e.g., session resumed and migrated to new subagent format).
    // setItem is only called when the indexer decides the item needs updating,
    // so unconditional clear here is safe.
    if (item.sourceType === 'session') {
      this.db.prepare('DELETE FROM session_metadata WHERE session_id = ?').run(item.id);
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_metadata
      (id, source_type, title, project_path, content_preview, file_path, mtime, indexed_at, extra_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      item.id,
      item.sourceType,
      item.title,
      item.projectPath,
      item.contentPreview || '',
      item.filePath,
      item.mtime,
      Date.now(),
      JSON.stringify(item.extra || {})
    );
  }

  /** Get a memory item by ID and source type */
  getItem(id: string, sourceType: SourceType): MemoryMetadataRow | null {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_metadata
      WHERE id = ? AND source_type = ?
    `);
    return (stmt.get(id, sourceType) as MemoryMetadataRow) || null;
  }

  /** Check if an item needs re-indexing based on mtime */
  needsUpdate(id: string, sourceType: SourceType, currentMtime: number): boolean {
    const existing = this.getItem(id, sourceType);
    return !existing || existing.mtime < currentMtime;
  }

  /** Add a link between two memory items */
  addLink(link: MemoryLink): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_links
      (source_type, source_id, target_type, target_id, link_type, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      link.sourceType,
      link.sourceId,
      link.targetType,
      link.targetId,
      link.linkType,
      link.confidence,
      Date.now()
    );
  }

  /** Add multiple links in a transaction */
  addLinks(links: MemoryLink[]): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO memory_links
      (source_type, source_id, target_type, target_id, link_type, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((links: MemoryLink[]) => {
      const now = Date.now();
      for (const link of links) {
        insert.run(
          link.sourceType,
          link.sourceId,
          link.targetType,
          link.targetId,
          link.linkType,
          link.confidence,
          now
        );
      }
    });

    transaction(links);
  }

  /** Get all links FROM a given item */
  getLinksFrom(sourceType: SourceType, sourceId: string): MemoryLinkRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_links
      WHERE source_type = ? AND source_id = ?
    `);
    return stmt.all(sourceType, sourceId) as MemoryLinkRow[];
  }

  /** Get all links TO a given item */
  getLinksTo(targetType: SourceType, targetId: string): MemoryLinkRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_links
      WHERE target_type = ? AND target_id = ?
    `);
    return stmt.all(targetType, targetId) as MemoryLinkRow[];
  }

  /** Get all links involving a given item (both directions) */
  getAllLinks(sourceType: SourceType, itemId: string): MemoryLinkRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_links
      WHERE (source_type = ? AND source_id = ?)
         OR (target_type = ? AND target_id = ?)
    `);
    return stmt.all(sourceType, itemId, sourceType, itemId) as MemoryLinkRow[];
  }

  /** List items by source type filtered by project path (exact or prefix match) */
  listItemsByProject(sourceType: SourceType, projectPath: string, limit = 10): MemoryMetadataRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_metadata
      WHERE source_type = ? AND (project_path = ? OR project_path LIKE ?)
      ORDER BY mtime DESC
      LIMIT ?
    `);
    return stmt.all(sourceType, projectPath, `${projectPath}%`, limit) as MemoryMetadataRow[];
  }

  /**
   * List all sessions across every tool, sorted newest-first. Returns
   * just (id, mtime, tool) — small enough that "give me everything"
   * is fine even on a 10k-session install. Used by the precompute
   * worker to find sessions missing cached compute results.
   */
  listAllSessionsForPrecompute(): Array<{ id: string; mtime: number; tool: string }> {
    const rows = this.db.prepare(`
      SELECT id, mtime, json_extract(extra_json, '$.tool') as tool
      FROM memory_metadata
      WHERE source_type = 'session'
      ORDER BY mtime DESC
    `).all() as Array<{ id: string; mtime: number; tool: string | null }>;
    return rows.map(r => ({ id: r.id, mtime: r.mtime || 0, tool: r.tool || 'claude' }));
  }

  /** List all items of a given source type */
  /**
   * Lightweight (id → project_path) map for all sessions. Used to
   * overlay correct project paths onto live-scan results whose Claude
   * scanner produces a mangled path (chat-recall → chat/recall) by
   * replacing hyphens in the encoded directory name.
   */
  listAllSessionProjectPaths(): Array<{ id: string; project_path: string }> {
    return this.db
      .prepare(`SELECT id, project_path FROM memory_metadata WHERE source_type='session' AND project_path IS NOT NULL AND project_path <> ''`)
      .all() as Array<{ id: string; project_path: string }>;
  }

  /**
   * Sessions whose file mtime is at-or-after `sinceMs`. Used by the
   * Activity timeline to limit cache scans to the relevant window.
   */
  listSessionsModifiedSince(sinceMs: number): Array<{ id: string; mtime: number; project_path: string }> {
    return this.db
      .prepare(`SELECT id, mtime, project_path FROM memory_metadata WHERE source_type='session' AND mtime >= ? ORDER BY mtime DESC`)
      .all(sinceMs) as Array<{ id: string; mtime: number; project_path: string }>;
  }

  /**
   * Lightweight (id → file_path) map for all sessions. Used by the web
   * server's badge/diff/outcome endpoints in place of a filesystem walk.
   * Single SQL query, only the two columns we actually need.
   */
  listAllSessionPaths(): Array<{ id: string; file_path: string }> {
    return this.db
      .prepare(`SELECT id, file_path FROM memory_metadata WHERE source_type='session' AND file_path IS NOT NULL AND file_path <> ''`)
      .all() as Array<{ id: string; file_path: string }>;
  }

  listItems(sourceType: SourceType, limit = 100, offset = 0): MemoryMetadataRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_metadata
      WHERE source_type = ?
      ORDER BY mtime DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(sourceType, limit, offset) as MemoryMetadataRow[];
  }

  /**
   * Sorted/paginated/filtered query over indexed sessions, returning the
   * page rows + total-after-filtering in two SQL statements (no JS sort,
   * no JS slice). Backed by `idx_memory_mtime` so even on a 10k-session
   * install the query is single-digit milliseconds.
   *
   * Tool filter uses `json_extract` on the `extra_json` column. SQLite
   * indexes don't help json_extract directly, but the upstream
   * `source_type='session'` predicate already narrows to the session
   * subset, so the per-row JSON parse cost is bounded.
   *
   * `projectFilter` is a path PREFIX match (so a folder click in the
   * sidebar pulls all descendant sessions). Empty string returns all.
   *
   * Returns `null` when the store is empty so callers can fall back to
   * the filesystem walk during a fresh install before the indexer has
   * populated anything.
   */
  querySessionIndex(opts: {
    limit: number;
    offset: number;
    projectFilter?: string;
    toolFilter?: string;
    sinceMs?: number;
  }): { rows: MemoryMetadataRow[]; total: number } {
    const where: string[] = ["source_type = 'session'"];
    const params: (string | number)[] = [];

    if (opts.projectFilter) {
      where.push('(project_path = ? OR project_path LIKE ?)');
      params.push(opts.projectFilter, opts.projectFilter + '/%');
    }
    if (opts.toolFilter) {
      // Default tool when extra_json doesn't carry one is 'claude' — match
      // both the explicit-tool case and the implicit-claude case.
      if (opts.toolFilter === 'claude') {
        where.push("(json_extract(extra_json, '$.tool') IS NULL OR json_extract(extra_json, '$.tool') = 'claude')");
      } else {
        where.push("json_extract(extra_json, '$.tool') = ?");
        params.push(opts.toolFilter);
      }
    }
    if (opts.sinceMs && Number.isFinite(opts.sinceMs)) {
      where.push('mtime >= ?');
      params.push(opts.sinceMs);
    }

    const whereSQL = where.join(' AND ');

    const total = (this.db.prepare(
      `SELECT COUNT(*) as n FROM memory_metadata WHERE ${whereSQL}`
    ).get(...params) as { n: number }).n;

    const rows = this.db.prepare(
      `SELECT * FROM memory_metadata WHERE ${whereSQL} ORDER BY mtime DESC LIMIT ? OFFSET ?`
    ).all(...params, opts.limit, opts.offset) as MemoryMetadataRow[];

    return { rows, total };
  }

  /** Get counts by source type */
  getStats(): Record<SourceType | string, number> {
    const rows = this.db.prepare(`
      SELECT source_type, COUNT(*) as count
      FROM memory_metadata
      GROUP BY source_type
    `).all() as Array<{ source_type: string; count: number }>;

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.source_type] = row.count;
    }
    return result;
  }

  /** Get total link count */
  getLinkCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM memory_links
    `).get() as { count: number };
    return row.count;
  }

  /** Delete all items and links for a source type */
  clearSourceType(sourceType: SourceType): void {
    this.db.prepare('DELETE FROM memory_metadata WHERE source_type = ?').run(sourceType);
    this.db.prepare('DELETE FROM memory_links WHERE source_type = ? OR target_type = ?').run(sourceType, sourceType);
  }

  /** Delete a specific item and its links */
  deleteItem(id: string, sourceType: SourceType): void {
    this.db.prepare(`
      DELETE FROM memory_metadata WHERE id = ? AND source_type = ?
    `).run(id, sourceType);

    this.db.prepare(`
      DELETE FROM memory_links
      WHERE (source_type = ? AND source_id = ?)
         OR (target_type = ? AND target_id = ?)
    `).run(sourceType, id, sourceType, id);

    // Invalidate cached summary so stale content doesn't survive a session resume/rewrite
    if (sourceType === 'session') {
      this.db.prepare(`DELETE FROM session_metadata WHERE session_id = ?`).run(id);
    }
  }

  /** Update project path for an item */
  updateItemProjectPath(id: string, sourceType: SourceType, projectPath: string): boolean {
    const result = this.db.prepare(`
      UPDATE memory_metadata
      SET project_path = ?
      WHERE id = ? AND source_type = ?
    `).run(projectPath, id, sourceType);

    return result.changes > 0;
  }

  /** Get cached parsed content */
  getCachedContent(id: string, sourceType: string, mtime: number): string | null {
    const row = this.db.prepare(`
      SELECT content_json FROM content_cache
      WHERE id = ? AND source_type = ? AND mtime >= ?
    `).get(id, sourceType, mtime) as { content_json: string } | undefined;
    
    return row?.content_json || null;
  }

  /** Set cached parsed content */
  setCachedContent(id: string, sourceType: string, mtime: number, content: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO content_cache (id, source_type, mtime, content_json)
      VALUES (?, ?, ?, ?)
    `).run(id, sourceType, mtime, content);
  }

  // ── FTS5 full-text search ──────────────────────────────────────

  /** Index chunks into the FTS5 table */
  addChunksFTS(chunks: MemoryChunk[]): number {
    if (chunks.length === 0) return 0;

    const valid = chunks.filter(c => c.text && c.text.trim().length > 0);
    if (valid.length === 0) return 0;

    const insert = this.db.prepare(`
      INSERT INTO memory_chunks_fts(chunk_id, item_id, source_type, title, text, chunk_type, project_path, file_path, mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((chunks: MemoryChunk[]) => {
      for (const c of chunks) {
        insert.run(
          c.chunkId, c.itemId, c.sourceType, c.title,
          c.text, c.chunkType, c.projectPath, c.filePath, c.mtime
        );
      }
    });

    transaction(valid);
    return valid.length;
  }

  /** Delete all FTS5 entries for an item */
  deleteItemFTS(sourceType: string, itemId: string): void {
    this.db.prepare(`
      DELETE FROM memory_chunks_fts WHERE item_id = ? AND source_type = ?
    `).run(itemId, sourceType);
  }

  /** Rebuild the FTS5 index from scratch (use after bulk deletes) */
  rebuildFTS(): void {
    this.db.exec(`INSERT INTO memory_chunks_fts(memory_chunks_fts) VALUES('rebuild')`);
  }

  /** Clear all FTS5 data */
  clearFTS(): void {
    this.db.exec(`DELETE FROM memory_chunks_fts`);
  }

  /** Full-text search across indexed chunks */
  searchFTS(
    query: string,
    options: {
      topK?: number;
      sourceTypes?: SourceType[];
      projectFilter?: string;
    } = {}
  ): MemorySearchResult[] {
    const { topK = 20, sourceTypes, projectFilter } = options;

    // Escape FTS5 special characters and build query
    const ftsQuery = this.buildFTSQuery(query);
    if (!ftsQuery) return [];

    const limit = topK * 5;

    // Build WHERE clauses for post-filtering
    // FTS5 MATCH handles the text search, we filter source_type and project_path after
    let sql = `
      SELECT chunk_id, item_id, source_type, title, text, chunk_type, project_path, file_path, mtime,
             rank
      FROM memory_chunks_fts
      WHERE memory_chunks_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (sourceTypes && sourceTypes.length > 0) {
      const placeholders = sourceTypes.map(() => '?').join(', ');
      sql += ` AND source_type IN (${placeholders})`;
      params.push(...sourceTypes);
    }

    if (projectFilter) {
      sql += ` AND project_path LIKE ?`;
      params.push(`%${projectFilter}%`);
    }

    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    let rows: Array<{
      chunk_id: string; item_id: string; source_type: string;
      title: string; text: string; chunk_type: string;
      project_path: string; file_path: string; mtime: number;
      rank: number;
    }>;

    try {
      rows = this.db.prepare(sql).all(...params) as typeof rows;
    } catch {
      // If FTS query syntax fails, try a simpler approach
      const simpleQuery = query.replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean).join(' OR ');
      if (!simpleQuery) return [];
      params[0] = simpleQuery;
      try {
        rows = this.db.prepare(sql).all(...params) as typeof rows;
      } catch {
        return [];
      }
    }

    if (rows.length === 0) return [];

    // Group by item_id + source_type (same logic as vector search)
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

    for (const row of rows) {
      // FTS5 rank is negative (more negative = better match), normalize to 0-1
      const score = 1 / (1 + Math.abs(row.rank));
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

  /** Get FTS5 chunk count */
  getFTSCount(): number {
    try {
      const row = this.db.prepare(
        `SELECT COUNT(*) as count FROM memory_chunks_fts`
      ).get() as { count: number };
      return row.count;
    } catch {
      return 0;
    }
  }

  /**
   * Count distinct items (e.g. sessions) whose chunks match an FTS5 query.
   *
   * Use this instead of `searchFTS().length` when the caller only needs the
   * total — `searchFTS` caps at `topK * 5` rows internally, so for popular
   * keywords (authentication / docker / api) it would return the cap, not
   * the true count.
   */
  countDistinctItemsMatching(
    query: string,
    options: { sourceTypes?: SourceType[]; projectFilter?: string } = {}
  ): number {
    const ftsQuery = this.buildFTSQuery(query);
    if (!ftsQuery) return 0;

    let sql = `
      SELECT COUNT(DISTINCT item_id) AS n
      FROM memory_chunks_fts
      WHERE memory_chunks_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (options.sourceTypes && options.sourceTypes.length > 0) {
      const placeholders = options.sourceTypes.map(() => '?').join(', ');
      sql += ` AND source_type IN (${placeholders})`;
      params.push(...options.sourceTypes);
    }

    if (options.projectFilter) {
      sql += ` AND project_path LIKE ?`;
      params.push(`%${options.projectFilter}%`);
    }

    try {
      const row = this.db.prepare(sql).get(...params) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch {
      // Match the fallback `searchFTS` uses for unparseable queries.
      const simpleQuery = query
        .replace(/[^a-zA-Z0-9\s]/g, ' ').trim()
        .split(/\s+/).filter(Boolean).join(' OR ');
      if (!simpleQuery) return 0;
      params[0] = simpleQuery;
      try {
        const row = this.db.prepare(sql).get(...params) as { n: number } | undefined;
        return row?.n ?? 0;
      } catch {
        return 0;
      }
    }
  }

  /** Build an FTS5 query from a natural language string */
  private buildFTSQuery(query: string): string {
    // Strip special FTS5 operators, keep words
    const words = query
      .replace(/[^a-zA-Z0-9\s_.-]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 1);

    if (words.length === 0) return '';

    // Search in text and title columns only
    // Use OR to be permissive — the ranking handles relevance
    return `{text title} : ${words.join(' OR ')}`;
  }

  // ── KV store ───────────────────────────────────────────────────
  // The third memory primitive (alongside diary + KG): small persistent
  // values the agent can stash and read back. Scopes namespace keys so
  // an agent can keep per-project / per-task state without collisions.

  /** Set a key/value pair. Overwrites any previous value at (scope, key). */
  kvSet(scope: string, key: string, value: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO kv_store (scope, key, value, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(scope, key, value, Date.now());
  }

  /** Read a value. Returns null if (scope, key) is not set. */
  kvGet(scope: string, key: string): { value: string; updated_at: number } | null {
    const row = this.db.prepare(`
      SELECT value, updated_at FROM kv_store WHERE scope = ? AND key = ?
    `).get(scope, key) as { value: string; updated_at: number } | undefined;
    return row ?? null;
  }

  /** Delete a key. Returns true if a row was removed. */
  kvDelete(scope: string, key: string): boolean {
    const r = this.db.prepare('DELETE FROM kv_store WHERE scope = ? AND key = ?').run(scope, key);
    return r.changes > 0;
  }

  /** List keys in a scope (or all scopes if scope is undefined). */
  kvList(scope?: string, limit = 200): Array<{ scope: string; key: string; value: string; updated_at: number }> {
    if (scope === undefined) {
      return this.db.prepare(`
        SELECT scope, key, value, updated_at FROM kv_store
        ORDER BY updated_at DESC LIMIT ?
      `).all(limit) as any;
    }
    return this.db.prepare(`
      SELECT scope, key, value, updated_at FROM kv_store
      WHERE scope = ? ORDER BY updated_at DESC LIMIT ?
    `).all(scope, limit) as any;
  }

  close(): void {
    this.db.close();
  }
}
