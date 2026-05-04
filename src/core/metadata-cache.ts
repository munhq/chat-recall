/**
 * SQLite cache for session metadata (summaries, titles).
 * Stores AI-generated summaries for sessions that don't have them.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { gzipSync, gunzipSync } from 'zlib';
import { getCacheDbPath } from './paths.js';

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

  constructor(dbPath?: string) {
    // Default path resolves through `paths.ts` so a single switch (env
    // var or constant) moves every consumer of the cache at once.
    const path = dbPath || getCacheDbPath();

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

      -- Tracks attempted-but-failed summary generation per session id, so the
      -- background worker can back off retries without losing the failure
      -- reason. Separate table (not a column on session_metadata) because
      -- failed sessions don't have a metadata row yet — they failed before
      -- one could be written. UI surfaces these as "summary unavailable —
      -- check settings" instead of pretending the row doesn't exist.
      CREATE TABLE IF NOT EXISTS summary_errors (
        session_id     TEXT PRIMARY KEY,
        error          TEXT NOT NULL,
        attempt_count  INTEGER NOT NULL DEFAULT 1,
        first_failed_at INTEGER NOT NULL,
        last_failed_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_summary_errors_last ON summary_errors(last_failed_at);

      -- Generic per-session computation cache. Stores JSON-serialized
      -- results of the heavy classifiers (outcome / diff / commits /
      -- markers) keyed by (session_id, kind) and validated by file mtime.
      -- Survives server restarts so the first post-restart open of a
      -- previously-opened session is instant. The "kind" discriminator
      -- means a single session can carry all four cached results in
      -- separate rows without us juggling four tables.
      CREATE TABLE IF NOT EXISTS compute_cache (
        session_id    TEXT NOT NULL,
        kind          TEXT NOT NULL,         -- 'outcome' | 'diff' | 'commits' | 'markers'
        mtime         INTEGER NOT NULL,      -- invalidator
        payload_json  TEXT,                  -- legacy uncompressed path
        payload_gz    BLOB,                  -- preferred: gzipped JSON (5-10x smaller for diffs)
        computed_at   INTEGER NOT NULL,
        PRIMARY KEY (session_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_compute_cache_mtime ON compute_cache(mtime);
      CREATE INDEX IF NOT EXISTS idx_compute_cache_computed_at ON compute_cache(computed_at);
    `);

    // Migration for installs that already have the table from the
    // pre-gzip schema. ALTER TABLE ADD COLUMN is no-op-safe inside a
    // try/catch when the column already exists.
    try { this.db.exec('ALTER TABLE compute_cache ADD COLUMN payload_gz BLOB'); } catch { /* col exists */ }
    // Allow payload_json to be NULL post-migration so new gzip-only rows
    // can be inserted without a dummy text payload. SQLite can't drop
    // NOT NULL on an existing column without a table rebuild — accept
    // the legacy NOT NULL on existing DBs (we always write *something*).
  }

  /**
   * Generic compute cache — persists the output of heavyweight per-session
   * classifiers (outcome, diff, commits, markers) so they survive server
   * restarts. Returns null if the row is stale (mtime moved) or absent.
   *
   * Reads gzip-first (current writes), falls back to plain JSON for rows
   * written by the pre-gzip schema. Decompression is sub-ms even on
   * megabyte payloads.
   */
  getCompute<T>(sessionId: string, kind: string, mtime: number): T | null {
    const row = this.db.prepare(`
      SELECT payload_json, payload_gz FROM compute_cache
      WHERE session_id = ? AND kind = ? AND mtime = ?
    `).get(sessionId, kind, mtime) as { payload_json: string | null; payload_gz: Buffer | null } | undefined;
    if (!row) return null;
    try {
      if (row.payload_gz) {
        return JSON.parse(gunzipSync(row.payload_gz).toString('utf-8')) as T;
      }
      if (row.payload_json) return JSON.parse(row.payload_json) as T;
      return null;
    } catch { return null; }
  }

  /**
   * Persist a heavyweight computation result. Gzips the payload — diffs
   * and outcomes compress 5–10× because they're repetitive text. The
   * compression cost is ~2ms even on megabyte payloads, paid by the
   * write side; reads pay the same on the gunzip but save proportional
   * I/O.
   *
   * Tiny payloads (<1 KB raw) skip compression — gzip overhead exceeds
   * any savings on small data.
   */
  setCompute(sessionId: string, kind: string, mtime: number, data: unknown): void {
    let payload: string;
    try { payload = JSON.stringify(data); }
    catch { return; /* non-serializable — silently skip rather than throw */ }
    // 20 MB raw ceiling. Even a long session's outcome serializes to a
    // few MB max; gzipped that's a few hundred KB. SQLite handles 20MB
    // rows fine; the LRU caps row count.
    if (payload.length > 20_000_000) return;

    let payloadGz: Buffer | null = null;
    let payloadText: string | null = null;
    if (payload.length >= 1024) {
      try { payloadGz = gzipSync(payload, { level: 6 /* default sweet spot */ }); }
      catch { payloadText = payload; /* fall back to plain on gzip failure */ }
    } else {
      // Sub-1KB rows: the gzip framing overhead (10+ bytes) is significant
      // relative to the payload itself; store as plain text instead.
      payloadText = payload;
    }

    // Pre-gzip schema had `payload_json NOT NULL`. SQLite can't drop the
    // constraint without a table rebuild, so we always pass a string for
    // payload_json — empty when the real data is in payload_gz. The
    // reader prefers gz over json so this empty value is never used.
    this.db.prepare(`
      INSERT INTO compute_cache (session_id, kind, mtime, payload_json, payload_gz, computed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, kind) DO UPDATE SET
        mtime=excluded.mtime,
        payload_json=excluded.payload_json,
        payload_gz=excluded.payload_gz,
        computed_at=excluded.computed_at
    `).run(sessionId, kind, mtime, payloadText ?? '', payloadGz, Date.now());
  }

  /** Remove all compute_cache entries for a session — used when the
   *  underlying file is deleted. */
  invalidateCompute(sessionId: string): void {
    this.db.prepare('DELETE FROM compute_cache WHERE session_id = ?').run(sessionId);
  }

  /**
   * Raw compute_cache row (mtime + raw payload columns) without
   * decompressing/parsing. Used by callers that want to bulk-read many
   * rows and decode lazily, or that need the recorded mtime to decide
   * whether the row is fresh enough to use.
   */
  getRawComputeRow(sessionId: string, kind: string): { mtime: number; payload_json: string | null; payload_gz: Buffer | null } | null {
    const row = this.db
      .prepare(`SELECT mtime, payload_json, payload_gz FROM compute_cache WHERE session_id = ? AND kind = ?`)
      .get(sessionId, kind) as { mtime: number; payload_json: string | null; payload_gz: Buffer | null } | undefined;
    return row ?? null;
  }

  /**
   * SaaS-style stale read: return the most-recently-computed row for
   * this (session, kind) regardless of mtime. Used when the route wants
   * to serve a "good-enough" result instantly while a fresh recompute
   * runs in the background. Returns the `mtime` so the caller can mark
   * the response as stale relative to the current file state.
   */
  getComputeStale<T>(sessionId: string, kind: string): { data: T; mtime: number } | null {
    const row = this.db.prepare(`
      SELECT mtime, payload_json, payload_gz FROM compute_cache
      WHERE session_id = ? AND kind = ?
      ORDER BY computed_at DESC
      LIMIT 1
    `).get(sessionId, kind) as { mtime: number; payload_json: string | null; payload_gz: Buffer | null } | undefined;
    if (!row) return null;
    try {
      if (row.payload_gz) {
        return { data: JSON.parse(gunzipSync(row.payload_gz).toString('utf-8')) as T, mtime: row.mtime };
      }
      if (row.payload_json) return { data: JSON.parse(row.payload_json) as T, mtime: row.mtime };
    } catch { /* corrupt row */ }
    return null;
  }

  /**
   * Record a failed summary attempt. Worker uses this to decide backoff —
   * sessions with N>3 failures are skipped until `last_failed_at` is older
   * than the retry window (24h). Stored separately from session_metadata
   * because failed sessions might not have a metadata row yet.
   */
  recordSummaryError(sessionId: string, error: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO summary_errors (session_id, error, attempt_count, first_failed_at, last_failed_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        error=excluded.error,
        attempt_count=summary_errors.attempt_count + 1,
        last_failed_at=excluded.last_failed_at
    `).run(sessionId, error.slice(0, 500), now, now);
  }

  /** Lookup the last error reason — UI shows it as a tooltip. */
  getSummaryError(sessionId: string): { error: string; attemptCount: number; lastFailedAt: number } | null {
    const row = this.db.prepare(`
      SELECT error, attempt_count, last_failed_at
      FROM summary_errors WHERE session_id = ?
    `).get(sessionId) as { error: string; attempt_count: number; last_failed_at: number } | undefined;
    return row ? { error: row.error, attemptCount: row.attempt_count, lastFailedAt: row.last_failed_at } : null;
  }

  /** Bulk: { sessionId → error } for the requested ids. Used by /recent
   *  hydration to attach an `summaryError` field per row. */
  getSummaryErrors(sessionIds: string[]): Map<string, { error: string; attemptCount: number; lastFailedAt: number }> {
    const out = new Map<string, { error: string; attemptCount: number; lastFailedAt: number }>();
    if (sessionIds.length === 0) return out;
    const CHUNK = 500;
    for (let i = 0; i < sessionIds.length; i += CHUNK) {
      const chunk = sessionIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT session_id, error, attempt_count, last_failed_at
        FROM summary_errors WHERE session_id IN (${placeholders})
      `).all(...chunk) as Array<{ session_id: string; error: string; attempt_count: number; last_failed_at: number }>;
      for (const r of rows) out.set(r.session_id, { error: r.error, attemptCount: r.attempt_count, lastFailedAt: r.last_failed_at });
    }
    return out;
  }

  /** Clear an error row — called after a successful retry so the UI flips
   *  from "unavailable" to the new summary. */
  clearSummaryError(sessionId: string): void {
    this.db.prepare('DELETE FROM summary_errors WHERE session_id = ?').run(sessionId);
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
