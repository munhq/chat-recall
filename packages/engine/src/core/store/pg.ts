import { randomBytes } from 'crypto';
import { tenantQuery, tenantTx, bulkInsert } from './pg-pool.js';
import { codeFindingId, codeHotspotId, codeActionId } from '../../types/code-intel.js';
/**
 * PgStore — Postgres StorageDriver for team/cloud mode. Real implementation
 * (no longer a stub). Every table carries a `tenant` column so one Postgres
 * serves many teams; this store is scoped to a single tenant (default
 * 'default' for solo/self-host). Mirrors MemoryStore's behavior; the few
 * SQLite-specific bits (FTS5 → tsvector, json_extract → jsonb ->>) are
 * translated to their Postgres equivalents.
 *
 * `pg` is dynamic-imported in init() so the default SQLite path never loads it.
 */

import type { MemoryStore } from '../memory-store.js';
import type {
  SourceType, MemoryItem, MemoryLink, MemoryChunk, MemoryMetadataRow, MemoryLinkRow, MemorySearchResult,
} from '../../types/memory.js';
import type { StorageDriver, TeamTask, TeamTaskComment, CreateTeamTaskInput, UpdateTeamTaskPatch } from './driver.js';
import { resolveProjectId } from '../project-resolver.js';
import { METADATA_VERSION } from '../model-pricing.js';
import { applyChunkPrivacy } from '../secret-redactor.js';
import { currentAuthor, runUnrestricted } from './tenant-context.js';

type Args<M extends keyof MemoryStore> = MemoryStore[M] extends (...a: infer A) => any ? A : never;
type Ret<M extends keyof MemoryStore> = MemoryStore[M] extends (...a: any) => infer R ? Awaited<R> : never;

// mtimes originate from `stat.mtimeMs`, which carries a sub-millisecond
// fractional part. SQLite's dynamic typing stores it verbatim, but Postgres
// BIGINT columns reject `1773833703469.8425`. Floor to whole ms at every pg
// bind site — both writes and equality-reads (compute_cache/content_cache
// look up by `mtime = $n`, so write and read must coerce identically or the
// cache would never hit).
export function intMs(x: unknown): number { return Math.floor(Number(x) || 0); }


export class PgStore implements StorageDriver {
  private pool: any;
  /** Read pool → replica (`-pooler-ro`) when DATABASE_URL_RO is set; otherwise
   *  aliases the write pool. Heavy, lag-tolerant SELECTs use this to offload the
   *  primary. Writes + read-after-write always use the write pool. */
  private roPool: any;
  private readonly databaseUrl: string;
  private readonly roUrl: string;
  private readonly tenant: string;

  constructor(databaseUrl?: string, tenant?: string) {
    this.databaseUrl =
      databaseUrl || process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL || '';
    // Optional read-replica DSN. Unset ⇒ reads share the write pool (local,
    // self-host, tests — unchanged behaviour).
    this.roUrl = process.env.DATABASE_URL_RO || process.env.CHAT_RECALL_DATABASE_URL_RO || '';
    this.tenant = tenant || process.env.CHAT_RECALL_TENANT || 'default';
  }

  async init(): Promise<void> {
    if (!this.databaseUrl) throw new Error('PgStore: no DATABASE_URL configured');
    const { openPgPool, ensurePgSchema } = await import('./pg-pool.js');
    // Primary (writable) pool. openPgPool is pure now — DDL is a separate,
    // explicit, primary-only step (replica tables arrive via replication).
    this.pool = await openPgPool(this.databaseUrl);
    await ensurePgSchema(this.databaseUrl);
    // Read pool → replica when a distinct RO DSN is configured; else alias rw.
    // Opened PURE (never schema-bootstrapped — a replica rejects DDL). If the
    // replica can't be opened/reached, degrade reads to the primary rather than
    // fail the whole store: a replica hiccup must never take ingest down too.
    if (this.roUrl && this.roUrl !== this.databaseUrl) {
      try {
        const ro = await openPgPool(this.roUrl);
        await ro.query('SELECT 1');   // validate reachable before trusting it for reads
        this.roPool = ro;
      } catch (e) {
        const { createLogger } = await import('../logger.js');
        createLogger('pg').warn({ err: e }, 'read-replica pool unavailable — using primary for reads');
        this.roPool = this.pool;
      }
    } else {
      this.roPool = this.pool;
    }
    // display_name = tenant keeps migrated databases happy (legacy schema
    // declared the column NOT NULL).
    await this.q(`INSERT INTO tenants (tenant, display_name, created_at) VALUES ($1, $1, $2) ON CONFLICT DO NOTHING`, [this.tenant, Date.now()]);
  }

  private async q(sql: string, params: unknown[] = []): Promise<any[]> {
    const r = await tenantQuery(this.pool, this.tenant, sql, params);
    return r.rows;
  }
  /** Read query → replica pool (falls back to the write pool when no RO DSN).
   *  Use ONLY for pure, lag-tolerant SELECTs — never read-after-write. */
  private async qr(sql: string, params: unknown[] = []): Promise<any[]> {
    const r = await tenantQuery(this.roPool, this.tenant, sql, params);
    return r.rows;
  }
  private async one(sql: string, params: unknown[] = []): Promise<any> {
    return (await this.q(sql, params))[0];
  }
  /** Read single-row → replica pool (falls back to write pool when no RO DSN).
   *  Use ONLY for pure, lag-tolerant single-row SELECTs — never read-after-write. */
  private async oneRo(sql: string, params: unknown[] = []): Promise<any> {
    return (await this.qr(sql, params))[0];
  }
  private get t() { return this.tenant; }

  // ── metadata / items ──
  async setItem(item: MemoryItem): Promise<void> {
    if (item.sourceType === 'session') {
      await this.q(`DELETE FROM session_metadata WHERE tenant=$1 AND session_id=$2`, [this.t, item.id]);
    }
    const resolved = !item.projectId && item.projectPath ? resolveProjectId(item.projectPath) : null;
    const projectId = item.projectId ?? (resolved && resolved.source !== 'ignored' ? resolved.id : '');
    const a = currentAuthor();
    await this.q(
      `INSERT INTO memory_metadata (tenant,id,source_type,title,project_path,project_id,content_preview,file_path,mtime,indexed_at,extra_json,author_sub,author_device)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (tenant,id,source_type) DO UPDATE SET
         title=excluded.title, project_path=excluded.project_path, project_id=excluded.project_id,
         content_preview=excluded.content_preview, file_path=excluded.file_path, mtime=excluded.mtime,
         indexed_at=excluded.indexed_at, extra_json=excluded.extra_json,
         author_sub=COALESCE(memory_metadata.author_sub, excluded.author_sub),
         author_device=COALESCE(memory_metadata.author_device, excluded.author_device)`,
      [this.t, item.id, item.sourceType, item.title, item.projectPath, projectId,
       item.contentPreview || '', item.filePath, intMs(item.mtime), Date.now(), JSON.stringify(item.extra || {}), a.sub, a.device],
    );
  }

  async setItems(items: MemoryItem[]): Promise<void> {
    if (items.length === 0) return;
    // De-dupe on the conflict key (last wins) so one multi-row INSERT is valid.
    const byKey = new Map<string, MemoryItem>();
    for (const it of items) byKey.set(`${it.sourceType}\u0000${it.id}`, it);
    const list = [...byKey.values()];
    const now = Date.now();
    await tenantTx(this.pool, this.t, async (client) => {
      // Mirror setItem's session cleanup, batched.
      const sessionIds = list.filter((it) => it.sourceType === 'session').map((it) => it.id);
      if (sessionIds.length > 0) {
        await client.query(`DELETE FROM session_metadata WHERE tenant=$1 AND session_id = ANY($2)`, [this.t, sessionIds]);
      }
      const a = currentAuthor();
      const rows = list.map((it) => {
        const resolved = !it.projectId && it.projectPath ? resolveProjectId(it.projectPath) : null;
        const projectId = it.projectId ?? (resolved && resolved.source !== 'ignored' ? resolved.id : '');
        return [this.t, it.id, it.sourceType, it.title, it.projectPath, projectId, it.contentPreview || '', it.filePath, intMs(it.mtime), now, JSON.stringify(it.extra || {}), a.sub, a.device];
      });
      await bulkInsert(client, 'memory_metadata',
        ['tenant', 'id', 'source_type', 'title', 'project_path', 'project_id', 'content_preview', 'file_path', 'mtime', 'indexed_at', 'extra_json', 'author_sub', 'author_device'],
        rows,
        `ON CONFLICT (tenant,id,source_type) DO UPDATE SET
           title=excluded.title, project_path=excluded.project_path, project_id=excluded.project_id,
           content_preview=excluded.content_preview, file_path=excluded.file_path, mtime=excluded.mtime,
           indexed_at=excluded.indexed_at, extra_json=excluded.extra_json,
           author_sub=COALESCE(memory_metadata.author_sub, excluded.author_sub),
           author_device=COALESCE(memory_metadata.author_device, excluded.author_device)`);
    });
  }

  private static COLS = 'id, source_type, title, project_path, project_id, content_preview, file_path, mtime, indexed_at, extra_json';

  // Primary (not replica): getItem feeds write-path gatekeepers — needsUpdate
  // (re-index decision) and toolkit promote — where a stale row would cause
  // re-index churn or a wrong promote. Single-row fetch, so ~zero offload lost.
  async getItem(id: string, sourceType: SourceType): Promise<MemoryMetadataRow | null> {
    return (await this.one(`SELECT ${PgStore.COLS} FROM memory_metadata WHERE tenant=$1 AND id=$2 AND source_type=$3`, [this.t, id, sourceType])) || null;
  }

  async needsUpdate(id: string, sourceType: SourceType, currentMtime: number): Promise<boolean> {
    const existing = await this.getItem(id, sourceType);
    if (!existing) return true;
    if (existing.mtime < intMs(currentMtime)) return true;
    try {
      const extra = JSON.parse(existing.extra_json || '{}') as { metadataVersion?: number };
      const stored = typeof extra.metadataVersion === 'number' ? extra.metadataVersion : 0;
      if (stored < METADATA_VERSION) return true;
    } catch { return true; }
    return false;
  }

  async listItems(sourceType: SourceType, limit = 100, offset = 0): Promise<MemoryMetadataRow[]> {
    return this.qr(`SELECT ${PgStore.COLS} FROM memory_metadata WHERE tenant=$1 AND source_type=$2 ORDER BY mtime DESC LIMIT $3 OFFSET $4`, [this.t, sourceType, limit, offset]);
  }

  async listItemsByProject(sourceType: SourceType, projectPath: string, limit = 10): Promise<MemoryMetadataRow[]> {
    return this.qr(`SELECT ${PgStore.COLS} FROM memory_metadata WHERE tenant=$1 AND source_type=$2 AND (project_path=$3 OR project_path LIKE $4) ORDER BY mtime DESC LIMIT $5`, [this.t, sourceType, projectPath, `${projectPath}%`, limit]);
  }

  async listItemsByProjectId(sourceType: SourceType | null, projectId: string, limit = 50): Promise<MemoryMetadataRow[]> {
    const where = sourceType ? `tenant=$1 AND source_type=$2 AND project_id=$3` : `tenant=$1 AND project_id=$2`;
    const params: unknown[] = sourceType ? [this.t, sourceType, projectId] : [this.t, projectId];
    let sql = `SELECT ${PgStore.COLS} FROM memory_metadata WHERE ${where} ORDER BY mtime DESC`;
    if (limit > 0) { sql += ` LIMIT $${params.length + 1}`; params.push(limit); }
    return this.qr(sql, params);
  }

  async listAllProjectIdPaths(): Promise<Ret<'listAllProjectIdPaths'>> {
    return this.qr(`SELECT DISTINCT ON (project_id) project_id, project_path FROM memory_metadata WHERE tenant=$1 AND project_id<>'' AND project_path<>'' ORDER BY project_id, mtime DESC`, [this.t]) as any;
  }

  async listProjectsSummary(): Promise<Ret<'listProjectsSummary'>> {
    return this.qr(`SELECT project_id, COUNT(*)::int AS items, MAX(mtime) AS last_mtime FROM memory_metadata WHERE tenant=$1 AND project_id<>'' GROUP BY project_id ORDER BY last_mtime DESC`, [this.t]) as any;
  }

  async listAllSessionsForPrecompute(): Promise<Ret<'listAllSessionsForPrecompute'>> {
    const rows = await this.qr(`SELECT id, mtime, (extra_json::jsonb->>'tool') AS tool FROM memory_metadata WHERE tenant=$1 AND source_type='session' ORDER BY mtime DESC`, [this.t]);
    return rows.map(r => ({ id: r.id, mtime: r.mtime || 0, tool: r.tool || 'claude' })) as any;
  }

  async listAllSessionProjectPaths(): Promise<Ret<'listAllSessionProjectPaths'>> {
    return this.qr(`SELECT id, project_path FROM memory_metadata WHERE tenant=$1 AND source_type='session' AND project_path<>''`, [this.t]) as any;
  }

  async listSessionsModifiedSince(sinceMs: number, projectIdFilter?: string): Promise<Ret<'listSessionsModifiedSince'>> {
    const where: string[] = [`tenant=$1`, `source_type='session'`, `mtime>=$2`];
    const params: unknown[] = [this.t, sinceMs];
    if (projectIdFilter) {
      // Same typed-id vs bare-term logic as querySessionIndex: a scheme id
      // (`git:`, `ws:`, `path:`, `untracked:`) or privacy hash (`p_…`) is an
      // exact project_id match; a bare word is a substring across path+id.
      const f = projectIdFilter;
      if (f.includes(':') || /^p_/.test(f)) {
        params.push(f); where.push(`project_id=$${params.length}`);
      } else {
        params.push(`%${f}%`); where.push(`(project_path ILIKE $${params.length} OR project_id ILIKE $${params.length})`);
      }
    }
    return this.qr(`SELECT id, mtime, project_path, project_id FROM memory_metadata WHERE ${where.join(' AND ')} ORDER BY mtime DESC`, params) as any;
  }

  async listAllSessionPaths(): Promise<Ret<'listAllSessionPaths'>> {
    return this.qr(`SELECT id, file_path FROM memory_metadata WHERE tenant=$1 AND source_type='session' AND file_path<>''`, [this.t]) as any;
  }

  async querySessionIndex(opts: Args<'querySessionIndex'>[0]): Promise<Ret<'querySessionIndex'>> {
    const where: string[] = [`tenant=$1`, `source_type='session'`];
    const params: unknown[] = [this.t];
    if (opts.projectIdFilter) {
      // A *typed* logical id (sidebar) contains a scheme colon (`path:`, `git:`,
      // `ws:`, `untracked:`) or is a privacy hash (`p_…`) → exact match. A bare
      // human term from the CLI/MCP (`chat-recall`, `inco`) is a substring →
      // match it against project_path AND project_id, case-insensitive. Exact
      // `project_id=` on a bare term matched nothing, which is why
      // `recall_recent project_filter:<name>` always came back empty and the MCP
      // mislabeled it as "no sessions on the server yet". Mirrors PgVectorStore
      // search's `-p` ILIKE behaviour so the feed and search agree.
      const f = opts.projectIdFilter;
      if (f.includes(':') || /^p_/.test(f)) {
        params.push(f); where.push(`project_id=$${params.length}`);
      } else {
        params.push(`%${f}%`); where.push(`(project_path ILIKE $${params.length} OR project_id ILIKE $${params.length})`);
      }
    }
    else if (!opts.includeUntracked) {
      // Mirror MemoryStore.querySessionIndex: hide only the genuine noise
      // buckets (PR-bot worktrees, /tmp scratch). Blanket-hiding 'path:%'
      // buried every synced session — hashed project paths (p_…) resolve to
      // path: ids by design.
      where.push(
        `project_id NOT LIKE 'path:%.claude-pr-bot' ` +
        `AND project_id NOT LIKE 'path:%/.claude-pr-bot/%' ` +
        `AND project_id NOT LIKE 'path:/tmp/%' ` +
        `AND project_id NOT LIKE 'path:/var/tmp/%'`,
      );
    }
    if (opts.toolFilter) {
      if (opts.toolFilter === 'claude') where.push(`((extra_json::jsonb->>'tool') IS NULL OR (extra_json::jsonb->>'tool')='claude')`);
      else { params.push(opts.toolFilter); where.push(`(extra_json::jsonb->>'tool')=$${params.length}`); }
    }
    if (opts.sinceMs && Number.isFinite(opts.sinceMs)) { params.push(opts.sinceMs); where.push(`mtime>=$${params.length}`); }
    const whereSQL = where.join(' AND ');
    const total = (await this.oneRo(`SELECT COUNT(*)::int AS n FROM memory_metadata WHERE ${whereSQL}`, params)).n;
    const rows = await this.qr(`SELECT ${PgStore.COLS} FROM memory_metadata WHERE ${whereSQL} ORDER BY mtime DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, opts.limit, opts.offset]);
    return { rows, total } as any;
  }

  async teamActivity(opts: { projectId?: string; author?: string; sinceMs?: number; limit?: number } = {}): Promise<Array<{ authorSub: string | null; projectId: string; sessions: number; lastMtime: number }>> {
    // RLS (app.viewer) filters memory_metadata to the viewer's visible sessions
    // (own + shared), so this rollup can never surface a private project. We
    // group by (author_sub, project_id) to answer "who did what, where".
    const where: string[] = [`tenant=$1`, `source_type='session'`];
    const params: unknown[] = [this.t];
    if (opts.projectId) { params.push(opts.projectId); where.push(`project_id=$${params.length}`); }
    if (opts.author) { params.push(opts.author); where.push(`author_sub=$${params.length}`); }
    if (opts.sinceMs && Number.isFinite(opts.sinceMs)) { params.push(opts.sinceMs); where.push(`mtime>=$${params.length}`); }
    let sql = `SELECT author_sub, project_id, COUNT(*)::int AS sessions, MAX(mtime) AS last_mtime
               FROM memory_metadata WHERE ${where.join(' AND ')}
               GROUP BY author_sub, project_id ORDER BY MAX(mtime) DESC`;
    if (opts.limit && opts.limit > 0) { params.push(opts.limit); sql += ` LIMIT $${params.length}`; }
    const rows = await this.qr(sql, params);
    return rows.map((r: any) => ({ authorSub: r.author_sub ?? null, projectId: r.project_id, sessions: r.sessions, lastMtime: Number(r.last_mtime) || 0 }));
  }

  // ── Collaborative tasks (Phase 3). Tenant-scoped, team-visible. ──
  private rowToTeamTask(r: any): TeamTask {
    const arr = (s: unknown): string[] => { try { const a = JSON.parse(typeof s === 'string' ? s : '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
    return {
      id: r.id, projectId: r.project_id, title: r.title, description: r.description,
      status: r.status, assigneeSub: r.assignee_sub ?? null, createdBy: r.created_by,
      blocks: arr(r.blocks), blockedBy: arr(r.blocked_by),
      linkedSessionId: r.linked_session_id ?? null, due: r.due != null ? Number(r.due) : null,
      createdAt: Number(r.created_at) || 0, updatedAt: Number(r.updated_at) || 0,
    };
  }

  async createTeamTask(input: CreateTeamTaskInput): Promise<TeamTask> {
    const id = 't_' + randomBytes(9).toString('hex');
    const now = Date.now();
    await this.q(
      `INSERT INTO team_tasks (tenant,id,project_id,title,description,status,assignee_sub,created_by,blocks,blocked_by,linked_session_id,due,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,'todo',$6,$7,'[]','[]',$8,$9,$10,$10)`,
      [this.t, id, input.projectId || '', input.title, input.description || '', input.assigneeSub ?? null, input.createdBy, input.linkedSessionId ?? null, input.due ?? null, now],
    );
    return (await this.getTeamTask(id))!.task;
  }

  async listTeamTasks(opts: { projectId?: string; assigneeSub?: string; status?: TeamTask['status'] } = {}): Promise<TeamTask[]> {
    const where = ['tenant=$1']; const params: unknown[] = [this.t];
    if (opts.projectId) { params.push(opts.projectId); where.push(`project_id=$${params.length}`); }
    if (opts.assigneeSub) { params.push(opts.assigneeSub); where.push(`assignee_sub=$${params.length}`); }
    if (opts.status) { params.push(opts.status); where.push(`status=$${params.length}`); }
    const rows = await this.qr(`SELECT * FROM team_tasks WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`, params);
    return rows.map((r) => this.rowToTeamTask(r));
  }

  async getTeamTask(id: string): Promise<{ task: TeamTask; comments: TeamTaskComment[] } | null> {
    const t = await this.one(`SELECT * FROM team_tasks WHERE tenant=$1 AND id=$2`, [this.t, id]);
    if (!t) return null;
    const comments = (await this.qr(`SELECT * FROM team_task_comments WHERE tenant=$1 AND task_id=$2 ORDER BY created_at ASC`, [this.t, id]))
      .map((c: any) => ({ id: c.id, taskId: c.task_id, authorSub: c.author_sub, body: c.body, createdAt: Number(c.created_at) || 0 }));
    return { task: this.rowToTeamTask(t), comments };
  }

  async updateTeamTask(id: string, patch: UpdateTeamTaskPatch): Promise<TeamTask | null> {
    const sets: string[] = []; const params: unknown[] = [this.t, id];
    const add = (col: string, val: unknown) => { params.push(val); sets.push(`${col}=$${params.length}`); };
    if (patch.title !== undefined) add('title', patch.title);
    if (patch.description !== undefined) add('description', patch.description);
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.assigneeSub !== undefined) add('assignee_sub', patch.assigneeSub);
    if (patch.due !== undefined) add('due', patch.due);
    if (patch.blocks !== undefined) add('blocks', JSON.stringify(patch.blocks));
    if (patch.blockedBy !== undefined) add('blocked_by', JSON.stringify(patch.blockedBy));
    if (sets.length === 0) return (await this.getTeamTask(id))?.task ?? null;
    params.push(Date.now()); sets.push(`updated_at=$${params.length}`);
    const r = await this.q(`UPDATE team_tasks SET ${sets.join(', ')} WHERE tenant=$1 AND id=$2 RETURNING *`, params);
    return r[0] ? this.rowToTeamTask(r[0]) : null;
  }

  async addTeamTaskComment(taskId: string, authorSub: string, body: string): Promise<TeamTaskComment | null> {
    const exists = await this.one(`SELECT 1 FROM team_tasks WHERE tenant=$1 AND id=$2`, [this.t, taskId]);
    if (!exists) return null;
    const id = 'c_' + randomBytes(9).toString('hex');
    const now = Date.now();
    await this.q(`INSERT INTO team_task_comments (tenant,id,task_id,author_sub,body,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [this.t, id, taskId, authorSub, body, now]);
    return { id, taskId, authorSub, body, createdAt: now };
  }

  async getStats(): Promise<Ret<'getStats'>> {
    const rows = await this.qr(`SELECT source_type, COUNT(*)::int AS count FROM memory_metadata WHERE tenant=$1 GROUP BY source_type`, [this.t]);
    const out: Record<string, number> = {};
    for (const r of rows) out[r.source_type] = r.count;
    return out as any;
  }

  async clearSourceType(sourceType: SourceType): Promise<void> {
    await this.q(`DELETE FROM memory_metadata WHERE tenant=$1 AND source_type=$2`, [this.t, sourceType]);
    await this.q(`DELETE FROM memory_links WHERE tenant=$1 AND (source_type=$2 OR target_type=$2)`, [this.t, sourceType]);
  }

  async deleteItem(id: string, sourceType: SourceType): Promise<void> {
    await this.q(`DELETE FROM memory_metadata WHERE tenant=$1 AND id=$2 AND source_type=$3`, [this.t, id, sourceType]);
    await this.q(`DELETE FROM memory_links WHERE tenant=$1 AND ((source_type=$2 AND source_id=$3) OR (target_type=$2 AND target_id=$3))`, [this.t, sourceType, id]);
    if (sourceType === 'session') await this.q(`DELETE FROM session_metadata WHERE tenant=$1 AND session_id=$2`, [this.t, id]);
  }

  async updateItemProjectPath(id: string, sourceType: SourceType, projectPath: string): Promise<boolean> {
    const r = await tenantQuery(this.pool, this.tenant, `UPDATE memory_metadata SET project_path=$4 WHERE tenant=$1 AND id=$2 AND source_type=$3`, [this.t, id, sourceType, projectPath]);
    return r.rowCount > 0;
  }

  // ── links ──
  // memory_links has a RESTRICTIVE author_visibility SELECT policy (a link is
  // visible only when BOTH endpoints are). The write is a two-endpoint ON CONFLICT
  // upsert, and a link's TARGET (a plan/task/claude_md/sibling) may not be visible
  // to the writing member at write time (e.g. its memory_metadata row isn't in this
  // sync batch) — the conflict-check then fail-closes the whole sync on
  // author_visibility. memory_links carries NO author-write-guard, so run the write
  // UNRESTRICTED; reads keep the member's viewer and stay gated. See runUnrestricted.
  async addLink(link: MemoryLink): Promise<void> {
    await runUnrestricted(() => this.q(
      `INSERT INTO memory_links (tenant,source_type,source_id,target_type,target_id,link_type,confidence,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant,source_type,source_id,target_type,target_id,link_type) DO UPDATE SET confidence=excluded.confidence, created_at=excluded.created_at`,
      [this.t, link.sourceType, link.sourceId, link.targetType, link.targetId, link.linkType, link.confidence, Date.now()],
    ));
  }
  async addLinks(links: MemoryLink[]): Promise<void> {
    if (links.length === 0) return;
    // De-dupe by the conflict key, then one bulk INSERT in one transaction.
    const byKey = new Map<string, MemoryLink>();
    for (const l of links) byKey.set(`${l.sourceType}\u0000${l.sourceId}\u0000${l.targetType}\u0000${l.targetId}\u0000${l.linkType}`, l);
    const now = Date.now();
    const rows = [...byKey.values()].map((l) => [this.t, l.sourceType, l.sourceId, l.targetType, l.targetId, l.linkType, l.confidence ?? null, now]);
    // Unrestricted write — see addLink.
    await runUnrestricted(() => tenantTx(this.pool, this.t, async (client) => {
      await bulkInsert(client, 'memory_links',
        ['tenant', 'source_type', 'source_id', 'target_type', 'target_id', 'link_type', 'confidence', 'created_at'],
        rows,
        'ON CONFLICT (tenant,source_type,source_id,target_type,target_id,link_type) DO UPDATE SET confidence=excluded.confidence, created_at=excluded.created_at');
    }));
  }
  async getLinksFrom(sourceType: SourceType, sourceId: string): Promise<MemoryLinkRow[]> {
    return this.qr(`SELECT * FROM memory_links WHERE tenant=$1 AND source_type=$2 AND source_id=$3`, [this.t, sourceType, sourceId]);
  }
  async getLinksTo(targetType: SourceType, targetId: string): Promise<MemoryLinkRow[]> {
    return this.qr(`SELECT * FROM memory_links WHERE tenant=$1 AND target_type=$2 AND target_id=$3`, [this.t, targetType, targetId]);
  }
  async getAllLinks(sourceType: SourceType, itemId: string): Promise<MemoryLinkRow[]> {
    return this.qr(`SELECT * FROM memory_links WHERE tenant=$1 AND ((source_type=$2 AND source_id=$3) OR (target_type=$2 AND target_id=$3))`, [this.t, sourceType, itemId]);
  }
  async getLinkCount(): Promise<number> {
    return (await this.oneRo(`SELECT COUNT(*)::int AS count FROM memory_links WHERE tenant=$1`, [this.t])).count;
  }

  // ── content cache ──
  async getCachedContent(id: string, sourceType: string, mtime: number): Promise<string | null> {
    const row = await this.one(`SELECT content_json FROM content_cache WHERE tenant=$1 AND id=$2 AND source_type=$3 AND mtime>=$4`, [this.t, id, sourceType, intMs(mtime)]);
    return row?.content_json || null;
  }
  async getCachedContentStale(id: string, sourceType: string): Promise<{ content: string; mtime: number } | null> {
    const row = await this.one(`SELECT content_json, mtime FROM content_cache WHERE tenant=$1 AND id=$2 AND source_type=$3`, [this.t, id, sourceType]);
    return row ? { content: row.content_json, mtime: Number(row.mtime) } : null;
  }
  async setCachedContent(id: string, sourceType: string, mtime: number, content: string): Promise<void> {
    await this.q(
      `INSERT INTO content_cache (tenant,id,source_type,content_json,mtime) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant,id,source_type) DO UPDATE SET content_json=excluded.content_json, mtime=excluded.mtime`,
      [this.t, id, sourceType, applyChunkPrivacy(content), intMs(mtime)],
    );
  }

  // ── secret findings ──
  async ensureSecretFindingsTable(): Promise<void> { /* created in init() */ }
  async ensureSecretRulesTable(): Promise<void> { /* created in init() */ }
  async ensureSecretDismissalsTable(): Promise<void> { /* created in init() */ }

  async replaceSecretFindings(sessionId: string, findings: Args<'replaceSecretFindings'>[1]): Promise<{ written: number }> {
    await this.q(`DELETE FROM secret_findings WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId]);
    const now = Date.now();
    const a = currentAuthor();
    let written = 0;
    for (const f of findings) {
      const r = await tenantQuery(this.pool, this.tenant,
        `INSERT INTO secret_findings (tenant,session_id,detector,rule,line,preview,scanned_at,verified,author_sub,author_device)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tenant,session_id,detector,rule,line) DO NOTHING`,
        [this.t, sessionId, f.detector, f.rule, f.line, f.preview, now, f.verified === true ? 1 : f.verified === false ? 0 : null, a.sub, a.device],
      );
      written += r.rowCount || 0;
    }
    return { written };
  }

  async secretFindingsSummary(): Promise<Ret<'secretFindingsSummary'>> {
    const totals = await this.qr(`SELECT detector, COUNT(*)::int AS findings, COUNT(DISTINCT session_id)::int AS sessions FROM secret_findings WHERE tenant=$1 GROUP BY detector ORDER BY detector`, [this.t]);
    const topRules = await this.qr(`SELECT detector, rule, COUNT(*)::int AS n FROM secret_findings WHERE tenant=$1 GROUP BY detector, rule ORDER BY n DESC LIMIT 30`, [this.t]);
    const sessionsWithFindings = (await this.oneRo(`SELECT COUNT(DISTINCT session_id)::int AS n FROM secret_findings WHERE tenant=$1`, [this.t])).n;
    return { totals, topRules, sessionsWithFindings } as any;
  }

  async secretFindingsBySession(): Promise<Ret<'secretFindingsBySession'>> {
    return this.qr(
      `SELECT sf.session_id, sf.detector, COUNT(*)::int AS n, m.project_path, m.title, m.mtime
       FROM secret_findings sf LEFT JOIN memory_metadata m ON m.tenant=sf.tenant AND m.id=sf.session_id AND m.source_type='session'
       WHERE sf.tenant=$1 GROUP BY sf.session_id, sf.detector, m.project_path, m.title, m.mtime`, [this.t]) as any;
  }

  async secretFindingsByProject(): Promise<Ret<'secretFindingsByProject'>> {
    return this.qr(
      `SELECT COALESCE(NULLIF(m.project_path,''),'(unknown)') AS project_path,
              COUNT(*)::int AS occurrences, COUNT(DISTINCT sf.preview)::int AS "distinctSecrets",
              COUNT(DISTINCT CASE WHEN sf.verified=1 THEN sf.preview END)::int AS verified,
              COUNT(DISTINCT sf.session_id)::int AS sessions, MAX(sf.scanned_at) AS "lastSeen"
       FROM secret_findings sf LEFT JOIN memory_metadata m ON m.tenant=sf.tenant AND m.id=sf.session_id AND m.source_type='session'
       WHERE sf.tenant=$1 GROUP BY 1 ORDER BY verified DESC, "distinctSecrets" DESC`, [this.t]) as any;
  }

  async secretFindingsTrend(days = 30): Promise<Ret<'secretFindingsTrend'>> {
    const sinceMs = Date.now() - days * 86_400_000;
    return this.qr(
      `SELECT to_char(to_timestamp(sf.scanned_at/1000),'YYYY-MM-DD') AS day,
              COUNT(*)::int AS occurrences, COUNT(DISTINCT sf.preview)::int AS "distinctSecrets",
              COUNT(DISTINCT CASE WHEN sf.verified=1 THEN sf.preview END)::int AS verified
       FROM secret_findings sf WHERE sf.tenant=$1 AND sf.scanned_at>=$2 GROUP BY day ORDER BY day ASC`, [this.t, sinceMs]) as any;
  }

  async secretFindingsByRule(): Promise<Ret<'secretFindingsByRule'>> {
    const rules = await this.qr(
      `SELECT detector, rule, COUNT(*)::int AS occurrences, COUNT(DISTINCT preview)::int AS "distinctSecrets", COUNT(DISTINCT session_id)::int AS sessions
       FROM secret_findings WHERE tenant=$1 GROUP BY detector, rule ORDER BY "distinctSecrets" DESC, occurrences DESC`, [this.t]);
    const out = [];
    for (const r of rules) {
      const ss = await this.qr(`SELECT DISTINCT session_id FROM secret_findings WHERE tenant=$1 AND detector=$2 AND rule=$3 LIMIT 3`, [this.t, r.detector, r.rule]);
      const pv = await this.qr(`SELECT DISTINCT preview FROM secret_findings WHERE tenant=$1 AND detector=$2 AND rule=$3 LIMIT 5`, [this.t, r.detector, r.rule]);
      out.push({ ...r, sampleSessions: ss.map(x => x.session_id), samplePreviews: pv.map(x => x.preview) });
    }
    return out as any;
  }

  async secretFindingsByDistinctSecret(): Promise<Ret<'secretFindingsByDistinctSecret'>> {
    const rows = await this.qr(
      `SELECT sf.preview, sf.detector, sf.rule, sf.session_id, sf.line, sf.scanned_at, sf.verified, m.project_path
       FROM secret_findings sf LEFT JOIN memory_metadata m ON m.tenant=sf.tenant AND m.id=sf.session_id AND m.source_type='session'
       WHERE sf.tenant=$1 AND sf.preview IS NOT NULL AND sf.preview<>''`, [this.t]);
    // Identical JS aggregation to MemoryStore.secretFindingsByDistinctSecret.
    type Acc = { preview: string; rulePairs: Set<string>; detectors: Set<string>; sessions: Map<string, { project: string; lines: Set<number> }>; occurrences: number; firstSeen: number; lastSeen: number; verifiedFlags: Set<number>; };
    const map = new Map<string, Acc>();
    for (const r of rows) {
      let e = map.get(r.preview);
      if (!e) { e = { preview: r.preview, rulePairs: new Set(), detectors: new Set(), sessions: new Map(), occurrences: 0, firstSeen: r.scanned_at, lastSeen: r.scanned_at, verifiedFlags: new Set() }; map.set(r.preview, e); }
      e.rulePairs.add(`${r.detector}:${r.rule}`); e.detectors.add(r.detector);
      let s = e.sessions.get(r.session_id);
      if (!s) { s = { project: r.project_path || '', lines: new Set() }; e.sessions.set(r.session_id, s); }
      s.lines.add(r.line); e.occurrences++;
      if (r.scanned_at < e.firstSeen) e.firstSeen = r.scanned_at;
      if (r.scanned_at > e.lastSeen) e.lastSeen = r.scanned_at;
      if (r.verified !== null && r.verified !== undefined) e.verifiedFlags.add(r.verified);
    }
    return [...map.values()].map(e => {
      let verified: boolean | null = null;
      if (e.verifiedFlags.has(1)) verified = true; else if (e.verifiedFlags.has(0)) verified = false;
      return {
        preview: e.preview,
        rules: [...e.rulePairs].map(rp => { const [detector, rule] = rp.split(':'); return { detector, rule }; }),
        detectors: [...e.detectors].sort(),
        sessions: [...e.sessions.entries()].map(([sessionId, v]) => ({ sessionId, project: v.project, lines: [...v.lines].sort((a, b) => a - b) })),
        sessionCount: e.sessions.size, occurrences: e.occurrences, firstSeen: e.firstSeen, lastSeen: e.lastSeen, verified,
      };
    }) as any;
  }

  async secretCrossSessionCount(preview: string, excludeSessionId: string): Promise<number> {
    return (await this.oneRo(`SELECT COUNT(DISTINCT session_id)::int AS n FROM secret_findings WHERE tenant=$1 AND preview=$2 AND session_id<>$3`, [this.t, preview, excludeSessionId])).n;
  }

  async secretFindingsForSession(sessionId: string): Promise<Ret<'secretFindingsForSession'>> {
    return this.qr(`SELECT detector, rule, line, preview, scanned_at FROM secret_findings WHERE tenant=$1 AND session_id=$2 ORDER BY detector, line`, [this.t, sessionId]) as any;
  }

  // ── secret rules + dismissals ──
  async listSecretRules(tenantId = 'default'): Promise<Ret<'listSecretRules'>> {
    void tenantId; // tenant is the store's scope, not the legacy per-row tenant_id
    return this.q(`SELECT id, $1::text AS tenant_id, name, regex, severity, description, enabled, created_at, updated_at FROM secret_rules WHERE tenant=$1 ORDER BY name`, [this.t]) as any;
  }
  async upsertSecretRule(rule: Args<'upsertSecretRule'>[0]): Promise<{ id: number }> {
    const enabled = rule.enabled === false ? 0 : 1; const now = Date.now();
    if (rule.id) {
      await this.q(`UPDATE secret_rules SET name=$2,regex=$3,severity=$4,description=$5,enabled=$6,updated_at=$7 WHERE tenant=$1 AND id=$8`,
        [this.t, rule.name, rule.regex, rule.severity, rule.description || null, enabled, now, rule.id]);
      return { id: rule.id };
    }
    const row = await this.one(
      `INSERT INTO secret_rules (tenant,name,regex,severity,description,enabled,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant,name) DO UPDATE SET regex=excluded.regex, severity=excluded.severity, description=excluded.description, enabled=excluded.enabled, updated_at=excluded.updated_at
       RETURNING id`,
      [this.t, rule.name, rule.regex, rule.severity, rule.description || null, enabled, now, now]);
    return { id: Number(row.id) };
  }
  async deleteSecretRule(id: number, tenantId = 'default'): Promise<void> {
    void tenantId;
    await this.q(`DELETE FROM secret_rules WHERE tenant=$1 AND id=$2`, [this.t, id]);
  }
  async setSecretDismissal(preview: string, status: Args<'setSecretDismissal'>[1], reason?: string): Promise<void> {
    const a = currentAuthor();
    await this.q(
      `INSERT INTO secret_dismissals (tenant,preview,status,reason,dismissed_at,dismissed_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant,preview) DO UPDATE SET status=excluded.status, reason=excluded.reason, dismissed_at=excluded.dismissed_at,
         dismissed_by=COALESCE(excluded.dismissed_by, secret_dismissals.dismissed_by)`,
      [this.t, preview, status, reason || null, Date.now(), a.sub]);
  }
  async clearSecretDismissal(preview: string): Promise<void> {
    await this.q(`DELETE FROM secret_dismissals WHERE tenant=$1 AND preview=$2`, [this.t, preview]);
  }
  async getSecretDismissals(): Promise<Ret<'getSecretDismissals'>> {
    const out = new Map<string, { status: string; reason: string | null; dismissed_at: number }>();
    for (const r of await this.qr(`SELECT preview, status, reason, dismissed_at FROM secret_dismissals WHERE tenant=$1`, [this.t])) {
      out.set(r.preview, { status: r.status, reason: r.reason, dismissed_at: r.dismissed_at });
    }
    return out as any;
  }

  // ── FTS (Postgres tsvector) ──
  async addChunksFTS(chunks: MemoryChunk[]): Promise<number> {
    const valid = chunks.filter(c => c.text && c.text.trim().length > 0);
    if (valid.length === 0) return 0;
    // De-dupe by chunk_id: a single multi-row INSERT cannot hit the same
    // ON CONFLICT key twice. Last write wins (matches the prior loop's upsert).
    const byId = new Map<string, MemoryChunk>();
    for (const c of valid) byId.set(c.chunkId, c);
    const rows = [...byId.values()];
    // Affected items, for the replace-on-resync DELETE.
    const items = new Map<string, [string, string]>();
    for (const c of rows) items.set(`${c.sourceType}\u0000${c.itemId}`, [c.sourceType, c.itemId]);

    // ONE transaction: a single DELETE for all affected items, then bulk
    // multi-row INSERTs — vs. the former (delete + insert) per row, each in its
    // own BEGIN/SET/COMMIT. Same semantics, ~N× fewer round-trips.
    await tenantTx(this.pool, this.t, async (client) => {
      const its = [...items.values()];
      const dParams: unknown[] = [this.t];
      const dTuples = its.map((it) => { const b = dParams.length; dParams.push(it[0], it[1]); return `($${b + 1},$${b + 2})`; });
      await client.query(
        `DELETE FROM memory_chunks WHERE tenant=$1 AND (source_type,item_id) IN (${dTuples.join(',')})`,
        dParams);
      const a = currentAuthor();
      const insertRows = rows.map((c) => {
        const resolved = !c.projectId && c.projectPath ? resolveProjectId(c.projectPath) : null;
        const projectId = c.projectId ?? (resolved && resolved.source !== 'ignored' ? resolved.id : '');
        return [this.t, c.chunkId, c.itemId, c.sourceType, c.title, applyChunkPrivacy(c.text), c.chunkType, c.projectPath, projectId, c.filePath, intMs(c.mtime), a.sub, a.device];
      });
      await bulkInsert(client, 'memory_chunks',
        ['tenant', 'chunk_id', 'item_id', 'source_type', 'title', 'text', 'chunk_type', 'project_path', 'project_id', 'file_path', 'mtime', 'author_sub', 'author_device'],
        insertRows,
        `ON CONFLICT (tenant,chunk_id) DO UPDATE SET text=excluded.text, title=excluded.title,
           author_sub=COALESCE(memory_chunks.author_sub, excluded.author_sub),
           author_device=COALESCE(memory_chunks.author_device, excluded.author_device)`);
    });
    return rows.length;
  }
  async listChunksByItem(sourceType: string, itemId: string): Promise<Array<{ chunk_id: string; title: string; text: string; chunk_type: string; mtime: number }>> {
    const rows = await this.qr(
      `SELECT chunk_id, title, text, chunk_type, mtime FROM memory_chunks WHERE tenant=$1 AND source_type=$2 AND item_id=$3`,
      [this.t, sourceType, itemId]);
    const idx = (c: string) => { const m = /:(\d+)$/.exec(c); return m ? Number(m[1]) : 0; };
    rows.sort((a: any, b: any) => idx(a.chunk_id) - idx(b.chunk_id));
    return rows.map((r: any) => ({ chunk_id: r.chunk_id, title: r.title, text: r.text, chunk_type: r.chunk_type, mtime: Number(r.mtime) }));
  }

  // ── Tail-sync (append-only transcripts) ─────────────────────────
  // See docs/SYNC-INCREMENTAL.md. append = INSERT without the per-item DELETE.

  async appendChunksFTS(chunks: MemoryChunk[]): Promise<number> {
    const valid = chunks.filter(c => c.text && c.text.trim().length > 0);
    if (valid.length === 0) return 0;
    const byId = new Map<string, MemoryChunk>();
    for (const c of valid) byId.set(c.chunkId, c);
    const rows = [...byId.values()];
    await tenantTx(this.pool, this.t, async (client) => {
      const a = currentAuthor();
      const insertRows = rows.map((c) => {
        const resolved = !c.projectId && c.projectPath ? resolveProjectId(c.projectPath) : null;
        const projectId = c.projectId ?? (resolved && resolved.source !== 'ignored' ? resolved.id : '');
        return [this.t, c.chunkId, c.itemId, c.sourceType, c.title, applyChunkPrivacy(c.text), c.chunkType, c.projectPath, projectId, c.filePath, intMs(c.mtime), a.sub, a.device];
      });
      await bulkInsert(client, 'memory_chunks',
        ['tenant', 'chunk_id', 'item_id', 'source_type', 'title', 'text', 'chunk_type', 'project_path', 'project_id', 'file_path', 'mtime', 'author_sub', 'author_device'],
        insertRows,
        `ON CONFLICT (tenant,chunk_id) DO UPDATE SET text=excluded.text, title=excluded.title,
           author_sub=COALESCE(memory_chunks.author_sub, excluded.author_sub),
           author_device=COALESCE(memory_chunks.author_device, excluded.author_device)`);
    });
    return rows.length;
  }

  async maxSyncChunkIndex(itemId: string): Promise<number> {
    // PRIMARY, not replica: this is the tail-append chunk-id cursor. The caller
    // numbers new chunks `:sync:<maxIdx+1+i>`, then appendChunksFTS upserts on
    // (tenant,chunk_id) DO UPDATE. A stale replica that under-reports the max
    // would re-issue ids that collide with chunks a prior tick already appended,
    // OVERWRITING them (silent data loss). Read-after-write → must see all prior
    // appends, so it stays on the write pool.
    const rows = await this.q(
      `SELECT chunk_id FROM memory_chunks WHERE tenant=$1 AND source_type='session' AND item_id=$2 AND chunk_id LIKE '%:sync:%'`,
      [this.t, itemId]);
    let max = 0;
    for (const r of rows as any[]) {
      const m = /:sync:(\d+)$/.exec(r.chunk_id);
      if (m) { const n = Number(m[1]); if (n > max) max = n; }
    }
    return max;
  }

  async touchSessionMtime(sessionId: string, mtime: number): Promise<void> {
    await this.q(
      `UPDATE memory_metadata SET mtime=$3, indexed_at=$4 WHERE tenant=$1 AND id=$2 AND source_type='session'`,
      [this.t, sessionId, intMs(mtime), Date.now()]);
  }
  async pruneEmptySessions(): Promise<number> {
    const r = await tenantQuery(this.pool, this.t,
      `DELETE FROM memory_metadata m WHERE m.tenant=$1 AND m.source_type='session'
         AND NOT EXISTS (SELECT 1 FROM content_cache c WHERE c.tenant=m.tenant AND c.id=m.id AND c.source_type='session')
         AND NOT EXISTS (SELECT 1 FROM memory_chunks f WHERE f.tenant=m.tenant AND f.item_id=m.id AND f.source_type='session')`,
      [this.t]);
    return r.rowCount || 0;
  }

  async deleteItemFTS(sourceType: string, itemId: string): Promise<void> {
    await this.q(`DELETE FROM memory_chunks WHERE tenant=$1 AND source_type=$2 AND item_id=$3`, [this.t, sourceType, itemId]);
    // Also drop vector rows for the item so deleted content can't resurface in
    // semantic search (memory_vectors carries its own text). Guarded: the table
    // may not exist when no embedder is configured.
    try { await this.q(`DELETE FROM memory_vectors WHERE tenant=$1 AND source_type=$2 AND item_id=$3`, [this.t, sourceType, itemId]); } catch { /* absent */ }
  }
  async rebuildFTS(): Promise<void> { /* tsvector is a generated column — nothing to rebuild */ }
  async clearFTS(): Promise<void> { await this.q(`DELETE FROM memory_chunks WHERE tenant=$1`, [this.t]); }

  async searchFTS(query: string, options: Args<'searchFTS'>[1] = {}): Promise<MemorySearchResult[]> {
    const { topK = 20, sourceTypes, projectIdFilter } = options;
    const orTsq = orPrefixTsQuery(query);
    if (!orTsq) return [];
    // R7: precision-first — for short queries try requiring ALL terms (AND);
    // fall back to OR below if that returns too few hits (see re-run at end).
    const andTsq = andPrefixTsQuery(query);
    const tsq = andTsq || orTsq;
    const params: unknown[] = [this.t, tsq];
    let where = `tenant=$1 AND tsv @@ to_tsquery('english',$2)`;
    if (sourceTypes && sourceTypes.length > 0) { params.push(sourceTypes); where += ` AND source_type = ANY($${params.length})`; }
    // `-p`/projectFilter is a cleartext PATH SUBSTRING (e.g. "inco-monorepo"),
    // not a resolved project_id — match it against project_path, case-insensitive.
    // Exact project_id match here meant a substring never matched and `-p`
    // silently returned nothing for every project.
    if (projectIdFilter) { params.push(`%${projectIdFilter}%`); where += ` AND project_path ILIKE $${params.length}`; }
    params.push(topK * 5);
    params.push(Date.now());
    const nowParam = params.length;
    // Ranking = normalized relevance × subagent demotion + bounded recency bonus.
    //
    //   - Normalization (`rank / max(rank)`) keeps it query-scale-independent.
    //   - Subagent transcripts (chunk_type 'subagent:…') are keyword-dense
    //     internal expansions that win raw ts_rank against the user's own
    //     conversations — measured: a months-old subagent blob outranked
    //     yesterday's session for that session's own key terms. ×0.4 keeps
    //     them findable but never lets them bury the primary conversation.
    //   - Recency is a PRIOR for a memory product, not just a tiebreak:
    //     +0.15 × exp(−age/14d), bounded — a strong old match (1.0) still
    //     beats a weak recent one (≤0.55+0.15); near-equals resolve to the
    //     newer session. mtime DESC stays as the final tiebreak. The age term
    //     is clamped (LEAST(…, 60)) because Postgres RAISES "value out of
    //     range: underflow" for exp() of a large negative — an mtime=0/ancient
    //     row would otherwise error the whole query, i.e. kill every search.
    // ts_rank normalization flag 1 divides by 1+log(doc length): long
    // keyword-dense blobs (subagent transcripts, pasted logs) otherwise
    // dominate on raw term frequency no matter what multiplier we apply.
    const sql = `SELECT chunk_id, item_id, source_type, title, text, chunk_type, project_path, file_path, mtime, rank
                 FROM (
                   SELECT chunk_id, item_id, source_type, title, text, chunk_type, project_path, file_path, mtime,
                          ts_rank(tsv, to_tsquery('english',$2), 1) AS rank
                   FROM memory_chunks WHERE ${where}
                 ) s
                 ORDER BY (rank / NULLIF(max(rank) OVER (), 0))
                          * (CASE WHEN chunk_type LIKE 'subagent%' THEN 0.4
                                  WHEN chunk_type LIKE 'tool_result%' THEN 0.5
                                  ELSE 1.0 END)
                          + 0.15 * exp(-LEAST(GREATEST($${nowParam}::double precision - COALESCE(mtime, 0), 0) / (14.0 * 86400000), 60))
                          -- Importance prior: the classifier tags decisions/milestones as
                          -- ':imp4'/':imp5' in chunk_type. Surface them above equal-keyword
                          -- chatter with a small bounded boost (imp5 → +0.10, untagged → +0.02).
                          + 0.10 * (COALESCE(NULLIF(substring(chunk_type from 'imp([0-9])'), '')::int, 1) / 5.0) DESC,
                          mtime DESC NULLS LAST
                 LIMIT $${params.length - 1}`;
    let rows: any[];
    try {
      rows = await this.qr(sql, params);
      // R7 fallback: if the strict AND attempt found too little, widen to OR.
      // (params[1] is the $2 tsquery arg.) Preserves recall while giving the
      // precision of an all-terms match whenever that match is substantial.
      if (andTsq && andTsq !== orTsq && rows.length < 3) {
        params[1] = orTsq;
        rows = await this.qr(sql, params);
      }
      // Typo tolerance: keyword FTS found nothing → fall back to a pg_trgm
      // word-similarity match so a misspelling ("revenucat", "postgress") still
      // finds the right sessions. Uses idx_chunks_text_trgm via the `<%` operator.
      // Best-effort: if pg_trgm/the index isn't present it throws and we keep the
      // empty FTS result (search never breaks for lack of the extension).
      const tq = query.trim();
      if (rows.length === 0 && tq) {
        try {
          const tp: unknown[] = [this.t, tq];
          let tw = `tenant=$1 AND $2 <% text`;
          if (sourceTypes && sourceTypes.length > 0) { tp.push(sourceTypes); tw += ` AND source_type = ANY($${tp.length})`; }
          if (projectIdFilter) { tp.push(`%${projectIdFilter}%`); tw += ` AND project_path ILIKE $${tp.length}`; }
          tp.push(topK * 5);
          rows = await tenantTx(this.pool, this.t, async (client: any) => {
            // Bound the trigram scan: a typo whose trigrams are common ("keyclock"
            // → key/loc/ock everywhere) can match a huge candidate set and take
            // 10s+. Cap at 2.5s — if it can't surface a close match fast, return
            // nothing rather than hang the request (measured: 16s without this).
            await client.query(`SET LOCAL statement_timeout = '2500ms'`);
            const r = await client.query(
              `SELECT chunk_id, item_id, source_type, title, text, chunk_type, project_path, file_path, mtime,
                      word_similarity($2, text) AS rank
               FROM memory_chunks WHERE ${tw}
               ORDER BY rank DESC, mtime DESC NULLS LAST
               LIMIT $${tp.length}`, tp);
            return r.rows;
          });
        } catch { /* pg_trgm/index absent, or scan hit the 2.5s cap — keep plain-FTS result */ }
      }
    } catch (e) {
      // A malformed tsquery from user input must degrade to "no results", but
      // the error still has to be visible — a silent catch here once hid a
      // ranking-SQL bug (exp underflow) as "search returns nothing" in prod.
      const { createLogger } = await import('../logger.js');
      createLogger('pg').warn({ err: e }, 'searchFTS query failed — returning no results');
      return [];
    }

    // Named-conversation matches. A user-assigned title (Claude Code /rename
    // parity) is the strongest "find the one I named X" intent signal, so these
    // sessions surface FIRST. Read straight from session_metadata.user_title —
    // durable across re-index, unlike a synthetic FTS chunk (addChunksFTS wipes
    // an item's chunks on every re-sync). groupChunks preserves insertion order,
    // so prepending puts named hits at the top; a session that is both a named
    // hit and an FTS hit merges into the single named entry.
    let namedRows: any[] = [];
    const q = query.trim();
    if (q && (!sourceTypes || sourceTypes.includes('session'))) {
      const np: unknown[] = [this.t, `%${q}%`];
      // Match a user-assigned name OR the tool's native title (Claude ai-title,
      // OpenCode session.title). The display title prefers the user name.
      let nwhere = `sm.tenant=$1 AND (sm.user_title ILIKE $2 OR sm.tool_title ILIKE $2)`;
      if (projectIdFilter) { np.push(`%${projectIdFilter}%`); nwhere += ` AND mm.project_path ILIKE $${np.length}`; }
      np.push(topK);
      try {
        namedRows = await this.qr(
          `SELECT sm.session_id AS chunk_id, sm.session_id AS item_id, 'session' AS source_type,
                  COALESCE(NULLIF(sm.user_title,''), sm.tool_title) AS title,
                  COALESCE(NULLIF(sm.user_title,''), sm.tool_title) AS text,
                  CASE WHEN sm.user_title ILIKE $2 THEN 'user:title' ELSE 'tool:title' END AS chunk_type,
                  mm.project_path, mm.file_path, mm.mtime, 1.0 AS rank
           FROM session_metadata sm
           JOIN memory_metadata mm ON mm.tenant=sm.tenant AND mm.id=sm.session_id AND mm.source_type='session'
           WHERE ${nwhere}
           ORDER BY mm.mtime DESC NULLS LAST
           LIMIT $${np.length}`, np);
      } catch { namedRows = []; }
    }
    return groupChunks([...namedRows, ...rows], topK);
  }

  async topImportantChunks(opts: Args<'topImportantChunks'>[0] = {}): Promise<MemorySearchResult[]> {
    const { limit = 10, minImportance = 4, projectIdFilter } = opts;
    // Select by the classifier's tag, not by keyword. `imp` is parsed out of
    // chunk_type ('…:decision:imp5') and used both to filter (>= minImportance)
    // and to order — so wake-up returns the genuinely highest-importance
    // memories, newest-first, regardless of what words they contain.
    const { sourceTypes } = opts;
    const params: unknown[] = [this.t, minImportance];
    let where = `tenant=$1 AND COALESCE(NULLIF(substring(chunk_type from 'imp([0-9])'), '')::int, 0) >= $2`;
    if (sourceTypes && sourceTypes.length > 0) { params.push(sourceTypes); where += ` AND source_type = ANY($${params.length})`; }
    if (projectIdFilter) { params.push(`%${projectIdFilter}%`); where += ` AND project_path ILIKE $${params.length}`; }
    params.push(limit);
    const sql = `SELECT chunk_id, item_id, source_type, title, text, chunk_type, project_path, file_path, mtime,
                        COALESCE(NULLIF(substring(chunk_type from 'imp([0-9])'), '')::int, 0) AS imp
                 FROM memory_chunks WHERE ${where}
                 ORDER BY imp DESC, mtime DESC
                 LIMIT $${params.length}`;
    let rows: any[];
    try { rows = await this.qr(sql, params); }
    catch (e) { const { createLogger } = await import('../logger.js'); createLogger('pg').warn({ err: e }, 'topImportantChunks failed'); return []; }
    // No item grouping: distinct high-importance facts (several per session is fine).
    return rows.map((r) => ({
      itemId: r.item_id, sourceType: r.source_type as SourceType, title: r.title, text: r.text,
      score: 1, chunkType: r.chunk_type, projectPath: r.project_path, filePath: r.file_path, mtime: r.mtime,
      matchedChunks: [{ chunkType: r.chunk_type, text: r.text, score: 1 }],
    }));
  }

  /**
   * Re-run the current classifier over already-indexed chunks (the reclassify
   * sweep). Keyset-paginated so it streams the whole table without holding it in
   * memory; only rows whose tag actually changed are written. Idempotent — a
   * second run after the first catches up is a no-op. Skips subagent/tool_result
   * (never classified). Returns {scanned, updated}.
   */
  async reclassifyChunks(batch = 2000): Promise<{ scanned: number; updated: number }> {
    const { reclassifyChunkType } = await import('../memory-classifier.js');
    let scanned = 0, updated = 0, lastId = '';
    for (;;) {
      const rows = await this.qr(
        `SELECT chunk_id, chunk_type, text FROM memory_chunks
         WHERE tenant=$1 AND chunk_id > $2 AND chunk_type NOT LIKE 'subagent%' AND chunk_type <> 'tool_result'
         ORDER BY chunk_id LIMIT $3`, [this.t, lastId, batch]);
      if (rows.length === 0) break;
      const changed: Array<[string, string]> = [];
      for (const r of rows) {
        scanned++;
        lastId = r.chunk_id;
        const nt = reclassifyChunkType(r.chunk_type, r.text);
        if (nt !== r.chunk_type) changed.push([r.chunk_id, nt]);
      }
      if (changed.length) {
        await tenantTx(this.pool, this.t, async (client) => {
          for (const [id, nt] of changed) {
            await client.query(`UPDATE memory_chunks SET chunk_type=$3 WHERE tenant=$1 AND chunk_id=$2`, [this.t, id, nt]);
          }
        });
        updated += changed.length;
      }
    }
    return { scanned, updated };
  }

  async countItemChunks(sourceType: string, itemId: string): Promise<number> {
    return (await this.oneRo(`SELECT COUNT(*)::int AS n FROM memory_chunks WHERE tenant=$1 AND source_type=$2 AND item_id=$3`, [this.t, sourceType, itemId])).n;
  }

  async getFTSCount(): Promise<number> {
    return (await this.oneRo(`SELECT COUNT(*)::int AS count FROM memory_chunks WHERE tenant=$1`, [this.t])).count;
  }
  async countDistinctItemsMatching(query: string, options: Args<'countDistinctItemsMatching'>[1] = {}): Promise<number> {
    const tsq = orPrefixTsQuery(query);
    if (!tsq) return 0;
    const params: unknown[] = [this.t, tsq];
    let sql = `SELECT COUNT(DISTINCT item_id)::int AS n FROM memory_chunks WHERE tenant=$1 AND tsv @@ to_tsquery('english',$2)`;
    if (options.sourceTypes && options.sourceTypes.length > 0) { params.push(options.sourceTypes); sql += ` AND source_type = ANY($${params.length})`; }
    if (options.projectFilter) { params.push(`%${options.projectFilter}%`); sql += ` AND project_path LIKE $${params.length}`; }
    try { return (await this.oneRo(sql, params))?.n ?? 0; } catch { return 0; }
  }

  // ── tombstones / purge ──
  async addTombstone(sessionId: string): Promise<void> {
    await this.q(`INSERT INTO session_tombstones (tenant, session_id, deleted_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [this.t, sessionId, Date.now()]);
  }
  async listTombstones(): Promise<Array<{ session_id: string; deleted_at: number }>> {
    const rows = await this.q(`SELECT session_id, deleted_at FROM session_tombstones WHERE tenant=$1`, [this.t]);
    return rows.map((r: any) => ({ session_id: r.session_id, deleted_at: Number(r.deleted_at) }));
  }
  async purgeSession(sessionId: string): Promise<void> {
    const run = async (sql: string, params: unknown[]) => { try { await this.q(sql, params); } catch { /* absent */ } };
    await run(`DELETE FROM memory_metadata WHERE tenant=$1 AND id=$2 AND source_type='session'`, [this.t, sessionId]);
    await run(`DELETE FROM memory_chunks WHERE tenant=$1 AND item_id=$2 AND source_type='session'`, [this.t, sessionId]);
    // memory_vectors is written by the vector store but carries its own text
    // column returned by semantic search — if we don't purge it here, a deleted
    // session keeps surfacing in vector results. run() swallows the error when
    // the table is absent (no embedder ever configured).
    await run(`DELETE FROM memory_vectors WHERE tenant=$1 AND item_id=$2 AND source_type='session'`, [this.t, sessionId]);
    await run(`DELETE FROM content_cache WHERE tenant=$1 AND id=$2 AND source_type='session'`, [this.t, sessionId]);
    await run(`DELETE FROM raw_sessions WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId]);
    await run(`DELETE FROM secret_findings WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId]);
    await run(`DELETE FROM session_metadata WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId]);
    await run(`DELETE FROM compute_cache WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId]);
    await run(`DELETE FROM session_outcome_cache WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId]);
    await run(`DELETE FROM memory_links WHERE tenant=$1 AND ((source_type='session' AND source_id=$2) OR (target_type='session' AND target_id=$2))`, [this.t, sessionId]);
  }

  // ── raw session archive (shrink-protected — see memory-store.ts) ──
  async putRawSession(sessionId: string, tool: string, mtime: number, gz: Buffer, uncompressedSize: number, projectId = '', projectPath = ''): Promise<'stored' | 'shrink-protected' | 'unchanged'> {
    const existing = await this.one(`SELECT size, mtime, project_id FROM raw_sessions WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId]);
    if (existing) {
      // Fill a missing project id even when the capture is unchanged/shrunk, so a
      // legacy archive becomes self-sufficient the next time it's re-synced.
      if (projectId && !existing.project_id) {
        await this.q(`UPDATE raw_sessions SET project_id=$3, project_path=$4 WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId, projectId, projectPath]);
      }
      if (Number(existing.size) === uncompressedSize && Number(existing.mtime) >= intMs(mtime)) return 'unchanged';
      if (uncompressedSize < Number(existing.size)) return 'shrink-protected';
    }
    await this.q(
      `INSERT INTO raw_sessions (tenant, session_id, tool, mtime, size, gz, captured_at, project_id, project_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant, session_id) DO UPDATE SET
         tool=excluded.tool, mtime=excluded.mtime, size=excluded.size,
         gz=excluded.gz, captured_at=excluded.captured_at,
         project_id=CASE WHEN excluded.project_id <> '' THEN excluded.project_id ELSE raw_sessions.project_id END,
         project_path=CASE WHEN excluded.project_path <> '' THEN excluded.project_path ELSE raw_sessions.project_path END`,
      [this.t, sessionId, tool, intMs(mtime), uncompressedSize, gz, Date.now(), projectId, projectPath]);
    return 'stored';
  }
  // Primary: fetching a raw archived session is re-processing-adjacent (and may
  // run right after a sync writes it), so keep it strongly consistent.
  async getRawSession(sessionId: string): Promise<{ tool: string; mtime: number; size: number; gz: Buffer; captured_at: number; project_id: string; project_path: string } | null> {
    const r = await this.one(`SELECT tool, mtime, size, gz, captured_at, project_id, project_path FROM raw_sessions WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId]);
    return r ? { tool: r.tool, mtime: Number(r.mtime), size: Number(r.size), gz: r.gz, captured_at: Number(r.captured_at), project_id: r.project_id ?? '', project_path: r.project_path ?? '' } : null;
  }
  async listRawSessionVersions(): Promise<Array<{ session_id: string; mtime: number; size: number }>> {
    const rows = await this.qr(`SELECT session_id, mtime, size FROM raw_sessions WHERE tenant=$1`, [this.t]);
    return rows.map((r: any) => ({ session_id: r.session_id, mtime: Number(r.mtime), size: Number(r.size) }));
  }
  async listEnvelopesMissingRawArchive(sinceMs = 0, limit = 200): Promise<string[]> {
    const rows = await this.qr(
      `SELECT c.id FROM content_cache c
       WHERE c.tenant=$1 AND c.source_type='session' AND c.mtime >= $2
         AND NOT EXISTS (SELECT 1 FROM raw_sessions r WHERE r.tenant=$1 AND r.session_id = c.id)
       ORDER BY c.mtime DESC LIMIT $3`,
      [this.t, Math.floor(sinceMs) || 0, limit]);
    return rows.map((r: any) => r.id);
  }

  // ── KV ──
  async kvSet(scope: string, key: string, value: string): Promise<void> {
    await this.q(`INSERT INTO kv_store (tenant,scope,key,value,updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant,scope,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, [this.t, scope, key, value, Date.now()]);
  }
  async kvGet(scope: string, key: string): Promise<Ret<'kvGet'>> {
    return (await this.one(`SELECT value, updated_at FROM kv_store WHERE tenant=$1 AND scope=$2 AND key=$3`, [this.t, scope, key])) ?? null;
  }
  async kvDelete(scope: string, key: string): Promise<boolean> {
    const r = await tenantQuery(this.pool, this.tenant, `DELETE FROM kv_store WHERE tenant=$1 AND scope=$2 AND key=$3`, [this.t, scope, key]);
    return r.rowCount > 0;
  }
  async kvList(scope?: string, limit = 200): Promise<Ret<'kvList'>> {
    if (scope === undefined) return this.q(`SELECT scope, key, value, updated_at FROM kv_store WHERE tenant=$1 ORDER BY updated_at DESC LIMIT $2`, [this.t, limit]) as any;
    return this.q(`SELECT scope, key, value, updated_at FROM kv_store WHERE tenant=$1 AND scope=$2 ORDER BY updated_at DESC LIMIT $3`, [this.t, scope, limit]) as any;
  }

  // ── Cross-tool sync intents (Model B queue) ──
  async enqueueSyncIntent(input: Args<'enqueueSyncIntent'>[0]): Promise<string> {
    const id = 'si_' + randomBytes(8).toString('hex');
    const now = Date.now();
    await this.q(`INSERT INTO sync_intents
      (tenant, id, device_id, kind, artifact_type, name, from_tool, to_tool, status, result, created_at, updated_at, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',NULL,$9,$10,$11)`,
      [this.t, id, input.deviceId ?? null, input.kind, input.artifactType ?? null, input.name ?? null,
       input.fromTool ?? null, input.toTool ?? null, now, now, input.createdBy ?? null]);
    return id;
  }
  async listPendingSyncIntents(deviceId?: string | null, limit = 50): Promise<Ret<'listPendingSyncIntents'>> {
    const rows = await this.q(`SELECT id, device_id, kind, artifact_type, name, from_tool, to_tool, status, result, created_at, updated_at, created_by
      FROM sync_intents WHERE tenant=$1 AND status='pending' AND (device_id IS NULL OR device_id=$2)
      ORDER BY created_at ASC LIMIT $3`, [this.t, deviceId ?? null, limit]);
    return rows.map(normalizeIntentRow) as Ret<'listPendingSyncIntents'>;
  }
  async listAllPendingSyncIntents(limit = 1000): Promise<Ret<'listAllPendingSyncIntents'>> {
    const rows = await this.q(`SELECT id, device_id, kind, artifact_type, name, from_tool, to_tool, status, result, created_at, updated_at, created_by
      FROM sync_intents WHERE tenant=$1 AND status='pending'
      ORDER BY created_at ASC LIMIT $2`, [this.t, limit]);
    return rows.map(normalizeIntentRow) as any;
  }
  async ackSyncIntent(id: string, status: 'done' | 'error', result?: string | null): Promise<boolean> {
    const r = await tenantQuery(this.pool, this.tenant,
      `UPDATE sync_intents SET status=$2, result=$3, updated_at=$4 WHERE tenant=$1 AND id=$5`,
      [this.t, status, result ?? null, Date.now(), id]);
    return r.rowCount > 0;
  }
  async listSyncIntents(limit = 50): Promise<Ret<'listSyncIntents'>> {
    const rows = await this.qr(`SELECT id, device_id, kind, artifact_type, name, from_tool, to_tool, status, result, created_at, updated_at, created_by
      FROM sync_intents WHERE tenant=$1 ORDER BY created_at DESC LIMIT $2`, [this.t, limit]);
    return rows.map(normalizeIntentRow) as Ret<'listSyncIntents'>;
  }

  // ── code intelligence (codeindex merge) ──
  async upsertCodeProject(p: Args<'upsertCodeProject'>[0]): Promise<void> {
    const now = Date.now();
    // code_* is PROJECT-scoped SHARED data (one row per project, any member may
    // re-index it). Run the upsert UNRESTRICTED so the ON CONFLICT conflict-check
    // isn't fail-closed by the author_visibility SELECT gate when the indexing
    // member has no visible session in the project. Safe: no author-write-guard on
    // code_*, tenant isolation still applies, reads stay gated. See runUnrestricted.
    // label omitted from the UPDATE set so a user-assigned label survives re-index.
    await runUnrestricted(() => this.q(`INSERT INTO code_projects
      (tenant, project_id, root_path, file_count, symbol_count, langs_json, health_json, map_json, label, indexed_by, last_indexed_at, collector_version, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
      ON CONFLICT (tenant, project_id) DO UPDATE SET
        root_path=excluded.root_path, file_count=excluded.file_count, symbol_count=excluded.symbol_count,
        langs_json=excluded.langs_json, health_json=excluded.health_json, map_json=excluded.map_json,
        indexed_by=excluded.indexed_by, last_indexed_at=excluded.last_indexed_at,
        collector_version=excluded.collector_version, updated_at=excluded.updated_at`,
      [this.t, p.projectId, p.rootPath, p.fileCount | 0, p.symbolCount | 0,
       JSON.stringify(p.langs ?? {}), JSON.stringify(p.health ?? {}), JSON.stringify(p.map ?? {}),
       p.label ?? null, p.indexedBy ?? null, intMs(p.lastIndexedAt), p.collectorVersion ?? null, now]));
  }
  async getCodeProject(projectId: string): Promise<Ret<'getCodeProject'>> {
    const r = await this.oneRo(`SELECT * FROM code_projects WHERE tenant=$1 AND project_id=$2`, [this.t, projectId]);
    return (r ? pgRowToCodeProject(r) : null) as Ret<'getCodeProject'>;
  }
  async listCodeProjects(): Promise<Ret<'listCodeProjects'>> {
    const rows = await this.qr(`SELECT * FROM code_projects WHERE tenant=$1 ORDER BY last_indexed_at DESC`, [this.t]);
    return rows.map(pgRowToCodeProject) as Ret<'listCodeProjects'>;
  }
  async setCodeProjectLabel(projectId: string, label: Args<'setCodeProjectLabel'>[1]): Promise<boolean> {
    const r = await tenantQuery(this.pool, this.tenant,
      `UPDATE code_projects SET label=$2, updated_at=$3 WHERE tenant=$1 AND project_id=$4`,
      [this.t, label, Date.now(), projectId]);
    return r.rowCount > 0;
  }
  async deleteCodeProject(projectId: string): Promise<boolean> {
    return tenantTx(this.pool, this.tenant, async (c) => {
      await c.query(`DELETE FROM code_findings WHERE tenant=$1 AND project_id=$2`, [this.t, projectId]);
      await c.query(`DELETE FROM code_hotspots WHERE tenant=$1 AND project_id=$2`, [this.t, projectId]);
      await c.query(`DELETE FROM code_actions WHERE tenant=$1 AND project_id=$2`, [this.t, projectId]);
      const r = await c.query(`DELETE FROM code_projects WHERE tenant=$1 AND project_id=$2`, [this.t, projectId]);
      return r.rowCount > 0;
    });
  }

  async replaceCodeFindings(projectId: string, findings: Args<'replaceCodeFindings'>[1]): Promise<number> {
    const now = Date.now();
    // Unrestricted: PROJECT-scoped shared data — see upsertCodeProject.
    return runUnrestricted(() => tenantTx(this.pool, this.tenant, async (c) => {
      const prev = (await c.query(`SELECT id, first_seen_at, status FROM code_findings WHERE tenant=$1 AND project_id=$2`, [this.t, projectId])).rows;
      const prevById = new Map<string, any>(prev.map((r: any) => [r.id, r]));
      await c.query(`DELETE FROM code_findings WHERE tenant=$1 AND project_id=$2`, [this.t, projectId]);
      const rows = findings.map((f) => {
        const id = f.id ?? codeFindingId(projectId, f);
        const carried = prevById.get(id);
        return [this.t, id, projectId, f.category, f.severity, f.file, f.line ?? null, f.rule, f.title,
          f.snippet ?? '', f.why ?? '', f.agentPrompt ?? '', carried?.status ?? 'open',
          carried ? Number(carried.first_seen_at) : now, now, JSON.stringify(f.extra ?? {})];
      });
      await bulkInsert(c, 'code_findings',
        ['tenant','id','project_id','category','severity','file','line','rule','title','snippet','why','agent_prompt','status','first_seen_at','last_seen_at','extra_json'],
        dedupeById(rows));
      return findings.length;
    }));
  }
  async listCodeFindings(projectId?: string, opts: Args<'listCodeFindings'>[1] = {}): Promise<Ret<'listCodeFindings'>> {
    const where: string[] = ['tenant=$1']; const params: unknown[] = [this.t];
    if (projectId) { params.push(projectId); where.push(`project_id=$${params.length}`); }
    if (opts.severity) { params.push(opts.severity); where.push(`severity=$${params.length}`); }
    if (opts.category) { params.push(opts.category); where.push(`category=$${params.length}`); }
    params.push(opts.limit ?? 500);
    const rows = await this.qr(`SELECT * FROM code_findings WHERE ${where.join(' AND ')}
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, last_seen_at DESC
      LIMIT $${params.length}`, params);
    return rows.map(pgRowToCodeFinding) as Ret<'listCodeFindings'>;
  }
  async codeFindingsSummary(projectId?: string): Promise<Ret<'codeFindingsSummary'>> {
    const params: unknown[] = [this.t];
    let where = 'tenant=$1';
    if (projectId) { params.push(projectId); where += ` AND project_id=$2`; }
    const rows = await this.qr(`SELECT severity, category, COUNT(*)::int AS c FROM code_findings WHERE ${where} GROUP BY severity, category`, params);
    const sum: any = { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, byCategory: {} };
    for (const r of rows) {
      sum.total += r.c;
      if (r.severity in sum.bySeverity) sum.bySeverity[r.severity] += r.c;
      sum.byCategory[r.category] = (sum.byCategory[r.category] ?? 0) + r.c;
    }
    return sum as Ret<'codeFindingsSummary'>;
  }

  async replaceCodeHotspots(projectId: string, hotspots: Args<'replaceCodeHotspots'>[1]): Promise<number> {
    const now = Date.now();
    // Unrestricted: PROJECT-scoped shared data — see upsertCodeProject.
    return runUnrestricted(() => tenantTx(this.pool, this.tenant, async (c) => {
      await c.query(`DELETE FROM code_hotspots WHERE tenant=$1 AND project_id=$2`, [this.t, projectId]);
      const rows = hotspots.map((h) => [this.t, codeHotspotId(projectId, h.file), projectId, h.file,
        h.churn | 0, h.complexity | 0, h.score, h.aiAuthored ? 1 : 0, h.lines | 0, h.suggestion ?? '', now]);
      await bulkInsert(c, 'code_hotspots',
        ['tenant','id','project_id','file','churn','complexity','score','ai_authored','lines','suggestion','last_seen_at'], dedupeById(rows));
      return hotspots.length;
    }));
  }
  async listCodeHotspots(projectId?: string, limit = 100): Promise<Ret<'listCodeHotspots'>> {
    const params: unknown[] = [this.t];
    let where = 'tenant=$1';
    if (projectId) { params.push(projectId); where += ` AND project_id=$2`; }
    params.push(limit);
    const rows = await this.qr(`SELECT * FROM code_hotspots WHERE ${where} ORDER BY score DESC LIMIT $${params.length}`, params);
    return rows.map(pgRowToCodeHotspot) as Ret<'listCodeHotspots'>;
  }

  async upsertCodeActions(projectId: string, actions: Args<'upsertCodeActions'>[1]): Promise<number> {
    const now = Date.now();
    // Unrestricted: PROJECT-scoped shared data — see upsertCodeProject.
    return runUnrestricted(() => tenantTx(this.pool, this.tenant, async (c) => {
      const rows = actions.map((a) => {
        const id = a.id ?? codeActionId(projectId, a);
        return [this.t, id, projectId, a.pri | 0, a.category, a.title, a.fix,
          JSON.stringify(a.loc ?? []), a.agentPrompt, 'suggested', 0, now, now];
      });
      // Preserve status/queued/created_at on conflict (durable user state).
      await bulkInsert(c, 'code_actions',
        ['tenant','id','project_id','pri','category','title','fix','loc_json','agent_prompt','status','queued','created_at','updated_at'],
        dedupeById(rows),
        `ON CONFLICT (tenant, id) DO UPDATE SET
           pri=excluded.pri, category=excluded.category, title=excluded.title, fix=excluded.fix,
           loc_json=excluded.loc_json, agent_prompt=excluded.agent_prompt, updated_at=excluded.updated_at`);
      // Prune stale suggestions this run no longer produced (e.g. old false
      // positives dropped by an improved collector), but keep anything the user
      // triaged (queued/done/dismissed) so their state is never lost.
      await c.query(
        `DELETE FROM code_actions WHERE tenant=$1 AND project_id=$2 AND status='suggested' AND id <> ALL($3::text[])`,
        [this.t, projectId, rows.map((r) => r[1] as string)]);
      return actions.length;
    }));
  }
  async listCodeActions(projectId?: string, opts: Args<'listCodeActions'>[1] = {}): Promise<Ret<'listCodeActions'>> {
    const where: string[] = ['tenant=$1']; const params: unknown[] = [this.t];
    if (projectId) { params.push(projectId); where.push(`project_id=$${params.length}`); }
    if (opts.status) { params.push(opts.status); where.push(`status=$${params.length}`); }
    if (opts.queued !== undefined) { params.push(opts.queued ? 1 : 0); where.push(`queued=$${params.length}`); }
    params.push(opts.limit ?? 200);
    const rows = await this.qr(`SELECT * FROM code_actions WHERE ${where.join(' AND ')} ORDER BY pri ASC, updated_at DESC LIMIT $${params.length}`, params);
    return rows.map(pgRowToCodeAction) as Ret<'listCodeActions'>;
  }
  async setCodeActionStatus(id: string, status: Args<'setCodeActionStatus'>[1], queued?: boolean): Promise<boolean> {
    if (queued === undefined) {
      const r = await tenantQuery(this.pool, this.tenant,
        `UPDATE code_actions SET status=$2, updated_at=$3 WHERE tenant=$1 AND id=$4`, [this.t, status, Date.now(), id]);
      return r.rowCount > 0;
    }
    const r = await tenantQuery(this.pool, this.tenant,
      `UPDATE code_actions SET status=$2, queued=$3, updated_at=$4 WHERE tenant=$1 AND id=$5`,
      [this.t, status, queued ? 1 : 0, Date.now(), id]);
    return r.rowCount > 0;
  }

  async close(): Promise<void> { /* pooled connection is shared (pg-pool.ts) — closePgPools() ends it */ }
}

/** pg returns BIGINT as string — coerce the epoch columns back to numbers. */
function normalizeIntentRow(r: any): any {
  return { ...r, created_at: Number(r.created_at), updated_at: Number(r.updated_at) };
}

/** De-dupe bulk-insert rows by the id column (index 1), keeping the last —
 *  required before an ON CONFLICT INSERT, and a guard against two findings
 *  hashing to the same deterministic id within one run. */
function dedupeById(rows: unknown[][]): unknown[][] {
  return [...new Map(rows.map((r) => [r[1], r])).values()];
}

// ── code-intel pg row mappers (TEXT json columns parsed, BIGINT epochs → number) ──
function pgJson<T>(s: any, fallback: T): T {
  if (s == null) return fallback;
  if (typeof s === 'object') return s as T;          // jsonb would arrive parsed
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
function pgRowToCodeProject(r: any): any {
  return {
    projectId: r.project_id, rootPath: r.root_path, fileCount: r.file_count, symbolCount: r.symbol_count,
    langs: pgJson(r.langs_json, {}), health: pgJson(r.health_json, {}), map: pgJson(r.map_json, {}),
    label: r.label ?? null, indexedBy: r.indexed_by ?? null, lastIndexedAt: Number(r.last_indexed_at),
    collectorVersion: r.collector_version == null ? null : Number(r.collector_version),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}
function pgRowToCodeFinding(r: any): any {
  return {
    id: r.id, projectId: r.project_id, category: r.category, severity: r.severity, file: r.file,
    line: r.line ?? null, rule: r.rule, title: r.title, snippet: r.snippet, why: r.why,
    agentPrompt: r.agent_prompt, status: r.status, firstSeenAt: Number(r.first_seen_at),
    lastSeenAt: Number(r.last_seen_at), extra: pgJson(r.extra_json, {}),
  };
}
function pgRowToCodeHotspot(r: any): any {
  return {
    id: r.id, projectId: r.project_id, file: r.file, churn: r.churn, complexity: r.complexity,
    score: Number(r.score), aiAuthored: !!r.ai_authored, lines: r.lines, suggestion: r.suggestion ?? '', lastSeenAt: Number(r.last_seen_at),
  };
}
function pgRowToCodeAction(r: any): any {
  return {
    id: r.id, projectId: r.project_id, pri: r.pri, category: r.category, title: r.title, fix: r.fix,
    loc: pgJson(r.loc_json, []), agentPrompt: r.agent_prompt, status: r.status,
    queued: !!r.queued, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

/**
 * Build an OR-ed, prefix-matched tsquery from free text. `websearch_to_tsquery`
 * ANDs every word, so a natural-language query like "Solana node covalidator
 * enclave demo" requires ALL five in one chunk and returns nothing. OR-ing the
 * terms (and prefix-matching with `:*`) returns chunks matching ANY term, and
 * `ts_rank` orders them so chunks hitting more terms float to the top — which
 * is what makes multi-word recall actually find things. Returns null when the
 * query has no usable terms (caller returns []).
 */
function orPrefixTsQuery(query: string): string | null {
  const words = query.toLowerCase().match(/[a-z0-9_]{2,}/g) || [];
  if (words.length === 0) return null;
  // Dedupe and cap so a pathological query can't build a huge tsquery.
  // (Synonyms are intentionally NOT hardcoded here — see query-expander.ts /
  // the semantic tier for domain-aware expansion; a static word list is both
  // incomplete and wrong for a technical/project-specific corpus.)
  return [...new Set(words)].slice(0, 24).map((w) => `${w}:*`).join(' | ');
}

/**
 * AND variant — require ALL terms. Used as the precision-first attempt for
 * short (2–4 term) queries: OR-of-prefixes over-matches (any single common
 * word qualifies a chunk), so we try AND first and fall back to OR only when
 * AND is too strict to return enough hits. Returns null (→ use OR) outside the
 * 2–4 term window, where AND is either pointless (1 term) or too strict (5+).
 */
function andPrefixTsQuery(query: string): string | null {
  const words = [...new Set((query.toLowerCase().match(/[a-z0-9_]{2,}/g) || []))];
  if (words.length < 2 || words.length > 4) return null;
  return words.map((w) => `${w}:*`).join(' & ');
}

/** Group chunk rows by item — same shape/logic as MemoryStore.searchFTS. */
function groupChunks(rows: any[], topK: number): MemorySearchResult[] {
  if (rows.length === 0) return [];
  const itemMap = new Map<string, { itemId: string; sourceType: SourceType; title: string; projectPath: string; filePath: string; mtime: number; chunks: Array<{ chunkType: string; text: string; score: number }>; bestScore: number }>();
  for (const row of rows) {
    const score = Number(row.rank) || 0;
    const key = `${row.source_type}:${row.item_id}`;
    if (!itemMap.has(key)) itemMap.set(key, { itemId: row.item_id, sourceType: row.source_type, title: row.title, projectPath: row.project_path, filePath: row.file_path, mtime: row.mtime, chunks: [], bestScore: score });
    const item = itemMap.get(key)!;
    item.chunks.push({ chunkType: row.chunk_type, text: row.text, score });
    if (score > item.bestScore) item.bestScore = score;
  }
  const results: MemorySearchResult[] = [];
  for (const [, item] of itemMap) {
    item.chunks.sort((a, b) => b.score - a.score);
    results.push({ itemId: item.itemId, sourceType: item.sourceType, title: item.title, text: item.chunks[0]?.text || '', score: item.bestScore, chunkType: item.chunks[0]?.chunkType || 'unknown', projectPath: item.projectPath, filePath: item.filePath, mtime: item.mtime, matchedChunks: item.chunks.slice(0, 3) });
  }
  // Preserve the SQL order. Rows arrive sorted by (relevance band DESC, mtime
  // DESC), so each item's first-seen row is its best-band chunk and Map
  // insertion order already reflects the final ranking — re-sorting by raw
  // `score` here would throw away the recency tiebreaker the query applied.
  return results.slice(0, topK);
}
