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

/** Coverage of ONE derived field for one session: the field `version` it was
 *  reconciled at, whether the value was `present` (1) or absent (0 = scanned,
 *  this session has no such field), and the session `mtime` it was scanned at
 *  (so mtime-sensitive fields re-scan when the transcript changes). */
export interface FieldCoverage { v: number; p: 0 | 1; m?: number }
/** A synced row: conversation mtime covered + extractor version it was produced
 *  under, plus per-field coverage `f` for the derived-field reconciliation
 *  (see sync-fields.ts), plus the tail-sync byte offset `o` and file size `s`
 *  (see docs/SYNC-INCREMENTAL.md). The conversation sync owns {m,v,o,s}; field
 *  reconciliation owns `f` — neither path re-does the other's work. */
export interface SyncedRow {
  m: number; v: number; f?: Record<string, FieldCoverage>;
  /** Last byte offset shipped (append-only transcripts). 0 = no tail sync yet
   *  (FULL sync needed or never shipped). >0 = eligible for APPEND from here. */
  o?: number;
  /** File size at the time `o` was captured. Lets the freshness gate detect
   *  growth (append) vs rotation/truncation (shrink → FULL). */
  s?: number;
}
/** On disk a row is the {m,v[,f,o,s]} shape OR a legacy bare mtime number. */
type LedgerEntry = SyncedRow | number;
type Ledger = Record<string, Record<string, LedgerEntry>>;

/** Normalize either on-disk shape to {m,v,f}; legacy numbers are version 0. */
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
 *
 * `offset` and `size` are the tail-sync byte cursor (append-only transcripts).
 * They default to 0 (FULL sync) so callers that don't care about tail sync
 * leave them absent/0 → the next tick treats the session as FULL-eligible
 * only when mtime advances, exactly as before this field existed.
 */
export function markSynced(
  server: string,
  rows: Array<{ id: string; mtime: number; offset?: number; size?: number }>,
): void {
  if (rows.length === 0) return;
  const data = load();
  const forServer = data[server] || (data[server] = {});
  for (const r of rows) {
    // PRESERVE per-field coverage `f` — it's owned by field reconciliation and
    // must survive a conversation re-sync. Overwriting the whole entry here was
    // wiping it, making every reconcile re-scan from scratch.
    const prev = toRow(forServer[r.id]);
    const prevF = prev?.f;
    const prevOS = prev && (prev.o !== undefined || prev.s !== undefined)
      ? { o: prev.o, s: prev.s }
      : {};
    const o = r.offset ?? prevOS.o ?? 0;
    const s = r.size ?? prevOS.s ?? 0;
    const base: SyncedRow = prevF
      ? { m: Math.floor(r.mtime), v: EXTRACTOR_VERSION, f: prevF }
      : { m: Math.floor(r.mtime), v: EXTRACTOR_VERSION };
    if (o > 0 || s > 0) { base.o = o; base.s = s; }
    forServer[r.id] = base;
  }
  persist(data);
}

/**
 * Does `field` need (re)scanning for a session whose ledger row is `row` and
 * whose current transcript mtime is `mtime`? True when never covered, covered
 * at an older field version, or (for mtime-sensitive fields) the transcript
 * moved past the mtime it was scanned at. `force` overrides everything. An
 * absent-but-current field returns false — that's the no-retry guarantee.
 */
export function fieldNeedsScan(
  row: SyncedRow | undefined,
  field: { name: string; version: number; mtimeSensitive: boolean },
  mtime: number,
  force = false,
): boolean {
  if (force) return true;
  const cov = row?.f?.[field.name];
  if (!cov) return true;
  if (cov.v < field.version) return true;
  if (field.mtimeSensitive && (cov.m ?? 0) < Math.floor(mtime)) return true;
  return false;
}

/**
 * Record per-field coverage after the server acked (or, for absent fields,
 * locally). Each row stamps ONE field's {version, present, mtime} onto the
 * session's `f` map WITHOUT touching its {m,v} conversation state or any other
 * field. Preserves/creates the row as needed.
 */
export function markFieldCoverage(
  server: string,
  field: { name: string; version: number },
  rows: Array<{ id: string; present: boolean; mtime: number }>,
): void {
  if (rows.length === 0) return;
  const data = load();
  const forServer = data[server] || (data[server] = {});
  for (const r of rows) {
    const row = toRow(forServer[r.id]) ?? { m: 0, v: 0 };
    const f = row.f ? { ...row.f } : {};
    f[field.name] = { v: field.version, p: r.present ? 1 : 0, m: Math.floor(r.mtime) };
    forServer[r.id] = { ...row, f };
  }
  persist(data);
}

// ── Per-server field-reconciliation state ────────────────────────────────────
// Separate small file: "which fields have I run a FULL backfill pass for, at
// which version, on this server" + a per-field force flag the UI/CLI sets to
// demand a one-time re-scan. The expensive full-list pass runs only when a
// field's version is newer than reconciled, or force is set — otherwise normal
// sync just keeps new/changed sessions covered. Per-session coverage (above) is
// the source of truth for what to scan; this is purely the cost gate.
interface FieldReconcileState { reconciled: Record<string, number>; force: Record<string, boolean> }
type ReconcileFile = Record<string, FieldReconcileState>;
const reconcilePath = (): string => join(getDataDir(), 'sync-field-reconcile.json');
let reconcileCache: ReconcileFile | null = null;

function loadReconcile(): ReconcileFile {
  if (reconcileCache) return reconcileCache;
  try {
    const parsed = JSON.parse(readFileSync(reconcilePath(), 'utf-8'));
    reconcileCache = parsed && typeof parsed === 'object' ? (parsed as ReconcileFile) : {};
  } catch { reconcileCache = {}; }
  return reconcileCache;
}
function persistReconcile(data: ReconcileFile): void {
  const path = reconcilePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}
function stateFor(server: string): FieldReconcileState {
  const data = loadReconcile();
  return data[server] || (data[server] = { reconciled: {}, force: {} });
}

/** True if a one-time FULL backfill pass is owed for `field` on `server` —
 *  either never reconciled at this version, or a re-scan was forced. */
export function fieldNeedsFullPass(server: string, field: { name: string; version: number }): boolean {
  const st = stateFor(server);
  return st.force[field.name] === true || (st.reconciled[field.name] ?? 0) < field.version;
}

/** Mark a field's full backfill pass complete for `server` at `version`, and
 *  clear any force flag. Call only after the whole pass succeeded. */
export function markFieldFullPassDone(server: string, field: { name: string; version: number }): void {
  const data = loadReconcile();
  const st = data[server] || (data[server] = { reconciled: {}, force: {} });
  st.reconciled[field.name] = field.version;
  delete st.force[field.name];
  persistReconcile(data);
}

/** UI/CLI hook: demand a one-time re-scan of `field` (optionally on one server,
 *  else all known servers). Sets the force flag the next sync honors. */
export function forceFieldRescan(fieldName: string, server?: string): void {
  const data = loadReconcile();
  const servers = server ? [server] : Object.keys(data);
  if (servers.length === 0 && server) servers.push(server);
  for (const s of servers) {
    const st = data[s] || (data[s] = { reconciled: {}, force: {} });
    st.force[fieldName] = true;
  }
  persistReconcile(data);
}

/** Test-only: drop the in-memory caches so a fresh file read happens next call. */
export function _resetLedgerCacheForTests(): void {
  cache = null;
  reconcileCache = null;
}

/**
 * Invalidate a session's ledger row so the next sync tick classifies it as
 * FULL (never-synced). Used when the server signals `full_resync_needed` for
 * an append — the client must not retry append (the server lost the prior
 * envelope); it must FULL re-sync. Deleting the row (rather than clearing just
 * o/s) is correct: a FULL re-sync re-derives everything including field
 * coverage `f`, so there's nothing worth preserving. Preserves other sessions.
 */
export function markFullResync(server: string, sessionId: string): void {
  const data = load();
  const forServer = data[server];
  if (!forServer) return;
  if (!(sessionId in forServer)) return;
  delete forServer[sessionId];
  persist(data);
}

// ── Tail-sync mode classification ────────────────────────────────────────────
// See docs/SYNC-INCREMENTAL.md. The freshness gate decides, per session, whether
// this tick should SKIP (already covered), APPEND (ship only the new tail from
// the last byte offset), or FULL (re-parse + re-ship the whole conversation).

export type SyncMode = 'skip' | 'append' | 'full';

/**
 * Classify one session's sync mode for this tick.
 *
 * @param row        ledger row for this session (undefined = never synced)
 * @param mtime      current transcript mtime (ms, floored)
 * @param fileSize   current transcript byte size (0 when unknown / not append-only)
 * @param extractorVersion current EXTRACTOR_VERSION
 * @param isAppendOnly  whether the backend's transcript is an append-only file
 *                      (Claude/Gemini/Codex JSONL = true; OpenCode SQLite = false)
 */
export function syncMode(
  row: SyncedRow | undefined,
  mtime: number,
  fileSize: number,
  extractorVersion: number,
  isAppendOnly: boolean,
): SyncMode {
  // Never synced → FULL.
  if (!row) return 'full';
  // Extractor version bump → FULL (re-derive everything, even if mtime unchanged).
  if (row.v < extractorVersion) return 'full';
  const offset = row.o ?? 0;
  // Append-only file shrank below the last cursor (rotation/truncation/compaction)
  // → the cursor is invalid; FULL re-sync.
  if (isAppendOnly && offset > 0 && fileSize > 0 && fileSize < offset) return 'full';
  // Append-only file that grew since the last ship (size increased), with a
  // valid prior offset → APPEND. Checked BEFORE skip because mtime can have
  // coarse (second-level) granularity on some filesystems while size is the
  // real growth signal — a sub-second append may not move mtime but does grow
  // the file. (Shrink already handled above; size>=offset guaranteed here.)
  //
  // Safe now: the server enforces an OFFSET-CONTINUITY GUARD — an append only
  // merges when the tail's base_offset equals the server's synced-through `o`,
  // else it returns full_resync_needed and the client falls back to FULL. That
  // catches the truncated/stale base that the original append blindly extended
  // (a 1079-msg session once stored as 65). Default ON; CHAT_RECALL_TAIL_APPEND=0
  // is the emergency off-switch. See docs/SYNC-INCREMENTAL.md.
  if (process.env.CHAT_RECALL_TAIL_APPEND !== '0' &&
      isAppendOnly && fileSize > 0 && offset > 0 && fileSize > (row.s ?? 0)) {
    return 'append';
  }
  // mtime unchanged → the last sync (FULL or APPEND) covered this version of
  // the file. SKIP. The byte cursor is NOT a skip prerequisite — a FULL sync
  // that didn't record an offset still shipped the whole file at this mtime.
  if (row.m >= Math.floor(mtime)) return 'skip';
  // Everything else (mtime moved on a non-append-only backend, first tail sync
  // with no prior offset, …) → FULL.
  return 'full';
}
