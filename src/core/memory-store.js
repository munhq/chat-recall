/**
 * SQLite storage for memory metadata and links.
 *
 * Adds memory_metadata and memory_links tables to the existing
 * chat-recall-cache.db alongside session_metadata.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
export class MemoryStore {
    db;
    static DEFAULT_DB_PATH = join(homedir(), '.claude', 'chat-recall-cache.db');
    constructor(dbPath) {
        const path = dbPath || MemoryStore.DEFAULT_DB_PATH;
        const dir = dirname(path);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        this.db = new Database(path);
        this.initSchema();
    }
    initSchema() {
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

      CREATE INDEX IF NOT EXISTS idx_links_source
        ON memory_links(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_links_target
        ON memory_links(target_type, target_id);
      CREATE INDEX IF NOT EXISTS idx_links_type
        ON memory_links(link_type);
    `);
    }
    /** Upsert a memory item's metadata */
    setItem(item) {
        const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_metadata
      (id, source_type, title, project_path, content_preview, file_path, mtime, indexed_at, extra_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(item.id, item.sourceType, item.title, item.projectPath, item.contentPreview || '', item.filePath, item.mtime, Date.now(), JSON.stringify(item.extra || {}));
    }
    /** Get a memory item by ID and source type */
    getItem(id, sourceType) {
        const stmt = this.db.prepare(`
      SELECT * FROM memory_metadata
      WHERE id = ? AND source_type = ?
    `);
        return stmt.get(id, sourceType) || null;
    }
    /** Check if an item needs re-indexing based on mtime */
    needsUpdate(id, sourceType, currentMtime) {
        const existing = this.getItem(id, sourceType);
        return !existing || existing.mtime < currentMtime;
    }
    /** Add a link between two memory items */
    addLink(link) {
        const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_links
      (source_type, source_id, target_type, target_id, link_type, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(link.sourceType, link.sourceId, link.targetType, link.targetId, link.linkType, link.confidence, Date.now());
    }
    /** Add multiple links in a transaction */
    addLinks(links) {
        const insert = this.db.prepare(`
      INSERT OR REPLACE INTO memory_links
      (source_type, source_id, target_type, target_id, link_type, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
        const transaction = this.db.transaction((links) => {
            const now = Date.now();
            for (const link of links) {
                insert.run(link.sourceType, link.sourceId, link.targetType, link.targetId, link.linkType, link.confidence, now);
            }
        });
        transaction(links);
    }
    /** Get all links FROM a given item */
    getLinksFrom(sourceType, sourceId) {
        const stmt = this.db.prepare(`
      SELECT * FROM memory_links
      WHERE source_type = ? AND source_id = ?
    `);
        return stmt.all(sourceType, sourceId);
    }
    /** Get all links TO a given item */
    getLinksTo(targetType, targetId) {
        const stmt = this.db.prepare(`
      SELECT * FROM memory_links
      WHERE target_type = ? AND target_id = ?
    `);
        return stmt.all(targetType, targetId);
    }
    /** Get all links involving a given item (both directions) */
    getAllLinks(sourceType, itemId) {
        const stmt = this.db.prepare(`
      SELECT * FROM memory_links
      WHERE (source_type = ? AND source_id = ?)
         OR (target_type = ? AND target_id = ?)
    `);
        return stmt.all(sourceType, itemId, sourceType, itemId);
    }
    /** List all items of a given source type */
    listItems(sourceType, limit = 100, offset = 0) {
        const stmt = this.db.prepare(`
      SELECT * FROM memory_metadata
      WHERE source_type = ?
      ORDER BY mtime DESC
      LIMIT ? OFFSET ?
    `);
        return stmt.all(sourceType, limit, offset);
    }
    /** Get counts by source type */
    getStats() {
        const rows = this.db.prepare(`
      SELECT source_type, COUNT(*) as count
      FROM memory_metadata
      GROUP BY source_type
    `).all();
        const result = {};
        for (const row of rows) {
            result[row.source_type] = row.count;
        }
        return result;
    }
    /** Get total link count */
    getLinkCount() {
        const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM memory_links
    `).get();
        return row.count;
    }
    /** Delete all items and links for a source type */
    clearSourceType(sourceType) {
        this.db.exec(`
      DELETE FROM memory_metadata WHERE source_type = '${sourceType}';
      DELETE FROM memory_links WHERE source_type = '${sourceType}' OR target_type = '${sourceType}';
    `);
    }
    /** Delete a specific item and its links */
    deleteItem(id, sourceType) {
        this.db.prepare(`
      DELETE FROM memory_metadata WHERE id = ? AND source_type = ?
    `).run(id, sourceType);
        this.db.prepare(`
      DELETE FROM memory_links
      WHERE (source_type = ? AND source_id = ?)
         OR (target_type = ? AND target_id = ?)
    `).run(sourceType, id, sourceType, id);
    }
    close() {
        this.db.close();
    }
}
