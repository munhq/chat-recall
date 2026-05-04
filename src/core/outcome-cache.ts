/**
 * Persistent SQLite cache for session outcome classifications.
 *
 * Why this exists:
 *   The badge endpoint and the Outcome tab both classify sessions. Even
 *   the cheap quick-classifier costs ~1.6ms of work, and the full
 *   `computeOutcome` costs 200ms–2s (full JSONL parse + replay + git log
 *   per touched repo). Re-doing that work on every page load — for the
 *   *same unchanged file* — is what makes the UI feel sluggish.
 *
 * What it stores:
 *   One row per session id, holding the most recent classification result
 *   plus invalidator fields (`file_mtime`, `file_size`) so we know when
 *   the cached row is still authoritative.
 *
 * Invalidation rule:
 *   A row is fresh when both `file_mtime` and `file_size` match the
 *   current on-disk values. mtime alone can lie (touch, restored backups,
 *   filesystem clock skew); pairing it with size catches the cases mtime
 *   misses without forcing a content hash.
 *
 * Two-level result tracking:
 *   `is_full = 0` means the row was filled by the quick classifier — it
 *   has the cheap status (in_progress / completed / interrupted) but no
 *   shipped/abandoned distinction. `is_full = 1` means `computeOutcome`
 *   ran (typically because the user opened the Outcome tab) and the row
 *   carries the rich status, file change counts, and commit count. The
 *   badge endpoint prefers `is_full=1` rows when available — so over time
 *   list badges upgrade from "✓ completed" to "🚢 shipped" / "🪦 abandoned"
 *   as users browse sessions.
 *
 * Schema is auto-created on first open. Lives next to the existing
 * MetadataCache — see `src/core/paths.ts` for the canonical location.
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'fs';
import { dirname } from 'path';
import { getCacheDbPath } from './paths.js';

export type CachedOutcomeStatus =
  | 'in_progress'
  | 'completed'
  | 'interrupted'
  | 'shipped'
  | 'abandoned'
  | 'unknown';

export interface CachedOutcome {
  sessionId: string;
  tool: string;
  status: CachedOutcomeStatus;
  reason: string;
  fileMtime: number;
  fileSize: number;
  /**
   * Content fingerprint — short SHA1 of the last 4 KB of the file. Sessions
   * are append-only JSONL, so any real content change lands in the tail.
   * Lets us distinguish "mtime moved but bytes unchanged" (touch, backup
   * restore) from "actual append" without hashing the whole file. Empty
   * string when not applicable (mtime-only tools like Gemini/OpenCode).
   */
  contentHash: string;
  fileCount: number;
  linesAdded: number;
  linesRemoved: number;
  commits: number;
  isFull: boolean;
  classifiedAt: number;
  /**
   * For incremental in_progress updates: the byte offset we'd resume
   * scanning from on the next refresh. 0 when not applicable. Set this
   * to the file size at the time of the last full scan so the next pass
   * only reads the new bytes.
   */
  lastScannedOffset: number;
}

export class OutcomeCache {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath || getCacheDbPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(path);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_outcome_cache (
        session_id           TEXT PRIMARY KEY,
        tool                 TEXT NOT NULL,
        status               TEXT NOT NULL,
        reason               TEXT NOT NULL,
        file_mtime           INTEGER NOT NULL,
        file_size            INTEGER NOT NULL,
        content_hash         TEXT NOT NULL DEFAULT '',
        file_count           INTEGER NOT NULL DEFAULT 0,
        lines_added          INTEGER NOT NULL DEFAULT 0,
        lines_removed        INTEGER NOT NULL DEFAULT 0,
        commits              INTEGER NOT NULL DEFAULT 0,
        is_full              INTEGER NOT NULL DEFAULT 0,
        classified_at        INTEGER NOT NULL,
        last_scanned_offset  INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_outcome_cache_classified_at
        ON session_outcome_cache(classified_at);
      CREATE INDEX IF NOT EXISTS idx_outcome_cache_tool
        ON session_outcome_cache(tool);
    `);

    // Migration for installs that already have the table from earlier
    // builds. ALTER TABLE ADD COLUMN is no-op-safe inside a try/catch when
    // the column already exists (SQLite lacks IF NOT EXISTS for columns).
    try {
      this.db.exec(`ALTER TABLE session_outcome_cache ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`);
    } catch { /* column already exists */ }
  }

  /** Lookup one. Caller checks freshness via `isFresh()` against on-disk stat. */
  get(sessionId: string): CachedOutcome | null {
    const row = this.db.prepare(`
      SELECT session_id, tool, status, reason, file_mtime, file_size, content_hash,
             file_count, lines_added, lines_removed, commits, is_full,
             classified_at, last_scanned_offset
      FROM session_outcome_cache
      WHERE session_id = ?
    `).get(sessionId) as CacheRow | undefined;
    return row ? rowToCached(row) : null;
  }

  /** Bulk lookup — single SQL query, returned as a Map for O(1) callsite use. */
  getMany(sessionIds: string[]): Map<string, CachedOutcome> {
    const out = new Map<string, CachedOutcome>();
    if (sessionIds.length === 0) return out;

    // SQLite has a default parameter limit (typically 999). Chunk to be safe.
    const CHUNK = 500;
    for (let i = 0; i < sessionIds.length; i += CHUNK) {
      const chunk = sessionIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT session_id, tool, status, reason, file_mtime, file_size, content_hash,
               file_count, lines_added, lines_removed, commits, is_full,
               classified_at, last_scanned_offset
        FROM session_outcome_cache
        WHERE session_id IN (${placeholders})
      `).all(...chunk) as CacheRow[];
      for (const r of rows) out.set(r.session_id, rowToCached(r));
    }
    return out;
  }

  /** Upsert one. */
  put(rec: Omit<CachedOutcome, 'classifiedAt'> & { classifiedAt?: number }): void {
    const classifiedAt = rec.classifiedAt ?? Date.now();
    this.db.prepare(`
      INSERT INTO session_outcome_cache
        (session_id, tool, status, reason, file_mtime, file_size, content_hash,
         file_count, lines_added, lines_removed, commits, is_full,
         classified_at, last_scanned_offset)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        tool=excluded.tool,
        status=excluded.status,
        reason=excluded.reason,
        file_mtime=excluded.file_mtime,
        file_size=excluded.file_size,
        content_hash=excluded.content_hash,
        file_count=excluded.file_count,
        lines_added=excluded.lines_added,
        lines_removed=excluded.lines_removed,
        commits=excluded.commits,
        -- Never downgrade is_full=1 to is_full=0. A quick re-classify after
        -- a full one shouldn't lose the rich data we already paid to compute.
        is_full=CASE WHEN excluded.is_full = 1 THEN 1 ELSE session_outcome_cache.is_full END,
        classified_at=excluded.classified_at,
        last_scanned_offset=excluded.last_scanned_offset
    `).run(
      rec.sessionId,
      rec.tool,
      rec.status,
      rec.reason,
      rec.fileMtime,
      rec.fileSize,
      rec.contentHash,
      rec.fileCount,
      rec.linesAdded,
      rec.linesRemoved,
      rec.commits,
      rec.isFull ? 1 : 0,
      classifiedAt,
      rec.lastScannedOffset,
    );
  }

  /** Bulk upsert in a single transaction — much faster than N puts. */
  putMany(records: Array<Omit<CachedOutcome, 'classifiedAt'> & { classifiedAt?: number }>): void {
    if (records.length === 0) return;
    const tx = this.db.transaction((recs: typeof records) => {
      for (const r of recs) this.put(r);
    });
    tx(records);
  }

  /** Remove a row — used when a session file is deleted. */
  invalidate(sessionId: string): void {
    this.db.prepare('DELETE FROM session_outcome_cache WHERE session_id = ?').run(sessionId);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Cache freshness predicate.
 *
 * Two-step validity check:
 *
 *   1. **Fast path**: mtime AND size both match. Files that haven't been
 *      touched are obviously identical — no point hashing.
 *
 *   2. **Hash path**: mtime or size differ. The cached row could still be
 *      valid (e.g. after a `touch` or backup restore that left content
 *      unchanged). Compute a content fingerprint and compare. Pass the
 *      current `contentHash` from `fingerprintFile()` — only computed
 *      when the fast path misses, so most cache hits cost zero hashing.
 *
 * Pass `currentContentHash = ''` and `cached.contentHash = ''` to disable
 * the hash check (used for tools without a tail-scannable file: Gemini
 * and OpenCode classifications fall back to mtime equality).
 */
export function isFresh(
  cached: CachedOutcome | null,
  currentMtime: number,
  currentSize: number,
  currentContentHash?: string,
): boolean {
  if (!cached) return false;
  if (cached.fileMtime === currentMtime && cached.fileSize === currentSize) return true;
  // mtime/size moved. If both sides have a content hash, accept the row
  // when hashes match (touch / backup restore — content unchanged).
  if (currentContentHash && cached.contentHash && currentContentHash === cached.contentHash) {
    return true;
  }
  return false;
}

/**
 * Short SHA1 of the last 4 KB of a file. Sessions are append-only JSONL,
 * so any real change touches the tail; this catches all real changes
 * cheaply (~0.05ms even for huge files) and stays stable across `touch`
 * and other no-op mtime updates.
 *
 * Returns '' when the file can't be read — caller should treat that as
 * "no fingerprint available" and rely on mtime+size alone.
 */
export function fingerprintFile(filePath: string): string {
  let fd = -1;
  try {
    const stat = statSync(filePath);
    if (stat.size === 0) return 'empty';
    const TAIL = 4 * 1024;
    const length = Math.min(stat.size, TAIL);
    const offset = Math.max(0, stat.size - length);
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    const bytesRead = readSync(fd, buf, 0, length, offset);
    const hash = createHash('sha1').update(buf.subarray(0, bytesRead)).digest('hex');
    // 16 hex chars (64 bits) is plenty for collision resistance in this
    // local-only validity check, and keeps the cache row small.
    return hash.slice(0, 16);
  } catch {
    return '';
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch {}
    }
  }
}

interface CacheRow {
  session_id: string;
  tool: string;
  status: string;
  reason: string;
  file_mtime: number;
  file_size: number;
  content_hash: string;
  file_count: number;
  lines_added: number;
  lines_removed: number;
  commits: number;
  is_full: number;
  classified_at: number;
  last_scanned_offset: number;
}

function rowToCached(r: CacheRow): CachedOutcome {
  return {
    sessionId: r.session_id,
    tool: r.tool,
    status: r.status as CachedOutcomeStatus,
    reason: r.reason,
    fileMtime: r.file_mtime,
    fileSize: r.file_size,
    contentHash: r.content_hash || '',
    fileCount: r.file_count,
    linesAdded: r.lines_added,
    linesRemoved: r.lines_removed,
    commits: r.commits,
    isFull: r.is_full === 1,
    classifiedAt: r.classified_at,
    lastScannedOffset: r.last_scanned_offset,
  };
}
