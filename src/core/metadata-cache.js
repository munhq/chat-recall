/**
 * SQLite cache for session metadata (summaries, titles).
 * Stores AI-generated summaries for sessions that don't have them.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
export class MetadataCache {
    db;
    static DEFAULT_DB_PATH = join(homedir(), '.claude', 'chat-recall-cache.db');
    constructor(dbPath) {
        const path = dbPath || MetadataCache.DEFAULT_DB_PATH;
        // Ensure directory exists
        const dir = dirname(path);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        this.db = new Database(path);
        this.initSchema();
    }
    initSchema() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_metadata (
        session_id TEXT PRIMARY KEY,
        first_prompt TEXT NOT NULL,
        summary TEXT NOT NULL,
        summary_source TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mtime ON session_metadata(mtime);
      CREATE INDEX IF NOT EXISTS idx_indexed_at ON session_metadata(indexed_at);
      CREATE INDEX IF NOT EXISTS idx_summary_source ON session_metadata(summary_source);
    `);
    }
    set(metadata) {
        const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO session_metadata
      (session_id, first_prompt, summary, summary_source, mtime, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
        stmt.run(metadata.sessionId, metadata.firstPrompt, metadata.summary, metadata.summarySource, metadata.mtime, metadata.indexedAt);
    }
    get(sessionId) {
        const stmt = this.db.prepare(`
      SELECT session_id, first_prompt, summary, summary_source, mtime, indexed_at
      FROM session_metadata
      WHERE session_id = ?
    `);
        const row = stmt.get(sessionId);
        if (!row)
            return null;
        return {
            sessionId: row.session_id,
            firstPrompt: row.first_prompt,
            summary: row.summary,
            summarySource: row.summary_source,
            mtime: row.mtime,
            indexedAt: row.indexed_at,
        };
    }
    needsUpdate(sessionId, currentMtime) {
        const cached = this.get(sessionId);
        return !cached || cached.mtime < currentMtime;
    }
    getStats() {
        const total = this.db
            .prepare('SELECT COUNT(*) as count FROM session_metadata')
            .get();
        const sources = this.db
            .prepare(`
        SELECT summary_source, COUNT(*) as count
        FROM session_metadata
        GROUP BY summary_source
      `)
            .all();
        const bySources = {};
        for (const row of sources) {
            bySources[row.summary_source] = row.count;
        }
        return {
            totalSessions: total.count,
            bySources,
        };
    }
    close() {
        this.db.close();
    }
}
