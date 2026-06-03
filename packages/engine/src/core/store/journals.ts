/**
 * Drivers for the two file-based journals, behind the storage flag:
 *   - WAL   (write-ahead-log.ts → wal/write_log.jsonl)  — write-op audit trail
 *   - Diary (diary-source.ts → index/diary/*.json)      — agent notes
 *
 *   storage: sqlite   → File impls (current on-disk behavior)
 *   storage: postgres → Pg stubs (per-tenant audit/diary tables, P1)
 *
 * Diary's read/write are static on DiarySource; the file driver delegates to
 * them. Param/return types are derived so the contract can't drift.
 */

import { createHash } from 'crypto';
import { WriteAheadLog } from '../write-ahead-log.js';
import { DiarySource } from '../../parsers/diary-source.js';
import { resolveBackend, type CreateStoreOptions } from './index.js';
import { openPgPool, pgTenant } from './pg-pool.js';

type AsyncMethod<M> = M extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

// ── WAL ───────────────────────────────────────────────────────────

export interface WalDriver {
  log: AsyncMethod<WriteAheadLog['log']>;
  logWithResult: AsyncMethod<WriteAheadLog['logWithResult']>;
}

type WArgs<M extends keyof WriteAheadLog> = WriteAheadLog[M] extends (...a: infer A) => any ? A : never;

export class FileWal implements WalDriver {
  readonly inner: WriteAheadLog;
  constructor(walDir?: string) { this.inner = new WriteAheadLog(walDir); }
  async log(...a: WArgs<'log'>) { return this.inner.log(...a); }
  async logWithResult(...a: WArgs<'logWithResult'>) { return this.inner.logWithResult(...a); }
}

export class PgWal implements WalDriver {
  private pool: any;
  private readonly t: string;
  constructor(private readonly databaseUrl?: string, tenant?: string) { this.t = pgTenant(tenant); }
  async init(): Promise<void> { this.pool = await openPgPool(this.databaseUrl); }
  async log(...a: WArgs<'log'>): Promise<void> {
    const [operation, params, result] = a;
    await this.pool.query(`INSERT INTO wal_log (tenant, ts, operation, payload) VALUES ($1,$2,$3,$4)`,
      [this.t, Date.now(), operation, JSON.stringify({ params, result: result ?? null })]);
  }
  async logWithResult(...a: WArgs<'logWithResult'>): Promise<void> {
    const [operation, params, result] = a;
    await this.log(operation, params, result);
  }
  async close(): Promise<void> { if (this.pool) await this.pool.end(); }
}

export async function createWal(opts: CreateStoreOptions = {}): Promise<WalDriver> {
  if (resolveBackend(opts) === 'postgres') {
    const w = new PgWal(opts.databaseUrl, opts.tenant);
    await w.init();
    return w;
  }
  return new FileWal();
}

// ── Diary ─────────────────────────────────────────────────────────

type DiaryEntryArg = Parameters<typeof DiarySource.write>[0];
type DiaryEntryOut = ReturnType<typeof DiarySource.read>;

export interface DiaryDriver {
  write(entry: DiaryEntryArg): Promise<string>;
  read(agentName: string, lastN?: number): Promise<DiaryEntryOut>;
}

export class FileDiary implements DiaryDriver {
  async write(entry: DiaryEntryArg): Promise<string> { return DiarySource.write(entry); }
  async read(agentName: string, lastN = 10): Promise<DiaryEntryOut> { return DiarySource.read(agentName, lastN); }
}

export class PgDiary implements DiaryDriver {
  private pool: any;
  private readonly t: string;
  constructor(private readonly databaseUrl?: string, tenant?: string) { this.t = pgTenant(tenant); }
  async init(): Promise<void> { this.pool = await openPgPool(this.databaseUrl); }
  async write(entry: DiaryEntryArg): Promise<string> {
    const id = `d_${createHash('sha256').update(`${entry.agent}|${entry.timestamp}|${entry.content}`).digest('hex').slice(0, 16)}`;
    await this.pool.query(
      `INSERT INTO diary_entries (tenant,id,agent,topic,content,ts,session_id,project_path) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant,id) DO UPDATE SET content=excluded.content, topic=excluded.topic`,
      [this.t, id, entry.agent, entry.topic ?? '', entry.content, entry.timestamp, entry.sessionId ?? null, entry.projectPath ?? null]);
    return id;
  }
  async read(agentName: string, lastN = 10): Promise<DiaryEntryOut> {
    const rows = (await this.pool.query(`SELECT agent, topic, content, ts, session_id, project_path FROM diary_entries WHERE tenant=$1 AND agent=$2 ORDER BY ts DESC LIMIT $3`, [this.t, agentName, lastN])).rows;
    return rows.map((r: any) => ({ agent: r.agent, topic: r.topic, content: r.content, timestamp: r.ts, sessionId: r.session_id ?? undefined, projectPath: r.project_path ?? undefined })) as DiaryEntryOut;
  }
  async close(): Promise<void> { if (this.pool) await this.pool.end(); }
}

export async function createDiary(opts: CreateStoreOptions = {}): Promise<DiaryDriver> {
  if (resolveBackend(opts) === 'postgres') {
    const d = new PgDiary(opts.databaseUrl, opts.tenant);
    await d.init();
    return d;
  }
  return new FileDiary();
}
