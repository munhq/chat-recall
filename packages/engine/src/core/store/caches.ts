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
import { openPgPool, pgTenant, tenantQuery } from './pg-pool.js';

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
  get: AsyncMethod<MetadataCache['get']>;
  needsUpdate: AsyncMethod<MetadataCache['needsUpdate']>;
  getStats: AsyncMethod<MetadataCache['getStats']>;
  close: AsyncMethod<MetadataCache['close']>;
}

type MArgs<M extends keyof MetadataCache> = MetadataCache[M] extends (...a: infer A) => any ? A : never;

export class SqliteMetadataCache implements MetadataCacheDriver {
  readonly inner: MetadataCache;
  constructor(inner: MetadataCache) { this.inner = inner; }

  async setCompute(...a: MArgs<'setCompute'>) { return this.inner.setCompute(...a); }
  async invalidateCompute(...a: MArgs<'invalidateCompute'>) { return this.inner.invalidateCompute(...a); }
  async getRawComputeRow(...a: MArgs<'getRawComputeRow'>) { return this.inner.getRawComputeRow(...a); }
  async getCompute<T = unknown>(sessionId: string, kind: string, mtime: number) { return this.inner.getCompute<T>(sessionId, kind, mtime); }
  async getComputeStale<T = unknown>(sessionId: string, kind: string) { return this.inner.getComputeStale<T>(sessionId, kind); }
  async recordSummaryError(...a: MArgs<'recordSummaryError'>) { return this.inner.recordSummaryError(...a); }
  async getSummaryError(...a: MArgs<'getSummaryError'>) { return this.inner.getSummaryError(...a); }
  async getSummaryErrors(...a: MArgs<'getSummaryErrors'>) { return this.inner.getSummaryErrors(...a); }
  async clearSummaryError(...a: MArgs<'clearSummaryError'>) { return this.inner.clearSummaryError(...a); }
  async set(...a: MArgs<'set'>) { return this.inner.set(...a); }
  async get(...a: MArgs<'get'>) { return this.inner.get(...a); }
  async needsUpdate(...a: MArgs<'needsUpdate'>) { return this.inner.needsUpdate(...a); }
  async getStats(...a: MArgs<'getStats'>) { return this.inner.getStats(...a); }
  async close(...a: MArgs<'close'>) { return this.inner.close(...a); }
}

export class PgMetadataCache implements MetadataCacheDriver {
  private pool: any;
  private readonly t: string;
  constructor(private readonly databaseUrl?: string, tenant?: string) { this.t = pgTenant(tenant); }
  async init(): Promise<void> { this.pool = await openPgPool(this.databaseUrl); }
  private async q(sql: string, params: unknown[] = []): Promise<any[]> { return (await tenantQuery(this.pool, this.t, sql, params)).rows; }

  async setCompute(...a: MArgs<'setCompute'>) {
    const [sessionId, kind, mtime, data] = a;
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
    const r = (await this.q(`SELECT mtime, payload_json, payload_gz FROM compute_cache WHERE tenant=$1 AND session_id=$2 AND kind=$3`, [this.t, a[0], a[1]]))[0];
    return r ? { mtime: r.mtime, payload_json: r.payload_json ?? null, payload_gz: r.payload_gz ?? null } : null;
  }
  async getCompute<T = unknown>(sessionId: string, kind: string, mtime: number) {
    const r = (await this.q(`SELECT payload_json, payload_gz FROM compute_cache WHERE tenant=$1 AND session_id=$2 AND kind=$3 AND mtime=$4`, [this.t, sessionId, kind, intMs(mtime)]))[0];
    return decodeComputePayload(r) as T | null;
  }
  async getComputeStale<T = unknown>(sessionId: string, kind: string) {
    const r = (await this.q(`SELECT mtime, payload_json, payload_gz FROM compute_cache WHERE tenant=$1 AND session_id=$2 AND kind=$3 ORDER BY computed_at DESC LIMIT 1`, [this.t, sessionId, kind]))[0];
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
    const r = (await this.q(`SELECT error, attempt_count, last_failed_at FROM summary_errors WHERE tenant=$1 AND session_id=$2`, [this.t, a[0]]))[0];
    return r ? { error: r.error, attemptCount: r.attempt_count, lastFailedAt: r.last_failed_at } : null;
  }
  async getSummaryErrors(...a: MArgs<'getSummaryErrors'>) {
    const out = new Map<string, { error: string; attemptCount: number; lastFailedAt: number }>();
    if (!a[0].length) return out;
    for (const r of await this.q(`SELECT session_id, error, attempt_count, last_failed_at FROM summary_errors WHERE tenant=$1 AND session_id = ANY($2)`, [this.t, a[0]]))
      out.set(r.session_id, { error: r.error, attemptCount: r.attempt_count, lastFailedAt: r.last_failed_at });
    return out;
  }
  async clearSummaryError(...a: MArgs<'clearSummaryError'>) {
    await this.q(`DELETE FROM summary_errors WHERE tenant=$1 AND session_id=$2`, [this.t, a[0]]);
  }
  async set(...a: MArgs<'set'>) {
    const m = a[0];
    await this.q(
      `INSERT INTO session_metadata (tenant,session_id,first_prompt,summary,summary_source,mtime,indexed_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant,session_id) DO UPDATE SET first_prompt=excluded.first_prompt, summary=excluded.summary, summary_source=excluded.summary_source, mtime=excluded.mtime, indexed_at=excluded.indexed_at`,
      [this.t, m.sessionId, m.firstPrompt, m.summary, m.summarySource, intMs(m.mtime), m.indexedAt]);
  }
  async get(...a: MArgs<'get'>) {
    const r = (await this.q(`SELECT session_id, first_prompt, summary, summary_source, mtime, indexed_at FROM session_metadata WHERE tenant=$1 AND session_id=$2`, [this.t, a[0]]))[0];
    return r ? { sessionId: r.session_id, firstPrompt: r.first_prompt, summary: r.summary, summarySource: r.summary_source, mtime: r.mtime, indexedAt: r.indexed_at } : null;
  }
  async needsUpdate(...a: MArgs<'needsUpdate'>) {
    const cached = await this.get(a[0]); return !cached || cached.mtime < intMs(a[1]);
  }
  async getStats(..._a: MArgs<'getStats'>) {
    const total = (await this.q(`SELECT COUNT(*)::int AS count FROM session_metadata WHERE tenant=$1`, [this.t]))[0].count;
    const bySources: Record<string, number> = {};
    for (const r of await this.q(`SELECT summary_source, COUNT(*)::int AS count FROM session_metadata WHERE tenant=$1 GROUP BY summary_source`, [this.t])) bySources[r.summary_source] = r.count;
    return { totalSessions: total, bySources };
  }
  async close(..._a: MArgs<'close'>) { if (this.pool) await this.pool.end(); }
}

export async function createMetadataCache(opts: CreateStoreOptions = {}): Promise<MetadataCacheDriver> {
  if (resolveBackend(opts) === 'postgres') {
    const store = new PgMetadataCache(opts.databaseUrl, opts.tenant);
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
  private readonly t: string;
  constructor(private readonly databaseUrl?: string, tenant?: string) { this.t = pgTenant(tenant); }
  async init(): Promise<void> { this.pool = await openPgPool(this.databaseUrl); }
  private async q(sql: string, params: unknown[] = []): Promise<any[]> { return (await tenantQuery(this.pool, this.t, sql, params)).rows; }

  async get(...a: OArgs<'get'>) {
    const r = (await this.q(`SELECT ${OUTCOME_COLS} FROM session_outcome_cache WHERE tenant=$1 AND session_id=$2`, [this.t, a[0]]))[0];
    return r ? rowToOutcome(r) as any : null;
  }
  async getMany(...a: OArgs<'getMany'>) {
    const out = new Map<string, ReturnType<typeof rowToOutcome>>();
    if (!a[0].length) return out as any;
    for (const r of await this.q(`SELECT ${OUTCOME_COLS} FROM session_outcome_cache WHERE tenant=$1 AND session_id = ANY($2)`, [this.t, a[0]])) out.set(r.session_id, rowToOutcome(r));
    return out as any;
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
  async close(..._a: OArgs<'close'>) { if (this.pool) await this.pool.end(); }
}

export async function createOutcomeCache(opts: CreateStoreOptions = {}): Promise<OutcomeCacheDriver> {
  if (resolveBackend(opts) === 'postgres') {
    const store = new PgOutcomeCache(opts.databaseUrl, opts.tenant);
    await store.init();
    return store;
  }
  const { OutcomeCache } = await import('../outcome-cache.js');
  return new SqliteOutcomeCache(new OutcomeCache(opts.sqlitePath));
}
