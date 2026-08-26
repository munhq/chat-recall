import { currentTenant, currentAuthor } from './tenant-context.js';
/**
 * Async drivers for the two other cache.db-backed stores:
 *   - MetadataCache — session metadata, summaries, per-session compute cache,
 *     summary-error tracking.
 *   - OutcomeCache  — cached session outcome classifications.
 *
 * Same approach as StorageDriver (store/driver.ts): the interface is derived
 * from the existing class's method types, the SQLite impl wraps the sync
 * class, the Postgres impl is a typed stub filled in P1. Bound to the same
 * `storage` flag via resolveBackend().
 */

import { gzipSync, gunzipSync } from 'zlib';
import type { MetadataCache } from '../metadata-cache.js';
import type { OutcomeCache } from '../outcome-cache.js';
import { resolveBackend, type CreateStoreOptions } from './index.js';
import { openPgPool, openPgPoolRo, ensurePgSchema, pgTenant, tenantQuery, tenantQueryRo } from './pg-pool.js';

// Postgres BIGINT columns reject the fractional `stat.mtimeMs` values that
// SQLite stores verbatim. Floor to whole ms at every pg bind and mtime
// comparison so writes, equality-reads, and needsUpdate behave identically
// to the SQLite path. See store/pg.ts `intMs` for the longer rationale.
const intMs = (x: unknown): number => Math.floor(Number(x) || 0);

type AsyncMethod<M> = M extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

/** Decode a compute_cache row payload (gzip-first, JSON fallback). Shared by
 *  the Postgres MetadataCache getCompute/getComputeStale. */
function decodeComputePayload(r: any): unknown {
  if (!r) return null;
  try {
    if (r.payload_gz) return JSON.parse(gunzipSync(r.payload_gz).toString('utf-8'));
    if (r.payload_json) return JSON.parse(r.payload_json);
  } catch { /* corrupt row */ }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// MetadataCache
// ──────────────────────────────────────────────────────────────────

export interface MetadataCacheDriver {
  setCompute: AsyncMethod<MetadataCache['setCompute']>;
  invalidateCompute: AsyncMethod<MetadataCache['invalidateCompute']>;
  getRawComputeRow: AsyncMethod<MetadataCache['getRawComputeRow']>;
  getCompute<T = unknown>(sessionId: string, kind: string, mtime: number): Promise<T | null>;
  getComputeStale<T = unknown>(sessionId: string, kind: string): Promise<{ data: T; mtime: number } | null>;
  recordSummaryError: AsyncMethod<MetadataCache['recordSummaryError']>;
  getSummaryError: AsyncMethod<MetadataCache['getSummaryError']>;
  getSummaryErrors: AsyncMethod<MetadataCache['getSummaryErrors']>;
  clearSummaryError: AsyncMethod<MetadataCache['clearSummaryError']>;
  set: AsyncMethod<MetadataCache['set']>;
  setUserTitle: AsyncMethod<MetadataCache['setUserTitle']>;
  setToolTitle: AsyncMethod<MetadataCache['setToolTitle']>;
  get: AsyncMethod<MetadataCache['get']>;
  needsUpdate: AsyncMethod<MetadataCache['needsUpdate']>;
  getStats: AsyncMethod<MetadataCache['getStats']>;
  close: AsyncMethod<MetadataCache['close']>;
}

type MArgs<M extends keyof MetadataCache> = MetadataCache[M] extends (...a: infer A) => any ? A : never;

/**
 * Prompt count of a `markers` compute payload. `null` when the value isn't
 * shaped like one, so non-markers kinds and malformed rows are never guarded.
 */
export function markersPromptCount(data: unknown): number | null {
  const prompts = (data as { prompts?: unknown } | null | undefined)?.prompts;
  return Array.isArray(prompts) ? prompts.length : null;
}

/**
 * Shrink guard for DERIVED rows, mirroring the rule `putRawSession` already
 * enforces for the raw archive (`store/pg.ts:959` —
 * `if (uncompressedSize < existing.size) return 'shrink-protected'`).
 *
 * Why this is needed: the raw archive was shrink-protected but `compute_cache`
 * was not, and the two are written in the SAME sync. When a transcript is
 * truncated upstream (a compaction rewrite, or a consolidation script mirroring
 * a shorter file over a longer one), the archive refuses the downgrade while the
 * derived `markers` row accepts it. The result is the UI and the MCP disagreeing
 * about the same session — measured on a real session: 1035 messages / 67 user
 * prompts in the archive-backed envelope versus 3 prompts in the markers row.
 *
 * Only `markers` is guarded today because prompt count is a meaningful measure
 * of fullness for it. `diff`/`outcome`/`commits` legitimately change shape
 * rather than grow, so they are left alone.
 *
 * Escape hatch: `invalidateCompute(sessionId)` deletes the rows, after which any
 * payload lands. `chat-recall repair` is the intended way to make a session
 * fuller — like the raw guard, this one only ever blocks a REDUCTION.
 */
export async function computeShrinkRefused(
  kind: string,
  data: unknown,
  readStale: (kind: string) => Promise<{ data: unknown } | null>,
): Promise<boolean> {
  if (kind !== 'markers') return false;
  const incoming = markersPromptCount(data);
  if (incoming === null) return false;
  const existing = await readStale(kind);
  const stored = existing ? markersPromptCount(existing.data) : null;
  return stored !== null && incoming < stored;
}

export class SqliteMetadataCache implements MetadataCacheDriver {
  readonly inner: MetadataCache;
  constructor(inner: MetadataCache) { this.inner = inner; }

  async setCompute(...a: MArgs<'setCompute'>) {
    const [sessionId, kind, , data] = a;
    if (await computeShrinkRefused(kind, data, (k) => this.getComputeStale(sessionId, k))) return;
    return this.inner.setCompute(...a);
  }
  async invalidateCompute(...a: MArgs<'invalidateCompute'>) { return this.inner.invalidateCompute(...a); }
  async getRawComputeRow(...a: MArgs<'getRawComputeRow'>) { return this.inner.getRawComputeRow(...a); }
  async getCompute<T = unknown>(sessionId: string, kind: string, mtime: number) { return this.inner.getCompute<T>(sessionId, kind, mtime); }
  async getComputeStale<T = unknown>(sessionId: string, kind: string) { return this.inner.getComputeStale<T>(sessionId, kind); }
  async recordSummaryError(...a: MArgs<'recordSummaryError'>) { return this.inner.recordSummaryError(...a); }
  async getSummaryError(...a: MArgs<'getSummaryError'>) { return this.inner.getSummaryError(...a); }
  async getSummaryErrors(...a: MArgs<'getSummaryErrors'>) { return this.inner.getSummaryErrors(...a); }
  async clearSummaryError(...a: MArgs<'clearSummaryError'>) { return this.inner.clearSummaryError(...a); }
  async set(...a: MArgs<'set'>) { return this.inner.set(...a); }
  async setUserTitle(...a: MArgs<'setUserTitle'>) { return this.inner.setUserTitle(...a); }
  async setToolTitle(...a: MArgs<'setToolTitle'>) { return this.inner.setToolTitle(...a); }
  async get(...a: MArgs<'get'>) { return this.inner.get(...a); }
  async needsUpdate(...a: MArgs<'needsUpdate'>) { return this.inner.needsUpdate(...a); }
  async getStats(...a: MArgs<'getStats'>) { return this.inner.getStats(...a); }
  async close(...a: MArgs<'close'>) { return this.inner.close(...a); }
}

export class PgMetadataCache implements MetadataCacheDriver {
  private pool: any;
  private poolRo: any;
  private readonly t: string;
  constructor(private readonly databaseUrl?: string, tenant?: string) { this.t = pgTenant(tenant); }
  async init(): Promise<void> { this.pool = await openPgPool(this.databaseUrl); this.poolRo = await openPgPoolRo(); await ensurePgSchema(this.databaseUrl); }
  private async q(sql: string, params: unknown[] = []): Promise<any[]> { return (await tenantQuery(this.pool, this.t, sql, params)).rows; }
  // Read-replica variant for pure, lag-tolerant cache LOOKUPS (a stale miss just
  // recomputes). Falls back to the primary pool when no RO DSN is configured.
  private async qRo(sql: string, params: unknown[] = []): Promise<any[]> { return (await tenantQueryRo(this.poolRo, this.pool, this.t, sql, params)).rows; }

  async setCompute(...a: MArgs<'setCompute'>) {
    const [sessionId, kind, mtime, data] = a;
    if (await computeShrinkRefused(kind, data, (k) => this.getComputeStale(sessionId, k))) return;
    let payload: string;
    try { payload = JSON.stringify(data); } catch { return; }
    if (payload.length > 20_000_000) return;
    let gz: Buffer | null = null; let text: string | null = null;
    if (payload.length >= 1024) { try { gz = gzipSync(payload, { level: 6 }); } catch { text = payload; } } else text = payload;
    await this.q(
      `INSERT INTO compute_cache (tenant,session_id,kind,mtime,payload_json,payload_gz,computed_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant,session_id,kind) DO UPDATE SET mtime=excluded.mtime, payload_json=excluded.payload_json, payload_gz=excluded.payload_gz, computed_at=excluded.computed_at`,
      [this.t, sessionId, kind, intMs(mtime), text ?? '', gz, Date.now()]);
  }
  async invalidateCompute(...a: MArgs<'invalidateCompute'>) {
    await this.q(`DELETE FROM compute_cache WHERE tenant=$1 AND session_id=$2`, [this.t, a[0]]);
  }
  async getRawComputeRow(...a: MArgs<'getRawComputeRow'>) {
    const r = (await this.qRo(`SELECT mtime, payload_json, payload_gz FROM compute_cache WHERE tenant=$1 AND session_id=$2 AND kind=$3`, [this.t, a[0], a[1]]))[0];
    return r ? { mtime: r.mtime, payload_json: r.payload_json ?? null, payload_gz: r.payload_gz ?? null } : null;
  }
  async getCompute<T = unknown>(sessionId: string, kind: string, mtime: number) {
    const r = (await this.qRo(`SELECT payload_json, payload_gz FROM compute_cache WHERE tenant=$1 AND session_id=$2 AND kind=$3 AND mtime=$4`, [this.t, sessionId, kind, intMs(mtime)]))[0];
    return decodeComputePayload(r) as T | null;
  }
  async getComputeStale<T = unknown>(sessionId: string, kind: string) {
    const r = (await this.qRo(`SELECT mtime, payload_json, payload_gz FROM compute_cache WHERE tenant=$1 AND session_id=$2 AND kind=$3 ORDER BY computed_at DESC LIMIT 1`, [this.t, sessionId, kind]))[0];
    if (!r) return null;
    const data = decodeComputePayload(r);
    return data === null ? null : { data: data as T, mtime: r.mtime };
  }
  async recordSummaryError(...a: MArgs<'recordSummaryError'>) {
    const now = Date.now();
    await this.q(
      `INSERT INTO summary_errors (tenant,session_id,error,attempt_count,first_failed_at,last_failed_at) VALUES ($1,$2,$3,1,$4,$4)
       ON CONFLICT (tenant,session_id) DO UPDATE SET error=excluded.error, attempt_count=summary_errors.attempt_count+1, last_failed_at=excluded.last_failed_at`,
      [this.t, a[0], a[1].slice(0, 500), now]);
  }
  async getSummaryError(...a: MArgs<'getSummaryError'>) {
    const r = (await this.qRo(`SELECT error, attempt_count, last_failed_at FROM summary_errors WHERE tenant=$1 AND session_id=$2`, [this.t, a[0]]))[0];
    return r ? { error: r.error, attemptCount: r.attempt_count, lastFailedAt: r.last_failed_at } : null;
  }
  async getSummaryErrors(...a: MArgs<'getSummaryErrors'>) {
    const out = new Map<string, { error: string; attemptCount: number; lastFailedAt: number }>();
    if (!a[0].length) return out;
    for (const r of await this.qRo(`SELECT session_id, error, attempt_count, last_failed_at FROM summary_errors WHERE tenant=$1 AND session_id = ANY($2)`, [this.t, a[0]]))
      out.set(r.session_id, { error: r.error, attemptCount: r.attempt_count, lastFailedAt: r.last_failed_at });
    return out;
  }
  async clearSummaryError(...a: MArgs<'clearSummaryError'>) {
    await this.q(`DELETE FROM summary_errors WHERE tenant=$1 AND session_id=$2`, [this.t, a[0]]);
  }
  async set(...a: MArgs<'set'>) {
    const m = a[0];
    // Stamp the ambient author so the author_write_insert RLS guard accepts a
    // NAMED member's write (author_sub must equal app.viewer for a named viewer;
    // '*'/'' worker/self-host are unrestricted). reverse-COALESCE preserves an
    // existing author on conflict — a later worker summary pass never flips it.
    const au = currentAuthor();
    await this.q(
      `INSERT INTO session_metadata (tenant,session_id,first_prompt,summary,summary_source,mtime,indexed_at,author_sub,author_device) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant,session_id) DO UPDATE SET first_prompt=excluded.first_prompt, summary=excluded.summary, summary_source=excluded.summary_source, mtime=excluded.mtime, indexed_at=excluded.indexed_at,
         author_sub=COALESCE(session_metadata.author_sub, excluded.author_sub),
         author_device=COALESCE(session_metadata.author_device, excluded.author_device)`,
      [this.t, m.sessionId, m.firstPrompt, m.summary, m.summarySource, intMs(m.mtime), m.indexedAt, au.sub, au.device]);
  }
  async setUserTitle(sessionId: string, title: string | null) {
    // Touches only user_title; the summary/indexer set() above never does, so
    // the two writers can't clobber each other. Stub-row insert mirrors SQLite.
    // author_sub/device are stamped on INSERT and CLAIMED on conflict (reverse-
    // COALESCE): a first-touch by a named member must attribute to them
    // (author_write_insert), and updating a legacy NULL-author row must claim it
    // to the writer so the post-update row passes author_write_update's WITH
    // CHECK (author_sub = app.viewer). An existing named author is preserved. Made
    // self-sufficient (not reliant on set() running first) so any single writer
    // satisfies the guard on its own.
    const au = currentAuthor();
    // Parent-guarded for the same reason as setToolTitle below — an orphan row
    // here is permanently un-updatable under the author_visibility policy.
    await this.q(
      `INSERT INTO session_metadata (tenant,session_id,first_prompt,summary,summary_source,mtime,indexed_at,user_title,author_sub,author_device)
       SELECT $1,$2,'','','original',0,$3,$4,$5,$6
       WHERE EXISTS (SELECT 1 FROM memory_metadata m
                     WHERE m.tenant=$1 AND m.id=$2 AND m.source_type='session')
       ON CONFLICT (tenant,session_id) DO UPDATE SET user_title=excluded.user_title,
         author_sub=COALESCE(session_metadata.author_sub, excluded.author_sub),
         author_device=COALESCE(session_metadata.author_device, excluded.author_device)`,
      [this.t, sessionId, Date.now(), title, au.sub, au.device]);
  }
  async setToolTitle(sessionId: string, title: string | null) {
    // Native tool title (synced); touches only tool_title. Same author
    // stamp-on-insert + claim-on-conflict rationale as setUserTitle — updating a
    // legacy NULL-author row (the pre-attribution backlog) must claim it or the
    // write-guard's UPDATE WITH CHECK rejects the sync.
    const au = currentAuthor();
    // INSERT ONLY IF THE CONVERSATION EXISTS.
    //
    // A blind upsert here created `session_metadata` rows for sessions with no
    // `memory_metadata` parent. The `author_visibility` SELECT policy hides
    // parentless rows unless app.viewer='*' (the sync path sets the author's sub,
    // deliberately), and ON CONFLICT DO UPDATE must READ the conflicting row — so
    // once such a row existed, every later field sync failed with
    // "new row violates row-level security policy author_visibility" and returned
    // 500. Self-perpetuating and silent: 4 rows sat stuck from 2026-07-22, and
    // ordinary conversation pushes kept succeeding so nothing looked wrong.
    //
    // Guarding the insert on the parent keeps first-write working for real
    // sessions while making the orphan state unreachable.
    await this.q(
      `INSERT INTO session_metadata (tenant,session_id,first_prompt,summary,summary_source,mtime,indexed_at,tool_title,author_sub,author_device)
       SELECT $1,$2,'','','original',0,$3,$4,$5,$6
       WHERE EXISTS (SELECT 1 FROM memory_metadata m
                     WHERE m.tenant=$1 AND m.id=$2 AND m.source_type='session')
       ON CONFLICT (tenant,session_id) DO UPDATE SET tool_title=excluded.tool_title,
         author_sub=COALESCE(session_metadata.author_sub, excluded.author_sub),
         author_device=COALESCE(session_metadata.author_device, excluded.author_device)`,
      [this.t, sessionId, Date.now(), title, au.sub, au.device]);
  }
  async get(...a: MArgs<'get'>) {
    const r = (await this.q(`SELECT session_id, first_prompt, summary, summary_source, mtime, indexed_at, user_title, tool_title FROM session_metadata WHERE tenant=$1 AND session_id=$2`, [this.t, a[0]]))[0];
    return r ? { sessionId: r.session_id, firstPrompt: r.first_prompt, summary: r.summary, summarySource: r.summary_source, mtime: r.mtime, indexedAt: r.indexed_at, userTitle: r.user_title ?? null, toolTitle: r.tool_title ?? null } : null;
  }
  async needsUpdate(...a: MArgs<'needsUpdate'>) {
    const cached = await this.get(a[0]); return !cached || cached.mtime < intMs(a[1]);
  }
  async getStats(..._a: MArgs<'getStats'>) {
    const total = (await this.qRo(`SELECT COUNT(*)::int AS count FROM session_metadata WHERE tenant=$1`, [this.t]))[0].count;
    const bySources: Record<string, number> = {};
    for (const r of await this.qRo(`SELECT summary_source, COUNT(*)::int AS count FROM session_metadata WHERE tenant=$1 GROUP BY summary_source`, [this.t])) bySources[r.summary_source] = r.count;
    return { totalSessions: total, bySources };
  }
  async close(..._a: MArgs<'close'>) { /* shared pool — see pg-pool.ts closePgPools */ }
}

export async function createMetadataCache(opts: CreateStoreOptions = {}): Promise<MetadataCacheDriver> {
  if (resolveBackend(opts) === 'postgres') {
    const store = new PgMetadataCache(opts.databaseUrl, opts.tenant ?? currentTenant());
    await store.init();
    return store;
  }
  const { MetadataCache } = await import('../metadata-cache.js');
  return new SqliteMetadataCache(new MetadataCache(opts.sqlitePath));
}

// ──────────────────────────────────────────────────────────────────
// OutcomeCache
// ──────────────────────────────────────────────────────────────────

export interface OutcomeCacheDriver {
  get: AsyncMethod<OutcomeCache['get']>;
  getMany: AsyncMethod<OutcomeCache['getMany']>;
  summarizeByDay: AsyncMethod<OutcomeCache['summarizeByDay']>;
  put: AsyncMethod<OutcomeCache['put']>;
  putMany: AsyncMethod<OutcomeCache['putMany']>;
  invalidate: AsyncMethod<OutcomeCache['invalidate']>;
  close: AsyncMethod<OutcomeCache['close']>;
}

type OArgs<M extends keyof OutcomeCache> = OutcomeCache[M] extends (...a: infer A) => any ? A : never;

export class SqliteOutcomeCache implements OutcomeCacheDriver {
  readonly inner: OutcomeCache;
  constructor(inner: OutcomeCache) { this.inner = inner; }

  async get(...a: OArgs<'get'>) { return this.inner.get(...a); }
  async getMany(...a: OArgs<'getMany'>) { return this.inner.getMany(...a); }
  async summarizeByDay(...a: OArgs<'summarizeByDay'>) { return this.inner.summarizeByDay(...a); }
  async put(...a: OArgs<'put'>) { return this.inner.put(...a); }
  async putMany(...a: OArgs<'putMany'>) { return this.inner.putMany(...a); }
  async invalidate(...a: OArgs<'invalidate'>) { return this.inner.invalidate(...a); }
  async close(...a: OArgs<'close'>) { return this.inner.close(...a); }
}

const OUTCOME_COLS = 'session_id, tool, status, reason, file_mtime, file_size, content_hash, file_count, lines_added, lines_removed, commits, is_full, classified_at, last_scanned_offset';
function rowToOutcome(r: any) {
  return {
    sessionId: r.session_id, tool: r.tool, status: r.status, reason: r.reason,
    fileMtime: r.file_mtime, fileSize: r.file_size, contentHash: r.content_hash,
    fileCount: r.file_count, linesAdded: r.lines_added, linesRemoved: r.lines_removed,
    commits: r.commits, isFull: !!r.is_full, classifiedAt: r.classified_at, lastScannedOffset: r.last_scanned_offset,
  };
}

export class PgOutcomeCache implements OutcomeCacheDriver {
  private pool: any;
  private poolRo: any;
  private readonly t: string;
  constructor(private readonly databaseUrl?: string, tenant?: string) { this.t = pgTenant(tenant); }
  async init(): Promise<void> { this.pool = await openPgPool(this.databaseUrl); this.poolRo = await openPgPoolRo(); await ensurePgSchema(this.databaseUrl); }
  private async q(sql: string, params: unknown[] = []): Promise<any[]> { return (await tenantQuery(this.pool, this.t, sql, params)).rows; }
  // Read-replica variant for pure outcome-cache LOOKUPS (a stale miss just
  // reclassifies). Falls back to the primary pool when no RO DSN is configured.
  private async qRo(sql: string, params: unknown[] = []): Promise<any[]> { return (await tenantQueryRo(this.poolRo, this.pool, this.t, sql, params)).rows; }

  async get(...a: OArgs<'get'>) {
    const r = (await this.qRo(`SELECT ${OUTCOME_COLS} FROM session_outcome_cache WHERE tenant=$1 AND session_id=$2`, [this.t, a[0]]))[0];
    return r ? rowToOutcome(r) as any : null;
  }
  async getMany(...a: OArgs<'getMany'>) {
    const out = new Map<string, ReturnType<typeof rowToOutcome>>();
    if (!a[0].length) return out as any;
    for (const r of await this.qRo(`SELECT ${OUTCOME_COLS} FROM session_outcome_cache WHERE tenant=$1 AND session_id = ANY($2)`, [this.t, a[0]])) out.set(r.session_id, rowToOutcome(r));
    return out as any;
  }
  async summarizeByDay(...a: OArgs<'summarizeByDay'>) {
    const rows = await this.qRo(
      `SELECT to_char(to_timestamp(file_mtime/1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, status,
              COUNT(*) AS sessions, SUM(file_count) AS files,
              SUM(lines_added) AS lines_added, SUM(lines_removed) AS lines_removed, SUM(commits) AS commits
         FROM session_outcome_cache
        WHERE tenant=$1 AND file_mtime > $2
        GROUP BY 1, 2
        ORDER BY 1`,
      [this.t, a[0]]);
    return rows.map((r: any) => ({
      day: r.day, status: r.status,
      sessions: Number(r.sessions) || 0, files: Number(r.files) || 0,
      linesAdded: Number(r.lines_added) || 0, linesRemoved: Number(r.lines_removed) || 0,
      commits: Number(r.commits) || 0,
    })) as any;
  }
  async put(...a: OArgs<'put'>) {
    const rec = a[0];
    const classifiedAt = rec.classifiedAt ?? Date.now();
    await this.q(
      `INSERT INTO session_outcome_cache (tenant,session_id,tool,status,reason,file_mtime,file_size,content_hash,file_count,lines_added,lines_removed,commits,is_full,classified_at,last_scanned_offset)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (tenant,session_id) DO UPDATE SET
         tool=excluded.tool, status=excluded.status, reason=excluded.reason, file_mtime=excluded.file_mtime, file_size=excluded.file_size,
         content_hash=excluded.content_hash, file_count=excluded.file_count, lines_added=excluded.lines_added, lines_removed=excluded.lines_removed,
         commits=excluded.commits,
         is_full=CASE WHEN excluded.is_full=1 THEN 1 ELSE session_outcome_cache.is_full END,
         classified_at=excluded.classified_at, last_scanned_offset=excluded.last_scanned_offset`,
      [this.t, rec.sessionId, rec.tool, rec.status, rec.reason, intMs(rec.fileMtime), rec.fileSize, rec.contentHash,
       rec.fileCount, rec.linesAdded, rec.linesRemoved, rec.commits, rec.isFull ? 1 : 0, classifiedAt, rec.lastScannedOffset]);
  }
  async putMany(...a: OArgs<'putMany'>) {
    for (const rec of a[0]) await this.put(rec);
  }
  async invalidate(...a: OArgs<'invalidate'>) {
    await this.q(`DELETE FROM session_outcome_cache WHERE tenant=$1 AND session_id=$2`, [this.t, a[0]]);
  }
  async close(..._a: OArgs<'close'>) { /* shared pool — see pg-pool.ts closePgPools */ }
}

export async function createOutcomeCache(opts: CreateStoreOptions = {}): Promise<OutcomeCacheDriver> {
  if (resolveBackend(opts) === 'postgres') {
    const store = new PgOutcomeCache(opts.databaseUrl, opts.tenant ?? currentTenant());
    await store.init();
    return store;
  }
  const { OutcomeCache } = await import('../outcome-cache.js');
  return new SqliteOutcomeCache(new OutcomeCache(opts.sqlitePath));
}
