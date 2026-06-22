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
 * Storage is a plain JSON file under the data dir — NOT SQLite. The thin
 * collector has no local database, and this is local client state (it's
 * meaningless on a server and not part of the StorageDriver contract). Keeping
 * it as JSON is what lets the collector ship with zero native modules.
 *
 * Freshness has TWO dimensions, not one:
 *   - mtime: did the source transcript change?
 *   - extractor version: did the code that derives synced rows change?
 * A session is up to date only when BOTH the synced mtime covers the file
 * AND the synced extractor version is current. This is what makes an
 * extraction fix self-heal — see extractor-version.ts.
 *
 * Shape: { "<serverUrl>": { "<sessionId>": <entry>, ... }, ... }
 *   where <entry> is { m: <syncedMtime>, v: <extractorVersion> } — or, for
 *   ledgers written before versioning, a bare <syncedMtime> number (read as
 *   version 0 so every legacy row is treated as extractor-stale once).
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getDataDir } from '@chat-recall/engine/core/paths.js';
import { EXTRACTOR_VERSION } from '@chat-recall/engine/core/extractor-version.js';

/** A synced row: mtime covered + extractor version it was produced under. */
export interface SyncedRow { m: number; v: number; }
/** On disk a row is the new {m,v} shape OR a legacy bare mtime number. */
type LedgerEntry = SyncedRow | number;
type Ledger = Record<string, Record<string, LedgerEntry>>;

/** Normalize either on-disk shape to {m,v}; legacy numbers are version 0. */
function toRow(entry: LedgerEntry | undefined): SyncedRow | undefined {
  if (entry === undefined) return undefined;
  return typeof entry === 'number' ? { m: entry, v: 0 } : entry;
}

const ledgerPath = (): string => join(getDataDir(), 'sync-ledger.json');

// In-memory cache so a sync walk doesn't re-read the file per batch. Loaded
// lazily; writes go through atomic tmp+rename so a crash mid-write can't
// corrupt the ledger (worst case: a session re-uploads, which is safe).
let cache: Ledger | null = null;

function load(): Ledger {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(), 'utf-8'));
    cache = parsed && typeof parsed === 'object' ? (parsed as Ledger) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(data: Ledger): void {
  const path = ledgerPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}

/** session_id → mtime the server has acked, for one target server. */
export function getSyncedMtimes(server: string): Map<string, number> {
  const data = load();
  const out = new Map<string, number>();
  for (const [id, entry] of Object.entries(data[server] || {})) out.set(id, toRow(entry)!.m);
  return out;
}

/**
 * session_id → {mtime, extractorVersion} the server has acked. This is the
 * accessor the freshness gate uses: a session is current only when the synced
 * mtime covers the file AND the synced version is >= EXTRACTOR_VERSION.
 */
export function getSyncedRows(server: string): Map<string, SyncedRow> {
  const data = load();
  const out = new Map<string, SyncedRow>();
  for (const [id, entry] of Object.entries(data[server] || {})) out.set(id, toRow(entry)!);
  return out;
}

/** Raw data for one server, useful when you need to mutate (e.g. tombstones). */
export function getLedgerData(server: string): Record<string, LedgerEntry> {
  const data = load();
  return data[server] || {};
}

/** Persist mutated data for one server. */
export function persistLedgerData(server: string, serverData: Record<string, LedgerEntry>): void {
  const data = load();
  data[server] = serverData;
  persist(data);
}

/**
 * Mark sessions as synced at the given mtimes, stamped with the CURRENT
 * extractor version (after a server ack). The version stamp is what lets a
 * later extraction-code change invalidate these rows for re-sync.
 */
export function markSynced(server: string, rows: Array<{ id: string; mtime: number }>): void {
  if (rows.length === 0) return;
  const data = load();
  const forServer = data[server] || (data[server] = {});
  for (const r of rows) forServer[r.id] = { m: Math.floor(r.mtime), v: EXTRACTOR_VERSION };
  persist(data);
}

/** Test-only: drop the in-memory cache so a fresh file read happens next call. */
export function _resetLedgerCacheForTests(): void {
  cache = null;
}
