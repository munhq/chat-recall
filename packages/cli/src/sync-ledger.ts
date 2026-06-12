/**
 * Per-conversation sync ledger — client-side bookkeeping for "is THIS
 * session synced at its current version?".
 *
 * Replaces the global lastSyncAt watermark as the source of truth for
 * incremental sync: every tick walks all sessions, skips the ones whose
 * ledger row already covers their current mtime, pushes the rest, and
 * marks a session ONLY after the server acked the batch containing it.
 * A session that fails to upload stays unmarked and is retried on the
 * next tick — nothing can be silently skipped forever.
 *
 * Keyed by server URL so switching endpoints (self-host ↔ SaaS) restarts
 * coverage for the new target without forgetting the old one.
 *
 * This is deliberately NOT part of the StorageDriver contract — it's
 * local client state, meaningless on a server.
 */
import Database from 'better-sqlite3';
import { getCacheDbPath } from '@chat-recall/engine/core/paths.js';

let db: Database.Database | null = null;
function handle(): Database.Database {
  if (!db) {
    db = new Database(getCacheDbPath());
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_ledger (
        server       TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        synced_mtime INTEGER NOT NULL,
        synced_at    INTEGER NOT NULL,
        PRIMARY KEY (server, session_id)
      );
    `);
  }
  return db;
}

/** session_id → mtime the server has acked, for one target server. */
export function getSyncedMtimes(server: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of handle().prepare(
    `SELECT session_id, synced_mtime FROM sync_ledger WHERE server = ?`,
  ).all(server) as Array<{ session_id: string; synced_mtime: number }>) {
    out.set(r.session_id, r.synced_mtime);
  }
  return out;
}

/** Mark sessions as synced at the given mtimes (after a server ack). */
export function markSynced(server: string, rows: Array<{ id: string; mtime: number }>): void {
  if (rows.length === 0) return;
  const stmt = handle().prepare(`
    INSERT INTO sync_ledger (server, session_id, synced_mtime, synced_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(server, session_id) DO UPDATE SET
      synced_mtime = excluded.synced_mtime,
      synced_at = excluded.synced_at
  `);
  const now = Date.now();
  const tx = handle().transaction((batch: typeof rows) => {
    for (const r of batch) stmt.run(server, r.id, Math.floor(r.mtime), now);
  });
  tx(rows);
}
