import { tenantQuery } from './pg-pool.js';
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
import type { StorageDriver } from './driver.js';
import { resolveProjectId } from '../project-resolver.js';
import { METADATA_VERSION } from '../model-pricing.js';
import { applyChunkPrivacy } from '../secret-redactor.js';

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
  private readonly databaseUrl: string;
  private readonly tenant: string;

  constructor(databaseUrl?: string, tenant?: string) {
    this.databaseUrl =
      databaseUrl || process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL || '';
    this.tenant = tenant || process.env.CHAT_RECALL_TENANT || 'default';
  }

  async init(): Promise<void> {
    if (!this.databaseUrl) throw new Error('PgStore: no DATABASE_URL configured');
    // Shared per-URL pool (schema bootstrap + int8 parser handled inside).
    const { openPgPool } = await import('./pg-pool.js');
    this.pool = await openPgPool(this.databaseUrl);
    // display_name = tenant keeps migrated databases happy (legacy schema
    // declared the column NOT NULL).
    await this.q(`INSERT INTO tenants (tenant, display_name, created_at) VALUES ($1, $1, $2) ON CONFLICT DO NOTHING`, [this.tenant, Date.now()]);
  }

  private async q(sql: string, params: unknown[] = []): Promise<any[]> {
    const r = await tenantQuery(this.pool, this.tenant, sql, params);
    return r.rows;
  }
  private async one(sql: string, params: unknown[] = []): Promise<any> {
    return (await this.q(sql, params))[0];
  }
  private get t() { return this.tenant; }

  // ── metadata / items ──
  async setItem(item: MemoryItem): Promise<void> {
    if (item.sourceType === 'session') {
      await this.q(`DELETE FROM session_metadata WHERE tenant=$1 AND session_id=$2`, [this.t, item.id]);
    }
    const resolved = !item.projectId && item.projectPath ? resolveProjectId(item.projectPath) : null;
    const projectId = item.projectId ?? (resolved && resolved.source !== 'ignored' ? resolved.id : '');
    await this.q(
      `INSERT INTO memory_metadata (tenant,id,source_type,title,project_path,project_id,content_preview,file_path,mtime,indexed_at,extra_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant,id,source_type) DO UPDATE SET
         title=excluded.title, project_path=excluded.project_path, project_id=excluded.project_id,
         content_preview=excluded.content_preview, file_path=excluded.file_path, mtime=excluded.mtime,
         indexed_at=excluded.indexed_at, extra_json=excluded.extra_json`,
      [this.t, item.id, item.sourceType, item.title, item.projectPath, projectId,
       item.contentPreview || '', item.filePath, intMs(item.mtime), Date.now(), JSON.stringify(item.extra || {})],
    );
  }

  private static COLS = 'id, source_type, title, project_path, project_id, content_preview, file_path, mtime, indexed_at, extra_json';

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
    return this.q(`SELECT ${PgStore.COLS} FROM memory_metadata WHERE tenant=$1 AND source_type=$2 ORDER BY mtime DESC LIMIT $3 OFFSET $4`, [this.t, sourceType, limit, offset]);
  }

  async listItemsByProject(sourceType: SourceType, projectPath: string, limit = 10): Promise<MemoryMetadataRow[]> {
    return this.q(`SELECT ${PgStore.COLS} FROM memory_metadata WHERE tenant=$1 AND source_type=$2 AND (project_path=$3 OR project_path LIKE $4) ORDER BY mtime DESC LIMIT $5`, [this.t, sourceType, projectPath, `${projectPath}%`, limit]);
  }

  async listItemsByProjectId(sourceType: SourceType | null, projectId: string, limit = 50): Promise<MemoryMetadataRow[]> {
    const where = sourceType ? `tenant=$1 AND source_type=$2 AND project_id=$3` : `tenant=$1 AND project_id=$2`;
    const params: unknown[] = sourceType ? [this.t, sourceType, projectId] : [this.t, projectId];
    let sql = `SELECT ${PgStore.COLS} FROM memory_metadata WHERE ${where} ORDER BY mtime DESC`;
    if (limit > 0) { sql += ` LIMIT $${params.length + 1}`; params.push(limit); }
    return this.q(sql, params);
  }

  async listAllProjectIdPaths(): Promise<Ret<'listAllProjectIdPaths'>> {
    return this.q(`SELECT DISTINCT ON (project_id) project_id, project_path FROM memory_metadata WHERE tenant=$1 AND project_id<>'' AND project_path<>'' ORDER BY project_id, mtime DESC`, [this.t]) as any;
  }

  async listProjectsSummary(): Promise<Ret<'listProjectsSummary'>> {
    return this.q(`SELECT project_id, COUNT(*)::int AS items, MAX(mtime) AS last_mtime FROM memory_metadata WHERE tenant=$1 AND project_id<>'' GROUP BY project_id ORDER BY last_mtime DESC`, [this.t]) as any;
  }

  async listAllSessionsForPrecompute(): Promise<Ret<'listAllSessionsForPrecompute'>> {
    const rows = await this.q(`SELECT id, mtime, (extra_json::jsonb->>'tool') AS tool FROM memory_metadata WHERE tenant=$1 AND source_type='session' ORDER BY mtime DESC`, [this.t]);
    return rows.map(r => ({ id: r.id, mtime: r.mtime || 0, tool: r.tool || 'claude' })) as any;
  }

  async listAllSessionProjectPaths(): Promise<Ret<'listAllSessionProjectPaths'>> {
    return this.q(`SELECT id, project_path FROM memory_metadata WHERE tenant=$1 AND source_type='session' AND project_path<>''`, [this.t]) as any;
  }

  async listSessionsModifiedSince(sinceMs: number): Promise<Ret<'listSessionsModifiedSince'>> {
    return this.q(`SELECT id, mtime, project_path FROM memory_metadata WHERE tenant=$1 AND source_type='session' AND mtime>=$2 ORDER BY mtime DESC`, [this.t, sinceMs]) as any;
  }

  async listAllSessionPaths(): Promise<Ret<'listAllSessionPaths'>> {
    return this.q(`SELECT id, file_path FROM memory_metadata WHERE tenant=$1 AND source_type='session' AND file_path<>''`, [this.t]) as any;
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
    const total = (await this.one(`SELECT COUNT(*)::int AS n FROM memory_metadata WHERE ${whereSQL}`, params)).n;
    const rows = await this.q(`SELECT ${PgStore.COLS} FROM memory_metadata WHERE ${whereSQL} ORDER BY mtime DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, opts.limit, opts.offset]);
    return { rows, total } as any;
  }

  async getStats(): Promise<Ret<'getStats'>> {
    const rows = await this.q(`SELECT source_type, COUNT(*)::int AS count FROM memory_metadata WHERE tenant=$1 GROUP BY source_type`, [this.t]);
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
  async addLink(link: MemoryLink): Promise<void> {
    await this.q(
      `INSERT INTO memory_links (tenant,source_type,source_id,target_type,target_id,link_type,confidence,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant,source_type,source_id,target_type,target_id,link_type) DO UPDATE SET confidence=excluded.confidence, created_at=excluded.created_at`,
      [this.t, link.sourceType, link.sourceId, link.targetType, link.targetId, link.linkType, link.confidence, Date.now()],
    );
  }
  async addLinks(links: MemoryLink[]): Promise<void> {
    for (const link of links) await this.addLink(link);
  }
  async getLinksFrom(sourceType: SourceType, sourceId: string): Promise<MemoryLinkRow[]> {
    return this.q(`SELECT * FROM memory_links WHERE tenant=$1 AND source_type=$2 AND source_id=$3`, [this.t, sourceType, sourceId]);
  }
  async getLinksTo(targetType: SourceType, targetId: string): Promise<MemoryLinkRow[]> {
    return this.q(`SELECT * FROM memory_links WHERE tenant=$1 AND target_type=$2 AND target_id=$3`, [this.t, targetType, targetId]);
  }
  async getAllLinks(sourceType: SourceType, itemId: string): Promise<MemoryLinkRow[]> {
    return this.q(`SELECT * FROM memory_links WHERE tenant=$1 AND ((source_type=$2 AND source_id=$3) OR (target_type=$2 AND target_id=$3))`, [this.t, sourceType, itemId]);
  }
  async getLinkCount(): Promise<number> {
    return (await this.one(`SELECT COUNT(*)::int AS count FROM memory_links WHERE tenant=$1`, [this.t])).count;
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
    let written = 0;
    for (const f of findings) {
      const r = await tenantQuery(this.pool, this.tenant, 
        `INSERT INTO secret_findings (tenant,session_id,detector,rule,line,preview,scanned_at,verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant,session_id,detector,rule,line) DO NOTHING`,
        [this.t, sessionId, f.detector, f.rule, f.line, f.preview, now, f.verified === true ? 1 : f.verified === false ? 0 : null],
      );
      written += r.rowCount || 0;
    }
    return { written };
  }

  async secretFindingsSummary(): Promise<Ret<'secretFindingsSummary'>> {
    const totals = await this.q(`SELECT detector, COUNT(*)::int AS findings, COUNT(DISTINCT session_id)::int AS sessions FROM secret_findings WHERE tenant=$1 GROUP BY detector ORDER BY detector`, [this.t]);
    const topRules = await this.q(`SELECT detector, rule, COUNT(*)::int AS n FROM secret_findings WHERE tenant=$1 GROUP BY detector, rule ORDER BY n DESC LIMIT 30`, [this.t]);
    const sessionsWithFindings = (await this.one(`SELECT COUNT(DISTINCT session_id)::int AS n FROM secret_findings WHERE tenant=$1`, [this.t])).n;
    return { totals, topRules, sessionsWithFindings } as any;
  }

  async secretFindingsBySession(): Promise<Ret<'secretFindingsBySession'>> {
    return this.q(
      `SELECT sf.session_id, sf.detector, COUNT(*)::int AS n, m.project_path, m.title, m.mtime
       FROM secret_findings sf LEFT JOIN memory_metadata m ON m.tenant=sf.tenant AND m.id=sf.session_id AND m.source_type='session'
       WHERE sf.tenant=$1 GROUP BY sf.session_id, sf.detector, m.project_path, m.title, m.mtime`, [this.t]) as any;
  }

  async secretFindingsByProject(): Promise<Ret<'secretFindingsByProject'>> {
    return this.q(
      `SELECT COALESCE(NULLIF(m.project_path,''),'(unknown)') AS project_path,
              COUNT(*)::int AS occurrences, COUNT(DISTINCT sf.preview)::int AS "distinctSecrets",
              COUNT(DISTINCT CASE WHEN sf.verified=1 THEN sf.preview END)::int AS verified,
              COUNT(DISTINCT sf.session_id)::int AS sessions, MAX(sf.scanned_at) AS "lastSeen"
       FROM secret_findings sf LEFT JOIN memory_metadata m ON m.tenant=sf.tenant AND m.id=sf.session_id AND m.source_type='session'
       WHERE sf.tenant=$1 GROUP BY 1 ORDER BY verified DESC, "distinctSecrets" DESC`, [this.t]) as any;
  }

  async secretFindingsTrend(days = 30): Promise<Ret<'secretFindingsTrend'>> {
    const sinceMs = Date.now() - days * 86_400_000;
    return this.q(
      `SELECT to_char(to_timestamp(sf.scanned_at/1000),'YYYY-MM-DD') AS day,
              COUNT(*)::int AS occurrences, COUNT(DISTINCT sf.preview)::int AS "distinctSecrets",
              COUNT(DISTINCT CASE WHEN sf.verified=1 THEN sf.preview END)::int AS verified
       FROM secret_findings sf WHERE sf.tenant=$1 AND sf.scanned_at>=$2 GROUP BY day ORDER BY day ASC`, [this.t, sinceMs]) as any;
  }

  async secretFindingsByRule(): Promise<Ret<'secretFindingsByRule'>> {
    const rules = await this.q(
      `SELECT detector, rule, COUNT(*)::int AS occurrences, COUNT(DISTINCT preview)::int AS "distinctSecrets", COUNT(DISTINCT session_id)::int AS sessions
       FROM secret_findings WHERE tenant=$1 GROUP BY detector, rule ORDER BY "distinctSecrets" DESC, occurrences DESC`, [this.t]);
    const out = [];
    for (const r of rules) {
      const ss = await this.q(`SELECT DISTINCT session_id FROM secret_findings WHERE tenant=$1 AND detector=$2 AND rule=$3 LIMIT 3`, [this.t, r.detector, r.rule]);
      const pv = await this.q(`SELECT DISTINCT preview FROM secret_findings WHERE tenant=$1 AND detector=$2 AND rule=$3 LIMIT 5`, [this.t, r.detector, r.rule]);
      out.push({ ...r, sampleSessions: ss.map(x => x.session_id), samplePreviews: pv.map(x => x.preview) });
    }
    return out as any;
  }

  async secretFindingsByDistinctSecret(): Promise<Ret<'secretFindingsByDistinctSecret'>> {
    const rows = await this.q(
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
    return (await this.one(`SELECT COUNT(DISTINCT session_id)::int AS n FROM secret_findings WHERE tenant=$1 AND preview=$2 AND session_id<>$3`, [this.t, preview, excludeSessionId])).n;
  }

  async secretFindingsForSession(sessionId: string): Promise<Ret<'secretFindingsForSession'>> {
    return this.q(`SELECT detector, rule, line, preview, scanned_at FROM secret_findings WHERE tenant=$1 AND session_id=$2 ORDER BY detector, line`, [this.t, sessionId]) as any;
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
    await this.q(
      `INSERT INTO secret_dismissals (tenant,preview,status,reason,dismissed_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant,preview) DO UPDATE SET status=excluded.status, reason=excluded.reason, dismissed_at=excluded.dismissed_at`,
      [this.t, preview, status, reason || null, Date.now()]);
  }
  async clearSecretDismissal(preview: string): Promise<void> {
    await this.q(`DELETE FROM secret_dismissals WHERE tenant=$1 AND preview=$2`, [this.t, preview]);
  }
  async getSecretDismissals(): Promise<Ret<'getSecretDismissals'>> {
    const out = new Map<string, { status: string; reason: string | null; dismissed_at: number }>();
    for (const r of await this.q(`SELECT preview, status, reason, dismissed_at FROM secret_dismissals WHERE tenant=$1`, [this.t])) {
      out.set(r.preview, { status: r.status, reason: r.reason, dismissed_at: r.dismissed_at });
    }
    return out as any;
  }

  // ── FTS (Postgres tsvector) ──
  async addChunksFTS(chunks: MemoryChunk[]): Promise<number> {
    const valid = chunks.filter(c => c.text && c.text.trim().length > 0);
    if (valid.length === 0) return 0;
    const itemKeys = new Map<string, { sourceType: string; itemId: string }>();
    for (const c of valid) itemKeys.set(`${c.sourceType}:${c.itemId}`, { sourceType: c.sourceType, itemId: c.itemId });
    for (const { sourceType, itemId } of itemKeys.values()) {
      await this.q(`DELETE FROM memory_chunks WHERE tenant=$1 AND source_type=$2 AND item_id=$3`, [this.t, sourceType, itemId]);
    }
    for (const c of valid) {
      const resolved = !c.projectId && c.projectPath ? resolveProjectId(c.projectPath) : null;
      const projectId = c.projectId ?? (resolved && resolved.source !== 'ignored' ? resolved.id : '');
      await this.q(
        `INSERT INTO memory_chunks (tenant,chunk_id,item_id,source_type,title,text,chunk_type,project_path,project_id,file_path,mtime)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant,chunk_id) DO UPDATE SET text=excluded.text, title=excluded.title`,
        [this.t, c.chunkId, c.itemId, c.sourceType, c.title, applyChunkPrivacy(c.text), c.chunkType, c.projectPath, projectId, c.filePath, intMs(c.mtime)]);
    }
    return valid.length;
  }
  async listChunksByItem(sourceType: string, itemId: string): Promise<Array<{ chunk_id: string; title: string; text: string; chunk_type: string; mtime: number }>> {
    const rows = await this.q(
      `SELECT chunk_id, title, text, chunk_type, mtime FROM memory_chunks WHERE tenant=$1 AND source_type=$2 AND item_id=$3`,
      [this.t, sourceType, itemId]);
    const idx = (c: string) => { const m = /:(\d+)$/.exec(c); return m ? Number(m[1]) : 0; };
    rows.sort((a: any, b: any) => idx(a.chunk_id) - idx(b.chunk_id));
    return rows.map((r: any) => ({ chunk_id: r.chunk_id, title: r.title, text: r.text, chunk_type: r.chunk_type, mtime: Number(r.mtime) }));
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
  }
  async rebuildFTS(): Promise<void> { /* tsvector is a generated column — nothing to rebuild */ }
  async clearFTS(): Promise<void> { await this.q(`DELETE FROM memory_chunks WHERE tenant=$1`, [this.t]); }

  async searchFTS(query: string, options: Args<'searchFTS'>[1] = {}): Promise<MemorySearchResult[]> {
    const { topK = 20, sourceTypes, projectIdFilter } = options;
    const tsq = orPrefixTsQuery(query);
    if (!tsq) return [];
    const params: unknown[] = [this.t, tsq];
    let sql = `SELECT chunk_id, item_id, source_type, title, text, chunk_type, project_path, file_path, mtime,
                      ts_rank(tsv, to_tsquery('english',$2)) AS rank
               FROM memory_chunks WHERE tenant=$1 AND tsv @@ to_tsquery('english',$2)`;
    if (sourceTypes && sourceTypes.length > 0) { params.push(sourceTypes); sql += ` AND source_type = ANY($${params.length})`; }
    // `-p`/projectFilter is a cleartext PATH SUBSTRING (e.g. "inco-monorepo"),
    // not a resolved project_id — match it against project_path, case-insensitive.
    // Exact project_id match here meant a substring never matched and `-p`
    // silently returned nothing for every project.
    if (projectIdFilter) { params.push(`%${projectIdFilter}%`); sql += ` AND project_path ILIKE $${params.length}`; }
    params.push(topK * 5); sql += ` ORDER BY rank DESC LIMIT $${params.length}`;
    let rows: any[];
    try { rows = await this.q(sql, params); } catch { return []; }
    return groupChunks(rows, topK);
  }

  async getFTSCount(): Promise<number> {
    return (await this.one(`SELECT COUNT(*)::int AS count FROM memory_chunks WHERE tenant=$1`, [this.t])).count;
  }
  async countDistinctItemsMatching(query: string, options: Args<'countDistinctItemsMatching'>[1] = {}): Promise<number> {
    const tsq = orPrefixTsQuery(query);
    if (!tsq) return 0;
    const params: unknown[] = [this.t, tsq];
    let sql = `SELECT COUNT(DISTINCT item_id)::int AS n FROM memory_chunks WHERE tenant=$1 AND tsv @@ to_tsquery('english',$2)`;
    if (options.sourceTypes && options.sourceTypes.length > 0) { params.push(options.sourceTypes); sql += ` AND source_type = ANY($${params.length})`; }
    if (options.projectFilter) { params.push(`%${options.projectFilter}%`); sql += ` AND project_path LIKE $${params.length}`; }
    try { return (await this.one(sql, params))?.n ?? 0; } catch { return 0; }
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
    await run(`DELETE FROM content_cache WHERE tenant=$1 AND id=$2 AND source_type='session'`, [this.t, sessionId]);
    await run(`DELETE FROM raw_sessions WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId]);
    await run(`DELETE FROM secret_findings WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId]);
    await run(`DELETE FROM session_metadata WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId]);
    await run(`DELETE FROM compute_cache WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId]);
    await run(`DELETE FROM session_outcome_cache WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId]);
    await run(`DELETE FROM memory_links WHERE tenant=$1 AND ((source_type='session' AND source_id=$2) OR (target_type='session' AND target_id=$2))`, [this.t, sessionId]);
  }

  // ── raw session archive (shrink-protected — see memory-store.ts) ──
  async putRawSession(sessionId: string, tool: string, mtime: number, gz: Buffer, uncompressedSize: number): Promise<'stored' | 'shrink-protected' | 'unchanged'> {
    const existing = await this.one(`SELECT size, mtime FROM raw_sessions WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId]);
    if (existing) {
      if (Number(existing.size) === uncompressedSize && Number(existing.mtime) >= intMs(mtime)) return 'unchanged';
      if (uncompressedSize < Number(existing.size)) return 'shrink-protected';
    }
    await this.q(
      `INSERT INTO raw_sessions (tenant, session_id, tool, mtime, size, gz, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant, session_id) DO UPDATE SET
         tool=excluded.tool, mtime=excluded.mtime, size=excluded.size,
         gz=excluded.gz, captured_at=excluded.captured_at`,
      [this.t, sessionId, tool, intMs(mtime), uncompressedSize, gz, Date.now()]);
    return 'stored';
  }
  async getRawSession(sessionId: string): Promise<{ tool: string; mtime: number; size: number; gz: Buffer; captured_at: number } | null> {
    const r = await this.one(`SELECT tool, mtime, size, gz, captured_at FROM raw_sessions WHERE tenant=$1 AND session_id=$2`, [this.t, sessionId]);
    return r ? { tool: r.tool, mtime: Number(r.mtime), size: Number(r.size), gz: r.gz, captured_at: Number(r.captured_at) } : null;
  }
  async listRawSessionVersions(): Promise<Array<{ session_id: string; mtime: number; size: number }>> {
    const rows = await this.q(`SELECT session_id, mtime, size FROM raw_sessions WHERE tenant=$1`, [this.t]);
    return rows.map((r: any) => ({ session_id: r.session_id, mtime: Number(r.mtime), size: Number(r.size) }));
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

  async close(): Promise<void> { /* pooled connection is shared (pg-pool.ts) — closePgPools() ends it */ }
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
  return [...new Set(words)].slice(0, 24).map((w) => `${w}:*`).join(' | ');
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
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}
