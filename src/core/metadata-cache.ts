/**
 * SQLite cache for session metadata (summaries, titles).
 * Stores AI-generated summaries for sessions that don't have them.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

export interface SessionMetadata {
  sessionId: string;
  firstPrompt: string;
  summary: string;
  summarySource: 'original' | 'gemini' | 'claude' | 'ollama';
  mtime: number;
  indexedAt: number;
}

export class MetadataCache {
  private db: Database.Database;
  private static readonly DEFAULT_DB_PATH = join(
    homedir(),
    '.claude',
    'chat-recall-cache.db'
  );

  constructor(dbPath?: string) {
    const path = dbPath || MetadataCache.DEFAULT_DB_PATH;

    // Ensure directory exists
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path);
    this.initSchema();
  }

  private initSchema(): void {
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

  set(metadata: SessionMetadata): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO session_metadata
      (session_id, first_prompt, summary, summary_source, mtime, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      metadata.sessionId,
      metadata.firstPrompt,
      metadata.summary,
      metadata.summarySource,
      metadata.mtime,
      metadata.indexedAt
    );
  }

  get(sessionId: string): SessionMetadata | null {
    const stmt = this.db.prepare(`
      SELECT session_id, first_prompt, summary, summary_source, mtime, indexed_at
      FROM session_metadata
      WHERE session_id = ?
    `);

    const row = stmt.get(sessionId) as {
      session_id: string;
      first_prompt: string;
      summary: string;
      summary_source: 'original' | 'gemini' | 'claude' | 'ollama';
      mtime: number;
      indexed_at: number;
    } | undefined;
    if (!row) return null;

    return {
      sessionId: row.session_id,
      firstPrompt: row.first_prompt,
      summary: row.summary,
      summarySource: row.summary_source,
      mtime: row.mtime,
      indexedAt: row.indexed_at,
    };
  }

  needsUpdate(sessionId: string, currentMtime: number): boolean {
    const cached = this.get(sessionId);
    return !cached || cached.mtime < currentMtime;
  }

  getStats(): {
    totalSessions: number;
    bySources: Record<string, number>;
  } {
    const total = this.db
      .prepare('SELECT COUNT(*) as count FROM session_metadata')
      .get() as { count: number };

    const sources = this.db
      .prepare(`
        SELECT summary_source, COUNT(*) as count
        FROM session_metadata
        GROUP BY summary_source
      `)
      .all() as Array<{ summary_source: string; count: number }>;

    const bySources: Record<string, number> = {};
    for (const row of sources) {
      bySources[row.summary_source] = row.count;
    }

    return {
      totalSessions: total.count,
      bySources,
    };
  }

  close(): void {
    this.db.close();
  }
}
