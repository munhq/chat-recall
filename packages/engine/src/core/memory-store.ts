/**
 * SQLite storage for memory metadata and links.
 *
 * Adds memory_metadata and memory_links tables to the same SQLite db that
 * holds session_metadata — see `src/core/paths.ts` for the canonical
 * location (env-overridable).
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import { codeFindingId, codeHotspotId, codeActionId } from '../types/code-intel.js';
import type {
  CodeProjectInput, CodeProjectRow, CodeFindingInput, CodeFindingRow, CodeFindingsSummary,
  CodeHotspotInput, CodeHotspotRow, CodeActionInput, CodeActionRow, CodeHealth, CodeMap,
  CodeActionLoc, CodeSeverity, CodeProjectLabel, CodeActionStatus,
} from '../types/code-intel.js';

import type {
  SourceType,
  MemoryItem,
  MemoryLink,
  MemoryChunk,
  MemoryMetadataRow,
  MemoryLinkRow,
  MemorySearchResult,
} from '../types/memory.js';
import { getCacheDbPath } from './paths.js';
import { resolveProjectId } from './project-resolver.js';
import { METADATA_VERSION } from './model-pricing.js';
import { applyChunkPrivacy } from './secret-redactor.js';
import { SERVER_DETECTOR } from './secret-detectors.js';

/**
 * Redact known secret shapes + (optionally) hash absolute paths before
 * content lands in the derived index. Gated by `privacy.redactIndex`
 * and `privacy.redactFilePaths` from settings, with `CHAT_RECALL_REDACT_INDEX`
 * as the env-level escape hatch. The original session JSONL is owned by
 * the upstream tool (Claude Code, Codex, etc.) and is never touched.
 */
function applyRedactionIfEnabled(text: string): string {
  return applyChunkPrivacy(text);
}

export class MemoryStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath || getCacheDbPath();

    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path);
    this.initSchema();
  }

  private initSchema(): void {
    // One-shot migrations for retroactive columns. Wrapped in
    // try/catch because ALTER TABLE … ADD COLUMN throws when the
    // column already exists; cheaper than reading sqlite_master.
    this.ensureSecretFindingsTable();   // creates secret_findings (+verified, +unique idx) if absent
    try { this.db.exec(`ALTER TABLE memory_metadata ADD COLUMN project_id TEXT NOT NULL DEFAULT '';`); } catch { /* ok */ }
    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_project_id ON memory_metadata(project_id);`); } catch { /* ok */ }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_metadata (
        id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        title TEXT NOT NULL,
        project_path TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL DEFAULT '',
        content_preview TEXT NOT NULL DEFAULT '',
        file_path TEXT NOT NULL DEFAULT '',
        mtime INTEGER NOT NULL DEFAULT 0,
        indexed_at INTEGER NOT NULL,
        extra_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (id, source_type)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_source_type
        ON memory_metadata(source_type);
      CREATE INDEX IF NOT EXISTS idx_memory_project
        ON memory_metadata(project_path);
      CREATE INDEX IF NOT EXISTS idx_memory_project_id
        ON memory_metadata(project_id);
      CREATE INDEX IF NOT EXISTS idx_memory_mtime
        ON memory_metadata(mtime);

      CREATE TABLE IF NOT EXISTS memory_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        UNIQUE(source_type, source_id, target_type, target_id, link_type)
      );

      CREATE TABLE IF NOT EXISTS content_cache (
        id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        content_json TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        PRIMARY KEY (id, source_type)
      );

      -- Generic KV store for agent state. Sits alongside diary (narrative)
      -- and the knowledge graph (structured facts) — KV is the third
      -- primitive: small persistent values keyed by namespaced strings.
      -- Use cases: "current PR url", "branch I'm working on", user prefs.
      CREATE TABLE IF NOT EXISTS kv_store (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv_store(scope);

      -- Cross-tool sync intents (Model B queue). The UI (on any server, incl.
      -- SaaS) enqueues "copy artifact X from tool Y to tool Z" (or sync_all);
      -- the local CLI agent drains pending rows, does the filesystem copy on
      -- the user's machine, and acks status back here.
      CREATE TABLE IF NOT EXISTS sync_intents (
        id            TEXT PRIMARY KEY,
        device_id     TEXT,
        kind          TEXT NOT NULL,
        artifact_type TEXT,
        name          TEXT,
        from_tool     TEXT,
        to_tool       TEXT,
        status        TEXT NOT NULL DEFAULT 'pending',
        result        TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        created_by    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sync_intents_pending ON sync_intents(status, created_at);

      -- Code intelligence (codeindex merge). Mirrors the pg code_* tables.
      CREATE TABLE IF NOT EXISTS code_projects (
        project_id      TEXT PRIMARY KEY,
        root_path       TEXT NOT NULL DEFAULT '',
        file_count      INTEGER NOT NULL DEFAULT 0,
        symbol_count    INTEGER NOT NULL DEFAULT 0,
        langs_json      TEXT NOT NULL DEFAULT '{}',
        health_json     TEXT NOT NULL DEFAULT '{}',
        map_json        TEXT NOT NULL DEFAULT '{}',
        label           TEXT,
        indexed_by      TEXT,
        last_indexed_at INTEGER NOT NULL DEFAULT 0,
        collector_version INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS code_findings (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL,
        category      TEXT NOT NULL,
        severity      TEXT NOT NULL,
        file          TEXT NOT NULL DEFAULT '',
        line          INTEGER,
        rule          TEXT NOT NULL DEFAULT '',
        title         TEXT NOT NULL DEFAULT '',
        snippet       TEXT NOT NULL DEFAULT '',
        why           TEXT NOT NULL DEFAULT '',
        agent_prompt  TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'open',
        first_seen_at INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        extra_json    TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_code_findings_proj ON code_findings(project_id, severity);
      CREATE TABLE IF NOT EXISTS code_hotspots (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        file         TEXT NOT NULL DEFAULT '',
        churn        INTEGER NOT NULL DEFAULT 0,
        complexity   INTEGER NOT NULL DEFAULT 0,
        score        REAL NOT NULL DEFAULT 0,
        ai_authored  INTEGER NOT NULL DEFAULT 0,
        lines        INTEGER NOT NULL DEFAULT 0,
        suggestion   TEXT NOT NULL DEFAULT '',
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_code_hotspots_proj ON code_hotspots(project_id, score);
      CREATE TABLE IF NOT EXISTS code_actions (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        pri          INTEGER NOT NULL DEFAULT 0,
        category     TEXT NOT NULL DEFAULT '',
        title        TEXT NOT NULL DEFAULT '',
        fix          TEXT NOT NULL DEFAULT '',
        loc_json     TEXT NOT NULL DEFAULT '[]',
        agent_prompt TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'suggested',
        queued       INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_code_actions_proj ON code_actions(project_id, pri);

      CREATE INDEX IF NOT EXISTS idx_links_source
        ON memory_links(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_links_target
        ON memory_links(target_type, target_id);
      CREATE INDEX IF NOT EXISTS idx_links_type
        ON memory_links(link_type);

      -- FTS5 full-text search index for chunk text
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
        chunk_id,
        item_id,
        source_type,
        title,
        text,
        chunk_type,
        project_path,
        project_id,
        file_path,
        mtime UNINDEXED
      );
    `);

    // FTS5 doesn't support ALTER. If the existing virtual table predates
    // the project_id column (older deploys), drop + recreate. Empty until
    // the next reindex pass; FTS5 search transparently falls back to
    // empty matches rather than erroring. Auto-indexer will repopulate
    // on its next sweep.
    this.migrateFTSIfNeeded();
  }

  /**
   * One-shot migration: if `memory_chunks_fts` exists but lacks the
   * `project_id` column, drop the table and recreate with the current
   * schema. Idempotent — subsequent runs no-op once the column is present.
   */
  private migrateFTSIfNeeded(): void {
    try {
      const row = this.db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_chunks_fts'`
      ).get() as { sql?: string } | undefined;
      const hasProjectId = !!row?.sql && /\bproject_id\b/.test(row.sql);
      if (hasProjectId) return;

      this.db.exec(`
        DROP TABLE IF EXISTS memory_chunks_fts;
        CREATE VIRTUAL TABLE memory_chunks_fts USING fts5(
          chunk_id,
          item_id,
          source_type,
          title,
          text,
          chunk_type,
          project_path,
          project_id,
          file_path,
          mtime UNINDEXED
        );
      `);
    } catch {
      // Migration is best-effort; failures don't block the store.
    }
  }

  /** Upsert a memory item's metadata */
  setItem(item: MemoryItem): void {
    // When a session is re-indexed, clear cached summary — the content may have
    // changed (e.g., session resumed and migrated to new subagent format).
    // setItem is only called when the indexer decides the item needs updating,
    // so unconditional clear here is safe.
    if (item.sourceType === 'session') {
      // session_metadata is owned by MetadataCache (same db file, separate
      // schema init) — on a virgin db it doesn't exist yet, and a missing
      // table just means there's no stale summary to clear.
      try { this.db.prepare('DELETE FROM session_metadata WHERE session_id = ?').run(item.id); }
      catch { /* table not created yet */ }
    }

    // Resolve project_id from the path. Pure + cached in the resolver, so
    // this stays cheap even on bulk writes. `ignored` short-circuits to
    // empty so dossier queries naturally skip these rows.
    const resolved = !item.projectId && item.projectPath ? resolveProjectId(item.projectPath) : null;
    const projectId = item.projectId ?? (resolved && resolved.source !== 'ignored' ? resolved.id : '');

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_metadata
      (id, source_type, title, project_path, project_id, content_preview, file_path, mtime, indexed_at, extra_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      item.id,
      item.sourceType,
      item.title,
      item.projectPath,
      projectId,
      item.contentPreview || '',
      item.filePath,
      item.mtime,
      Date.now(),
      JSON.stringify(item.extra || {})
    );
  }

  /** Bulk upsert. Local sqlite loops (cheap, in-process); PgStore overrides
   *  with one multi-row INSERT in a single transaction. */
  setItems(items: MemoryItem[]): void {
    for (const it of items) this.setItem(it);
  }

  /** Get a memory item by ID and source type */
  getItem(id: string, sourceType: SourceType): MemoryMetadataRow | null {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_metadata
      WHERE id = ? AND source_type = ?
    `);
    return (stmt.get(id, sourceType) as MemoryMetadataRow) || null;
  }

  /**
   * Check if an item needs re-indexing.
   *
   * Two triggers:
   *  1. mtime newer than the stored row (the original trigger).
   *  2. `extra.metadataVersion` < `METADATA_VERSION` — bumped when the
   *     parser learns to extract a new field (e.g. `costUsd`). Without
   *     this the auto-indexer would never re-parse rows that haven't
   *     been touched on disk, even after a parser upgrade.
   *
   * Cheap: a single SELECT * + JSON.parse of `extra_json`. Bulk index
   * runs aggregate this anyway, so the per-item cost stays in µs.
   */
  needsUpdate(id: string, sourceType: SourceType, currentMtime: number): boolean {
    const existing = this.getItem(id, sourceType);
    if (!existing) return true;
    if (existing.mtime < currentMtime) return true;
    try {
      const extra = JSON.parse(existing.extra_json || '{}') as { metadataVersion?: number };
      const stored = typeof extra.metadataVersion === 'number' ? extra.metadataVersion : 0;
      if (stored < METADATA_VERSION) return true;
    } catch { /* unparseable extra → treat as needs-update */ return true; }
    return false;
  }

  /** Add a link between two memory items */
  addLink(link: MemoryLink): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_links
      (source_type, source_id, target_type, target_id, link_type, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      link.sourceType,
      link.sourceId,
      link.targetType,
      link.targetId,
      link.linkType,
      link.confidence,
      Date.now()
    );
  }

  /** Add multiple links in a transaction */
  addLinks(links: MemoryLink[]): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO memory_links
      (source_type, source_id, target_type, target_id, link_type, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((links: MemoryLink[]) => {
      const now = Date.now();
      for (const link of links) {
        insert.run(
          link.sourceType,
          link.sourceId,
          link.targetType,
          link.targetId,
          link.linkType,
          link.confidence,
          now
        );
      }
    });

    transaction(links);
  }

  /** Get all links FROM a given item */
  getLinksFrom(sourceType: SourceType, sourceId: string): MemoryLinkRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_links
      WHERE source_type = ? AND source_id = ?
    `);
    return stmt.all(sourceType, sourceId) as MemoryLinkRow[];
  }

  /** Get all links TO a given item */
  getLinksTo(targetType: SourceType, targetId: string): MemoryLinkRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_links
      WHERE target_type = ? AND target_id = ?
    `);
    return stmt.all(targetType, targetId) as MemoryLinkRow[];
  }

  /** Get all links involving a given item (both directions) */
  getAllLinks(sourceType: SourceType, itemId: string): MemoryLinkRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_links
      WHERE (source_type = ? AND source_id = ?)
         OR (target_type = ? AND target_id = ?)
    `);
    return stmt.all(sourceType, itemId, sourceType, itemId) as MemoryLinkRow[];
  }

  /** List items by source type filtered by project path (exact or prefix match) */
  listItemsByProject(sourceType: SourceType, projectPath: string, limit = 10): MemoryMetadataRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory_metadata
      WHERE source_type = ? AND (project_path = ? OR project_path LIKE ?)
      ORDER BY mtime DESC
      LIMIT ?
    `);
    return stmt.all(sourceType, projectPath, `${projectPath}%`, limit) as MemoryMetadataRow[];
  }

  /**
   * List items belonging to a resolved logical project_id. Use this for
   * dossier queries and any UI that groups by the user-stable identity
   * (git:owner/repo, ws:name, …) rather than the raw filesystem path.
   *
   * Pass `sourceType=null` to span all source types.
   * `limit=0` returns every match.
   */
  listItemsByProjectId(
    sourceType: SourceType | null,
    projectId: string,
    limit = 50,
  ): MemoryMetadataRow[] {
    const where = sourceType ? `source_type = ? AND project_id = ?` : `project_id = ?`;
    const params: unknown[] = sourceType ? [sourceType, projectId] : [projectId];
    const limitSql = limit > 0 ? ` LIMIT ?` : '';
    if (limit > 0) params.push(limit);
    return this.db
      .prepare(`SELECT * FROM memory_metadata WHERE ${where} ORDER BY mtime DESC${limitSql}`)
      .all(...params) as MemoryMetadataRow[];
  }

  /**
   * Map of project_id → one representative project_path. Used by the
   * /api/projects/tree endpoint to detect orphan rows (paths no longer
   * on disk) and to back-derive workspace roots from auto-workspaces.
   * Picks the most-recent row per project_id.
   */
  listAllProjectIdPaths(): Array<{ project_id: string; project_path: string }> {
    return this.db.prepare(
      `SELECT project_id, project_path
       FROM memory_metadata
       WHERE project_id <> '' AND project_path <> ''
       GROUP BY project_id
       HAVING mtime = MAX(mtime)`,
    ).all() as Array<{ project_id: string; project_path: string }>;
  }

  /** All distinct project_ids with item counts and last-activity mtime. */
  listProjectsSummary(): Array<{ project_id: string; items: number; last_mtime: number }> {
    return this.db.prepare(
      `SELECT project_id,
              COUNT(*) AS items,
              MAX(mtime) AS last_mtime
       FROM memory_metadata
       WHERE project_id <> ''
       GROUP BY project_id
       ORDER BY last_mtime DESC`,
    ).all() as Array<{ project_id: string; items: number; last_mtime: number }>;
  }

  /**
   * List all sessions across every tool, sorted newest-first. Returns
   * just (id, mtime, tool) — small enough that "give me everything"
   * is fine even on a 10k-session install. Used by the precompute
   * worker to find sessions missing cached compute results.
   */
  listAllSessionsForPrecompute(): Array<{ id: string; mtime: number; tool: string }> {
    const rows = this.db.prepare(`
      SELECT id, mtime, json_extract(extra_json, '$.tool') as tool
      FROM memory_metadata
      WHERE source_type = 'session'
      ORDER BY mtime DESC
    `).all() as Array<{ id: string; mtime: number; tool: string | null }>;
    return rows.map(r => ({ id: r.id, mtime: r.mtime || 0, tool: r.tool || 'claude' }));
  }

  /** List all items of a given source type */
  /**
   * Lightweight (id → project_path) map for all sessions. Used to
   * overlay correct project paths onto live-scan results whose Claude
   * scanner produces a mangled path (chat-recall → chat/recall) by
   * replacing hyphens in the encoded directory name.
   */
  listAllSessionProjectPaths(): Array<{ id: string; project_path: string }> {
    return this.db
      .prepare(`SELECT id, project_path FROM memory_metadata WHERE source_type='session' AND project_path IS NOT NULL AND project_path <> ''`)
      .all() as Array<{ id: string; project_path: string }>;
  }

  /**
   * Secret-finding queries. Read-only views of the `secret_findings`
   * table populated by the secrets scanner. Findings carry redacted
   * previews only — the raw secret is never stored.
   */
  secretFindingsSummary(): {
    totals: Array<{ detector: string; findings: number; sessions: number }>;
    topRules: Array<{ detector: string; rule: string; n: number }>;
    sessionsWithFindings: number;
  } {
    const totals = this.db
      .prepare(`SELECT detector, COUNT(*) AS findings, COUNT(DISTINCT session_id) AS sessions
                FROM secret_findings GROUP BY detector ORDER BY detector`)
      .all() as Array<{ detector: string; findings: number; sessions: number }>;
    const topRules = this.db
      .prepare(`SELECT detector, rule, COUNT(*) AS n FROM secret_findings
                GROUP BY detector, rule ORDER BY n DESC LIMIT 30`)
      .all() as Array<{ detector: string; rule: string; n: number }>;
    const sessionsWithFindings = (this.db
      .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM secret_findings`)
      .get() as { n: number }).n;
    return { totals, topRules, sessionsWithFindings };
  }

  secretFindingsBySession(): Array<{ session_id: string; detector: string; n: number; project_path: string; title: string; mtime: number }> {
    return this.db
      .prepare(`
        SELECT sf.session_id, sf.detector, COUNT(*) AS n,
               m.project_path, m.title, m.mtime
        FROM secret_findings sf
        LEFT JOIN memory_metadata m ON m.id = sf.session_id AND m.source_type = 'session'
        GROUP BY sf.session_id, sf.detector
      `).all() as Array<{ session_id: string; detector: string; n: number; project_path: string; title: string; mtime: number }>;
  }

  /**
   * Per-project (repo) rollup — which repos leaked the most and how many
   * leaks are live. `verified` counts DISTINCT secrets confirmed live by the
   * scanner (`--only-verified`). Drives the Security dashboard's repo breakdown.
   */
  secretFindingsByProject(): Array<{
    project_path: string; occurrences: number; distinctSecrets: number;
    verified: number; sessions: number; lastSeen: number;
  }> {
    return this.db.prepare(`
      SELECT COALESCE(NULLIF(m.project_path, ''), '(unknown)') AS project_path,
             COUNT(*) AS occurrences,
             COUNT(DISTINCT sf.preview) AS distinctSecrets,
             COUNT(DISTINCT CASE WHEN sf.verified = 1 THEN sf.preview END) AS verified,
             COUNT(DISTINCT sf.session_id) AS sessions,
             MAX(sf.scanned_at) AS lastSeen
      FROM secret_findings sf
      LEFT JOIN memory_metadata m ON m.id = sf.session_id AND m.source_type = 'session'
      GROUP BY project_path
      ORDER BY verified DESC, distinctSecrets DESC
    `).all() as Array<{
      project_path: string; occurrences: number; distinctSecrets: number;
      verified: number; sessions: number; lastSeen: number;
    }>;
  }

  /**
   * Daily trend over the last `days` days: distinct secrets seen and how many
   * were verified-live, bucketed by `scanned_at` (ms epoch) in local time.
   * Powers the "are leaks trending down?" chart.
   */
  secretFindingsTrend(days = 30): Array<{ day: string; distinctSecrets: number; verified: number; occurrences: number }> {
    const sinceMs = Date.now() - days * 86_400_000;
    return this.db.prepare(`
      SELECT date(sf.scanned_at / 1000, 'unixepoch', 'localtime') AS day,
             COUNT(*) AS occurrences,
             COUNT(DISTINCT sf.preview) AS distinctSecrets,
             COUNT(DISTINCT CASE WHEN sf.verified = 1 THEN sf.preview END) AS verified
      FROM secret_findings sf
      WHERE sf.scanned_at >= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(sinceMs) as Array<{ day: string; distinctSecrets: number; verified: number; occurrences: number }>;
  }

  /**
   * Per-rule rollup. For each (detector, rule) pair returns:
   *   - occurrences: total findings (every match, repeated lines etc)
   *   - distinctSecrets: COUNT(DISTINCT preview) — how many UNIQUE
   *     keys were leaked under this rule (the redacted tails differ
   *     iff the underlying secrets differ, since preview = last 4 chars)
   *   - sessions: distinct sessions
   *   - sampleSessions: 3 example session ids
   *   - samplePreviews: 5 example masked tails
   *
   * Drives the "what was actually leaked" view: surfaces 4 unique AWS
   * keys vs 33 occurrences of those same 4 keys repeated.
   */
  secretFindingsByRule(): Array<{
    detector: string; rule: string;
    occurrences: number; distinctSecrets: number; sessions: number;
    sampleSessions: string[]; samplePreviews: string[];
  }> {
    const rules = this.db
      .prepare(`SELECT detector, rule,
                       COUNT(*) AS occurrences,
                       COUNT(DISTINCT preview) AS distinctSecrets,
                       COUNT(DISTINCT session_id) AS sessions
                FROM secret_findings
                GROUP BY detector, rule
                ORDER BY distinctSecrets DESC, occurrences DESC`)
      .all() as Array<{ detector: string; rule: string; occurrences: number; distinctSecrets: number; sessions: number }>;

    const sampleSess = this.db.prepare(`
      SELECT DISTINCT session_id FROM secret_findings
      WHERE detector = ? AND rule = ? LIMIT 3
    `);
    const samplePrev = this.db.prepare(`
      SELECT DISTINCT preview FROM secret_findings
      WHERE detector = ? AND rule = ? LIMIT 5
    `);

    return rules.map(r => ({
      ...r,
      sampleSessions: sampleSess.all(r.detector, r.rule).map((x: any) => x.session_id),
      samplePreviews: samplePrev.all(r.detector, r.rule).map((x: any) => x.preview),
    }));
  }

  /**
   * Per-distinct-secret rollup. The actionable view: each row is ONE
   * leaked credential (identified by its redacted tail), with every
   * session+line where it appears, plus first/last seen times. This
   * is what a security reviewer wants — "rotate THIS key, here's
   * everywhere it leaked."
   *
   * Same secret seen by multiple detectors collapses into one row
   * with `detectors: ['gitleaks','trufflehog']` (cross-detector
   * agreement = high confidence).
   *
   * `preview` is the canonical key for distinct-ness; raw secrets
   * never leave the database.
   */
  secretFindingsByDistinctSecret(): Array<{
    preview: string;
    rules: Array<{ detector: string; rule: string }>;
    detectors: string[];
    sessions: Array<{ sessionId: string; project: string; lines: number[] }>;
    sessionCount: number;
    occurrences: number;
    firstSeen: number;
    lastSeen: number;
    verified: boolean | null;
  }> {
    // `verified` column was added retroactively — older rows may not
    // have it. The COALESCE keeps the query stable across schemas.
    const rows = this.db.prepare(`
      SELECT sf.preview, sf.detector, sf.rule, sf.session_id, sf.line, sf.scanned_at,
             COALESCE(sf.verified, NULL) AS verified,
             m.project_path
      FROM secret_findings sf
      LEFT JOIN memory_metadata m ON m.id = sf.session_id AND m.source_type='session'
      WHERE sf.preview IS NOT NULL AND sf.preview <> ''
    `).all() as Array<{ preview: string; detector: string; rule: string; session_id: string; line: number; scanned_at: number; verified: number | null; project_path: string }>;

    type Acc = {
      preview: string;
      rulePairs: Set<string>;          // "detector:rule"
      detectors: Set<string>;
      sessions: Map<string, { project: string; lines: Set<number> }>;
      occurrences: number;
      firstSeen: number;
      lastSeen: number;
      verifiedFlags: Set<number>;
    };
    const map = new Map<string, Acc>();
    for (const r of rows) {
      let entry = map.get(r.preview);
      if (!entry) {
        entry = {
          preview: r.preview,
          rulePairs: new Set(),
          detectors: new Set(),
          sessions: new Map(),
          occurrences: 0,
          firstSeen: r.scanned_at,
          lastSeen: r.scanned_at,
          verifiedFlags: new Set(),
        };
        map.set(r.preview, entry);
      }
      entry.rulePairs.add(`${r.detector}:${r.rule}`);
      entry.detectors.add(r.detector);
      let sess = entry.sessions.get(r.session_id);
      if (!sess) {
        sess = { project: r.project_path || '', lines: new Set() };
        entry.sessions.set(r.session_id, sess);
      }
      sess.lines.add(r.line);
      entry.occurrences++;
      if (r.scanned_at < entry.firstSeen) entry.firstSeen = r.scanned_at;
      if (r.scanned_at > entry.lastSeen) entry.lastSeen = r.scanned_at;
      if (r.verified !== null && r.verified !== undefined) entry.verifiedFlags.add(r.verified);
    }

    return [...map.values()].map(e => {
      // verified=true if ANY scan returned verified-live for this
      // preview. verified=false ONLY if every scan saw it but none
      // could verify (rare). null when no verification was attempted.
      let verified: boolean | null = null;
      if (e.verifiedFlags.has(1)) verified = true;
      else if (e.verifiedFlags.has(0)) verified = false;
      return {
        preview: e.preview,
        rules: [...e.rulePairs].map(rp => {
          const [detector, rule] = rp.split(':');
          return { detector, rule };
        }),
        detectors: [...e.detectors].sort(),
        sessions: [...e.sessions.entries()].map(([sessionId, v]) => ({
          sessionId,
          project: v.project,
          lines: [...v.lines].sort((a, b) => a - b),
        })),
        sessionCount: e.sessions.size,
        occurrences: e.occurrences,
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
        verified,
      };
    });
  }

  /**
   * Dismissals — when a user marks a finding as rotated / false-
   * positive / generally not-actionable. Keyed by the redacted
   * preview (the only shared identifier for "the same secret"
   * across sessions). Dismissed entries are filtered out of the
   * Action Required UI.
   *
   * Status semantics:
   *   - `rotated`         — secret has been rotated; no longer a leak
   *   - `false_positive`  — never was a real secret (FP)
   *   - `dismissed`       — user-acknowledged, leave alone
   */
  /**
   * User-configurable secret rules. Layered on TOP of the built-in
   * gitleaks/trufflehog/secretlint rules, never replacing them.
   * Users describe their own secret formats here (internal API key
   * shapes, custom token prefixes, hostnames they don't want pasted
   * into AI sessions).
   *
   * `severity` informs the Action Required UI tier; the scanner
   * doesn't enforce it, just stores for display. The `enabled` flag
   * makes it cheap to A/B a rule without deleting it.
   *
   * Multi-tenant note: schema is tenant-ready (tenant_id column)
   * even though current single-user setup uses a fixed
   * 'default-tenant' value. When tenancy lands, no migration
   * needed — just set tenant_id from the auth context.
   */
  /**
   * Create the `secret_findings` table (+ indexes). Idempotent. Owned here
   * (not in secret-scanner) so both the scanner writer and the dashboard
   * readers go through the same StorageDriver — required for the
   * sqlite|postgres flag. The verified column + unique index are added
   * best-effort for legacy tables.
   */
  ensureSecretFindingsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secret_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        detector TEXT NOT NULL,
        rule TEXT NOT NULL,
        line INTEGER,
        preview TEXT,
        scanned_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_secret_findings_session ON secret_findings(session_id);
      CREATE INDEX IF NOT EXISTS idx_secret_findings_detector ON secret_findings(detector);
      CREATE INDEX IF NOT EXISTS idx_secret_findings_rule ON secret_findings(rule);
    `);
    try { this.db.exec(`ALTER TABLE secret_findings ADD COLUMN verified INTEGER DEFAULT NULL;`); } catch { /* exists */ }
    try {
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_secret_findings_unique
                    ON secret_findings(session_id, detector, rule, line);`);
    } catch { /* legacy duplicates; UI dedupes at render */ }
  }

  /**
   * Replace a session's CLIENT-REPORTED findings (delete-then-insert in one tx).
   * The scanner calls this after each scan; the (session,detector,rule,line)
   * unique index makes re-inserts idempotent. Returns the count written.
   *
   * Rows with detector='server' are left alone: those come from the server's own
   * pass over already-stored text (see addSecretFindings) and are not the
   * client's to retract. Without this scope, every sync from a client whose
   * rules are older than the server's would silently erase the very findings
   * that exist BECAUSE that client's rules are old.
   */
  replaceSecretFindings(
    sessionId: string,
    findings: Array<{ detector: string; rule: string; line: number; preview: string; verified?: boolean }>,
  ): { written: number } {
    this.ensureSecretFindingsTable();
    const run = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM secret_findings WHERE session_id = ? AND detector <> '${SERVER_DETECTOR}'`).run(sessionId);
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO secret_findings
         (session_id, detector, rule, line, preview, scanned_at, verified)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = Date.now();
      let n = 0;
      for (const f of findings) {
        stmt.run(
          sessionId, f.detector, f.rule, f.line, f.preview, now,
          f.verified === true ? 1 : f.verified === false ? 0 : null,
        );
        n++;
      }
      return n;
    });
    return { written: run() };
  }

  /**
   * INSERT-ONLY companion to replaceSecretFindings, for the server's own re-scan
   * of text it already holds. Nothing is deleted: these findings exist precisely
   * because the client that shipped the session could not produce them, so they
   * must survive that client's next sync. Duplicate (session,detector,rule,line)
   * rows are ignored, making re-runs idempotent.
   */
  addSecretFindings(
    sessionId: string,
    findings: Array<{ detector: string; rule: string; line: number; preview: string; verified?: boolean }>,
  ): { written: number } {
    this.ensureSecretFindingsTable();
    const run = this.db.transaction(() => {
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO secret_findings
         (session_id, detector, rule, line, preview, scanned_at, verified)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = Date.now();
      let n = 0;
      for (const f of findings) {
        const r = stmt.run(
          sessionId, f.detector, f.rule, f.line, f.preview, now,
          f.verified === true ? 1 : f.verified === false ? 0 : null,
        );
        n += r.changes;
      }
      return n;
    });
    return { written: run() };
  }

  ensureSecretRulesTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secret_rules (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id    TEXT NOT NULL DEFAULT 'default',
        name         TEXT NOT NULL,
        regex        TEXT NOT NULL,
        severity     TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
        description  TEXT,
        enabled      INTEGER NOT NULL DEFAULT 1,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        UNIQUE(tenant_id, name)
      );
    `);
    // `redact` promotes a rule from report-only to REDACTING on the client.
    // Added best-effort for tables created before the column existed.
    try { this.db.exec(`ALTER TABLE secret_rules ADD COLUMN redact INTEGER NOT NULL DEFAULT 0;`); } catch { /* exists */ }
  }
  listSecretRules(tenantId = 'default'): Array<{ id: number; tenant_id: string; name: string; regex: string; severity: string; description: string | null; enabled: number; redact: number; created_at: number; updated_at: number }> {
    this.ensureSecretRulesTable();
    return this.db.prepare(`SELECT * FROM secret_rules WHERE tenant_id = ? ORDER BY name`).all(tenantId) as any;
  }
  upsertSecretRule(rule: { id?: number; tenant_id?: string; name: string; regex: string; severity: string; description?: string; enabled?: boolean; redact?: boolean }): { id: number } {
    this.ensureSecretRulesTable();
    const tenant = rule.tenant_id || 'default';
    const enabled = rule.enabled === false ? 0 : 1;
    const redact = rule.redact === true ? 1 : 0;
    const now = Date.now();
    if (rule.id) {
      this.db.prepare(`
        UPDATE secret_rules
           SET name = ?, regex = ?, severity = ?, description = ?, enabled = ?, redact = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?
      `).run(rule.name, rule.regex, rule.severity, rule.description || null, enabled, redact, now, rule.id, tenant);
      return { id: rule.id };
    }
    const result = this.db.prepare(`
      INSERT INTO secret_rules (tenant_id, name, regex, severity, description, enabled, redact, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, name) DO UPDATE SET
        regex = excluded.regex,
        severity = excluded.severity,
        description = excluded.description,
        enabled = excluded.enabled,
        redact = excluded.redact,
        updated_at = excluded.updated_at
    `).run(tenant, rule.name, rule.regex, rule.severity, rule.description || null, enabled, redact, now, now);
    return { id: Number(result.lastInsertRowid) };
  }
  deleteSecretRule(id: number, tenantId = 'default'): void {
    this.ensureSecretRulesTable();
    this.db.prepare('DELETE FROM secret_rules WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  }

  ensureSecretDismissalsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secret_dismissals (
        preview     TEXT PRIMARY KEY,
        status      TEXT NOT NULL CHECK (status IN ('rotated', 'false_positive', 'dismissed')),
        reason      TEXT,
        dismissed_at INTEGER NOT NULL
      );
    `);
  }
  setSecretDismissal(preview: string, status: 'rotated' | 'false_positive' | 'dismissed', reason?: string): void {
    this.ensureSecretDismissalsTable();
    this.db.prepare(`
      INSERT INTO secret_dismissals (preview, status, reason, dismissed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(preview) DO UPDATE SET
        status = excluded.status,
        reason = excluded.reason,
        dismissed_at = excluded.dismissed_at
    `).run(preview, status, reason || null, Date.now());
  }
  clearSecretDismissal(preview: string): void {
    this.ensureSecretDismissalsTable();
    this.db.prepare('DELETE FROM secret_dismissals WHERE preview = ?').run(preview);
  }
  getSecretDismissals(): Map<string, { status: string; reason: string | null; dismissed_at: number }> {
    this.ensureSecretDismissalsTable();
    const out = new Map<string, { status: string; reason: string | null; dismissed_at: number }>();
    for (const r of this.db.prepare('SELECT preview, status, reason, dismissed_at FROM secret_dismissals').all() as any[]) {
      out.set(r.preview, { status: r.status, reason: r.reason, dismissed_at: r.dismissed_at });
    }
    return out;
  }

  /**
   * For a given preview (redacted key), how many OTHER sessions also
   * contain it. The blast-radius signal: if the same key is in 116
   * sessions, sharing any of them leaks the key. Lookup is O(1) via
   * the session_id index on secret_findings.
   */
  secretCrossSessionCount(preview: string, excludeSessionId: string): number {
    return (this.db
      .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM secret_findings
                WHERE preview = ? AND session_id <> ?`)
      .get(preview, excludeSessionId) as { n: number }).n;
  }

  secretFindingsForSession(sessionId: string): Array<{ detector: string; rule: string; line: number; preview: string; scanned_at: number }> {
    return this.db
      .prepare(`SELECT detector, rule, line, preview, scanned_at
                FROM secret_findings WHERE session_id = ?
                ORDER BY detector, line`)
      .all(sessionId) as Array<{ detector: string; rule: string; line: number; preview: string; scanned_at: number }>;
  }

  /**
   * Sessions whose file mtime is at-or-after `sinceMs`. Used by the
   * Activity timeline to limit cache scans to the relevant window.
   */
  listSessionsModifiedSince(sinceMs: number, projectIdFilter?: string): Array<{ id: string; mtime: number; project_path: string; project_id: string }> {
    let sql = `SELECT id, mtime, project_path, project_id FROM memory_metadata WHERE source_type='session' AND mtime >= ?`;
    const params: unknown[] = [sinceMs];
    if (projectIdFilter) {
      // Match querySessionIndex: typed scheme id / privacy hash → exact
      // project_id; bare term → substring across path + id.
      const f = projectIdFilter;
      if (f.includes(':') || /^p_/.test(f)) {
        sql += ` AND project_id = ?`; params.push(f);
      } else {
        sql += ` AND (project_path LIKE ? OR project_id LIKE ?)`; params.push(`%${f}%`, `%${f}%`);
      }
    }
    return this.db
      .prepare(sql + ` ORDER BY mtime DESC`)
      .all(...params) as Array<{ id: string; mtime: number; project_path: string; project_id: string }>;
  }

  /**
   * Lightweight (id → file_path) map for all sessions. Used by the web
   * server's badge/diff/outcome endpoints in place of a filesystem walk.
   * Single SQL query, only the two columns we actually need.
   */
  listAllSessionPaths(): Array<{ id: string; file_path: string }> {
    return this.db
      .prepare(`SELECT id, file_path FROM memory_metadata WHERE source_type='session' AND file_path IS NOT NULL AND file_path <> ''`)
      .all() as Array<{ id: string; file_path: string }>;
  }

  /** `sinceMs` is the recency floor (mtime >= sinceMs) the free tier's list
   *  window applies; undefined = unwindowed (paid/self-host, unchanged). */
  listItems(sourceType: SourceType, limit = 100, offset = 0, sinceMs?: number): MemoryMetadataRow[] {
    const since = sinceMs && Number.isFinite(sinceMs) ? sinceMs : undefined;
    const stmt = this.db.prepare(`
      SELECT * FROM memory_metadata
      WHERE source_type = ?${since !== undefined ? ' AND mtime >= ?' : ''}
      ORDER BY mtime DESC
      LIMIT ? OFFSET ?
    `);
    const params: (string | number)[] = since !== undefined
      ? [sourceType, since, limit, offset]
      : [sourceType, limit, offset];
    return stmt.all(...params) as MemoryMetadataRow[];
  }

  /**
   * Sorted/paginated/filtered query over indexed sessions, returning the
   * page rows + total-after-filtering in two SQL statements (no JS sort,
   * no JS slice). Backed by `idx_memory_mtime` so even on a 10k-session
   * install the query is single-digit milliseconds.
   *
   * Tool filter uses `json_extract` on the `extra_json` column. SQLite
   * indexes don't help json_extract directly, but the upstream
   * `source_type='session'` predicate already narrows to the session
   * subset, so the per-row JSON parse cost is bounded.
   *
   * `projectFilter` is a path PREFIX match (so a folder click in the
   * sidebar pulls all descendant sessions). Empty string returns all.
   *
   * Returns `null` when the store is empty so callers can fall back to
   * the filesystem walk during a fresh install before the indexer has
   * populated anything.
   */
  querySessionIndex(opts: {
    limit: number;
    offset: number;
    /** Logical project_id (e.g. `git:github.com/me/repo`, `ws:personal`). */
    projectIdFilter?: string;
    toolFilter?: string;
    sinceMs?: number;
    /**
     * Include "untracked" sessions whose project_id is empty or starts
     * with `path:` (PR-bot worktrees, /tmp scratch, sessions launched
     * outside any tracked repo). Off by default so the unfiltered feed
     * surfaces real-repo work instead of being drowned by templated
     * bot sessions. Turning this on (via the UI or a deep link) is the
     * way to inspect untracked locations explicitly.
     */
    includeUntracked?: boolean;
  }): { rows: MemoryMetadataRow[]; total: number } {
    const where: string[] = ["source_type = 'session'"];
    const params: (string | number)[] = [];

    if (opts.projectIdFilter) {
      // Typed logical id (sidebar: `path:`/`git:`/`ws:`/`untracked:` or a `p_…`
      // privacy hash) → exact match. Bare human term (CLI/MCP: `chat-recall`,
      // `acme`) → substring against project_path AND project_id. Exact match on
      // a bare term matched nothing, leaving `recall_recent`'s project filter
      // silently empty. Mirror the pg store + search `-p` behaviour.
      const f = opts.projectIdFilter;
      if (f.includes(':') || /^p_/.test(f)) {
        where.push('project_id = ?');
        params.push(f);
      } else {
        where.push('(project_path LIKE ? OR project_id LIKE ?)');
        params.push(`%${f}%`, `%${f}%`);
      }
    } else if (!opts.includeUntracked) {
      // Default: hide only the genuine noise buckets — PR-bot worktrees and
      // /tmp scratch. Real local projects resolve to `path:<dir>` whenever git
      // metadata isn't available (e.g. the repo isn't mounted, as in the
      // Docker image), so blanket-hiding `path:%` would bury the user's actual
      // work. Keep those visible; only the known-templated/scratch paths are
      // hidden. Users can still see everything via `?include_untracked=1`.
      where.push(
        "project_id NOT LIKE 'path:%.claude-pr-bot' " +
        "AND project_id NOT LIKE 'path:%/.claude-pr-bot/%' " +
        "AND project_id NOT LIKE 'path:/tmp/%' " +
        "AND project_id NOT LIKE 'path:/var/tmp/%'"
      );
    }
    if (opts.toolFilter) {
      // Default tool when extra_json doesn't carry one is 'claude' — match
      // both the explicit-tool case and the implicit-claude case.
      if (opts.toolFilter === 'claude') {
        where.push("(json_extract(extra_json, '$.tool') IS NULL OR json_extract(extra_json, '$.tool') = 'claude')");
      } else {
        where.push("json_extract(extra_json, '$.tool') = ?");
        params.push(opts.toolFilter);
      }
    }
    if (opts.sinceMs && Number.isFinite(opts.sinceMs)) {
      where.push('mtime >= ?');
      params.push(opts.sinceMs);
    }

    const whereSQL = where.join(' AND ');

    const total = (this.db.prepare(
      `SELECT COUNT(*) as n FROM memory_metadata WHERE ${whereSQL}`
    ).get(...params) as { n: number }).n;

    const rows = this.db.prepare(
      `SELECT * FROM memory_metadata WHERE ${whereSQL} ORDER BY mtime DESC LIMIT ? OFFSET ?`
    ).all(...params, opts.limit, opts.offset) as MemoryMetadataRow[];

    return { rows, total };
  }

  /** Get counts by source type */
  getStats(): Record<SourceType | string, number> {
    const rows = this.db.prepare(`
      SELECT source_type, COUNT(*) as count
      FROM memory_metadata
      GROUP BY source_type
    `).all() as Array<{ source_type: string; count: number }>;

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.source_type] = row.count;
    }
    return result;
  }

  /** Get total link count */
  getLinkCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM memory_links
    `).get() as { count: number };
    return row.count;
  }

  /** Delete all items and links for a source type */
  clearSourceType(sourceType: SourceType): void {
    this.db.prepare('DELETE FROM memory_metadata WHERE source_type = ?').run(sourceType);
    this.db.prepare('DELETE FROM memory_links WHERE source_type = ? OR target_type = ?').run(sourceType, sourceType);
  }

  /** Delete a specific item and its links */
  deleteItem(id: string, sourceType: SourceType): void {
    this.db.prepare(`
      DELETE FROM memory_metadata WHERE id = ? AND source_type = ?
    `).run(id, sourceType);

    this.db.prepare(`
      DELETE FROM memory_links
      WHERE (source_type = ? AND source_id = ?)
         OR (target_type = ? AND target_id = ?)
    `).run(sourceType, id, sourceType, id);

    // Invalidate cached summary so stale content doesn't survive a session resume/rewrite
    if (sourceType === 'session') {
      // Owned by MetadataCache — may not exist on a virgin db (see setItem).
      try { this.db.prepare(`DELETE FROM session_metadata WHERE session_id = ?`).run(id); }
      catch { /* table not created yet */ }
    }
  }

  /** Update project path for an item */
  updateItemProjectPath(id: string, sourceType: SourceType, projectPath: string): boolean {
    const result = this.db.prepare(`
      UPDATE memory_metadata
      SET project_path = ?
      WHERE id = ? AND source_type = ?
    `).run(projectPath, id, sourceType);

    return result.changes > 0;
  }

  /** Get cached parsed content */
  getCachedContent(id: string, sourceType: string, mtime: number): string | null {
    const row = this.db.prepare(`
      SELECT content_json FROM content_cache
      WHERE id = ? AND source_type = ? AND mtime >= ?
    `).get(id, sourceType, mtime) as { content_json: string } | undefined;
    
    return row?.content_json || null;
  }

  /** Set cached parsed content. Redacts known secret shapes inline
   *  when CHAT_RECALL_REDACT_INDEX is enabled (cheap regex pass —
   *  see src/core/secret-redactor.ts). */
  setCachedContent(id: string, sourceType: string, mtime: number, content: string): void {
    const redacted = applyRedactionIfEnabled(content);
    this.db.prepare(`
      INSERT OR REPLACE INTO content_cache (id, source_type, mtime, content_json)
      VALUES (?, ?, ?, ?)
    `).run(id, sourceType, mtime, redacted);
  }

  // ── FTS5 full-text search ──────────────────────────────────────

  /** Index chunks into the FTS5 table */
  addChunksFTS(chunks: MemoryChunk[]): number {
    if (chunks.length === 0) return 0;

    const valid = chunks.filter(c => c.text && c.text.trim().length > 0);
    if (valid.length === 0) return 0;

    // FTS5 has no INSERT OR REPLACE on a virtual table. Without an
    // explicit delete, re-indexing the same item appends a fresh row
    // set every time, so a hot session can end up with dozens of dupes
    // per chunk_id. Delete the existing FTS rows for each (source_type,
    // item_id) appearing in this batch before re-inserting.
    const itemKeys = new Map<string, { sourceType: string; itemId: string }>();
    for (const c of valid) {
      // sourceType is a controlled enum (no ':'), so prefixing is unambiguous
      // even when itemId contains '::' (paths, etc.).
      itemKeys.set(`${c.sourceType}:${c.itemId}`, { sourceType: c.sourceType, itemId: c.itemId });
    }
    const del = this.db.prepare(
      `DELETE FROM memory_chunks_fts WHERE source_type = ? AND item_id = ?`
    );

    const insert = this.db.prepare(`
      INSERT INTO memory_chunks_fts(chunk_id, item_id, source_type, title, text, chunk_type, project_path, project_id, file_path, mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((chunks: MemoryChunk[]) => {
      for (const { sourceType, itemId } of itemKeys.values()) {
        del.run(sourceType, itemId);
      }
      for (const c of chunks) {
        // Resolve project_id from the chunk's projectPath. The resolver
        // is in-process cached, so even thousands of chunks per index
        // run only do ~tens of git subprocess calls.
        const resolved = c.projectPath ? resolveProjectId(c.projectPath) : null;
        const projectId = resolved && resolved.source !== 'ignored' ? resolved.id : '';
        insert.run(
          c.chunkId, c.itemId, c.sourceType, c.title,
          // Redact secrets before they enter FTS — prevents the
          // search index from becoming a leak vector. No-op when
          // CHAT_RECALL_REDACT_INDEX is unset.
          applyRedactionIfEnabled(c.text),
          c.chunkType, c.projectPath, projectId, c.filePath, c.mtime
        );
      }
    });

    transaction(valid);
    return valid.length;
  }

  /**
   * All chunks for one item, ordered by the numeric index in the chunk id
   * (`<itemId>:sync:<i>` / `<itemId>:<type>:<i>`). Server mode uses this to
   * rebuild a synced conversation's message list — the full-conversation
   * JSON (content_cache) is never synced, the per-turn chunks are the
   * canonical server-side copy.
   */
  listChunksByItem(sourceType: string, itemId: string): Array<{ chunk_id: string; title: string; text: string; chunk_type: string; mtime: number }> {
    const rows = this.db.prepare(`
      SELECT chunk_id, title, text, chunk_type, mtime
      FROM memory_chunks_fts WHERE source_type = ? AND item_id = ?
    `).all(sourceType, itemId) as Array<{ chunk_id: string; title: string; text: string; chunk_type: string; mtime: number }>;
    const idx = (c: string) => { const m = /:(\d+)$/.exec(c); return m ? Number(m[1]) : 0; };
    rows.sort((a, b) => idx(a.chunk_id) - idx(b.chunk_id));
    return rows;
  }

  // ── Tail-sync (append-only transcripts) ─────────────────────────
  // See docs/SYNC-INCREMENTAL.md. The append path needs an INSERT WITHOUT the
  // per-item DELETE that addChunksFTS performs (replace vs append semantics),
  // a way to continue the chunk-id index monotonically, and a metadata update
  // that touches ONLY mtime (so head-derived title/preview/extra survive).

  /** INSERT chunks WITHOUT deleting the item's existing rows. Used by the
   *  sync server's append path so a tail-only ship adds new chunks alongside
   *  the head's chunks instead of replacing them. Idempotent on retry via
   *  INSERT OR REPLACE on chunk_id (the primary key). */
  appendChunksFTS(chunks: MemoryChunk[]): number {
    if (chunks.length === 0) return 0;
    const valid = chunks.filter(c => c.text && c.text.trim().length > 0);
    if (valid.length === 0) return 0;
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO memory_chunks_fts(chunk_id, item_id, source_type, title, text, chunk_type, project_path, project_id, file_path, mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const transaction = this.db.transaction((chunks: MemoryChunk[]) => {
      for (const c of chunks) {
        const resolved = c.projectPath ? resolveProjectId(c.projectPath) : null;
        const projectId = resolved && resolved.source !== 'ignored' ? resolved.id : '';
        insert.run(
          c.chunkId, c.itemId, c.sourceType, c.title,
          applyRedactionIfEnabled(c.text),
          c.chunkType, c.projectPath, projectId, c.filePath, c.mtime
        );
      }
    });
    transaction(valid);
    return valid.length;
  }

  /** The highest `:sync:<i>` chunk index for one session — so the server can
   *  continue chunk numbering monotonically on an append (new chunks get
   *  MAX+1, MAX+2, …). Returns 0 when the session has no sync chunks yet. */
  maxSyncChunkIndex(itemId: string): number {
    const rows = this.db.prepare(`
      SELECT chunk_id FROM memory_chunks_fts
      WHERE source_type = 'session' AND item_id = ? AND chunk_id LIKE '%:sync:%'
    `).all(itemId) as Array<{ chunk_id: string }>;
    let max = 0;
    for (const r of rows) {
      const m = /:sync:(\d+)$/.exec(r.chunk_id);
      if (m) { const n = Number(m[1]); if (n > max) max = n; }
    }
    return max;
  }

  /** Update ONLY the mtime (and indexed_at) on a session's metadata row —
   *  used by the sync server's append path so head-derived title /
   *  content_preview / extra_json survive a tail-only ship untouched. */
  touchSessionMtime(sessionId: string, mtime: number): void {
    this.db.prepare(`
      UPDATE memory_metadata SET mtime = ?, indexed_at = ?
      WHERE id = ? AND source_type = 'session'
    `).run(Math.floor(mtime), Date.now(), sessionId);
  }

  // ── Tombstones + purge ─────────────────────────────────────────
  // Deleting a session is a first-class, propagating operation: the local
  // delete writes a tombstone; sync ships tombstones; every server purges
  // the session AND remembers the tombstone so no later sync (stale ledger,
  // second machine) can resurrect it.
  ensureTombstonesTable(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_tombstones (
      session_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL);`);
  }

  addTombstone(sessionId: string): void {
    this.ensureTombstonesTable();
    this.db.prepare(`INSERT OR IGNORE INTO session_tombstones (session_id, deleted_at) VALUES (?, ?)`)
      .run(sessionId, Date.now());
  }

  listTombstones(): Array<{ session_id: string; deleted_at: number }> {
    this.ensureTombstonesTable();
    return this.db.prepare(`SELECT session_id, deleted_at FROM session_tombstones`).all() as any;
  }

  /** Remove every trace of a session from this store (all tables that key
   *  on session/item id). Foreign-class tables (compute/outcome/metadata
   *  caches share the db file) are cleared best-effort. */
  purgeSession(sessionId: string): void {
    const run = (sql: string) => { try { this.db.prepare(sql).run(sessionId); } catch { /* table absent */ } };
    run(`DELETE FROM memory_metadata WHERE id = ? AND source_type = 'session'`);
    run(`DELETE FROM memory_chunks_fts WHERE item_id = ? AND source_type = 'session'`);
    run(`DELETE FROM content_cache WHERE id = ? AND source_type = 'session'`);
    run(`DELETE FROM raw_sessions WHERE session_id = ?`);
    run(`DELETE FROM secret_findings WHERE session_id = ?`);
    run(`DELETE FROM session_metadata WHERE session_id = ?`);
    run(`DELETE FROM compute_cache WHERE session_id = ?`);
    run(`DELETE FROM session_outcome_cache WHERE session_id = ?`);
    try {
      this.db.prepare(`DELETE FROM memory_links WHERE (source_type='session' AND source_id=?) OR (target_type='session' AND target_id=?)`)
        .run(sessionId, sessionId);
    } catch { /* absent */ }
  }

  // ── Raw session archive ────────────────────────────────────────
  // The immutable source of truth (Phase 2). Claude Code REWRITES
  // transcripts in place on compaction; this archive is what survives.
  // Shrink-protected: a capture smaller than the archived latest never
  // replaces it — compaction must not propagate into the archive.
  ensureRawSessionsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS raw_sessions (
        session_id   TEXT NOT NULL,
        tool         TEXT NOT NULL,
        mtime        INTEGER NOT NULL,
        size         INTEGER NOT NULL,
        gz           BLOB NOT NULL,
        captured_at  INTEGER NOT NULL,
        project_id   TEXT NOT NULL DEFAULT '',
        project_path TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (session_id)
      );
    `);
    // Backfill columns on an already-created archive table (older local stores).
    for (const col of ['project_id', 'project_path']) {
      try { this.db.exec(`ALTER TABLE raw_sessions ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`); } catch { /* already present */ }
    }
  }

  /** Archive a raw capture. Returns 'stored' | 'shrink-protected' | 'unchanged'.
   *  projectId/projectPath make the archive SELF-SUFFICIENT: server-side rebuild
   *  (self-heal) can restore a session's grouping from raw alone, no client. */
  putRawSession(sessionId: string, tool: string, mtime: number, gz: Buffer, uncompressedSize: number, projectId = '', projectPath = ''): 'stored' | 'shrink-protected' | 'unchanged' {
    this.ensureRawSessionsTable();
    const existing = this.db.prepare(`SELECT size, mtime, project_id FROM raw_sessions WHERE session_id = ?`).get(sessionId) as { size: number; mtime: number; project_id: string } | undefined;
    if (existing) {
      // Fill a missing project id even when the capture is unchanged/shrunk, so a
      // legacy archive becomes self-sufficient the next time it's re-synced.
      if (projectId && !existing.project_id) {
        this.db.prepare(`UPDATE raw_sessions SET project_id = ?, project_path = ? WHERE session_id = ?`).run(projectId, projectPath, sessionId);
      }
      if (existing.size === uncompressedSize && existing.mtime >= Math.floor(mtime)) return 'unchanged';
      if (uncompressedSize < existing.size) return 'shrink-protected';
    }
    this.db.prepare(`
      INSERT INTO raw_sessions (session_id, tool, mtime, size, gz, captured_at, project_id, project_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        tool = excluded.tool, mtime = excluded.mtime, size = excluded.size,
        gz = excluded.gz, captured_at = excluded.captured_at,
        project_id = CASE WHEN excluded.project_id <> '' THEN excluded.project_id ELSE raw_sessions.project_id END,
        project_path = CASE WHEN excluded.project_path <> '' THEN excluded.project_path ELSE raw_sessions.project_path END
    `).run(sessionId, tool, Math.floor(mtime), uncompressedSize, gz, Date.now(), projectId, projectPath);
    return 'stored';
  }

  getRawSession(sessionId: string): { tool: string; mtime: number; size: number; gz: Buffer; captured_at: number; project_id: string; project_path: string } | null {
    this.ensureRawSessionsTable();
    const r = this.db.prepare(`SELECT tool, mtime, size, gz, captured_at, project_id, project_path FROM raw_sessions WHERE session_id = ?`).get(sessionId) as any;
    return r ? { ...r, project_id: r.project_id ?? '', project_path: r.project_path ?? '' } : null;
  }

  /** session_id → archived (mtime, size) for sync-ledger style skipping. */
  listRawSessionVersions(): Array<{ session_id: string; mtime: number; size: number }> {
    this.ensureRawSessionsTable();
    return this.db.prepare(`SELECT session_id, mtime, size FROM raw_sessions`).all() as any;
  }

  /** Session ids that HAVE a rendered envelope but NO raw archive — the server
   *  has no fallback to self-heal them, so the client (disk + shadow) is the
   *  only fuller source. The self-heal sweep enqueues a client recheck for
   *  these. `sinceMs` bounds to recent envelopes; `limit` caps one pass. */
  listEnvelopesMissingRawArchive(sinceMs = 0, limit = 200): string[] {
    this.ensureRawSessionsTable();
    const rows = this.db.prepare(`
      SELECT c.id FROM content_cache c
      WHERE c.source_type = 'session' AND c.mtime >= ?
        AND NOT EXISTS (SELECT 1 FROM raw_sessions r WHERE r.session_id = c.id)
      ORDER BY c.mtime DESC LIMIT ?
    `).all(Math.floor(sinceMs) || 0, limit) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** Latest cached content for an item regardless of mtime — the
   *  stale-serving read: a snapshot from the last sync beats degrading
   *  to a lossier representation while a re-sync is mid-flight. */
  getCachedContentStale(id: string, sourceType: string): { content: string; mtime: number } | null {
    const r = this.db.prepare(`SELECT content_json, mtime FROM content_cache WHERE id = ? AND source_type = ?`).get(id, sourceType) as { content_json: string; mtime: number } | undefined;
    return r ? { content: r.content_json, mtime: r.mtime } : null;
  }

  /**
   * Remove session metadata rows that have neither a conversation envelope
   * nor search chunks — unopenable ghost rows (e.g. seeded from a stale
   * copy, or content-empty sessions). Returns rows deleted.
   */
  pruneEmptySessions(): number {
    return this.db.prepare(`
      DELETE FROM memory_metadata WHERE source_type='session'
        AND id NOT IN (SELECT id FROM content_cache WHERE source_type='session')
        AND id NOT IN (SELECT item_id FROM memory_chunks_fts WHERE source_type='session')
    `).run().changes;
  }

  /** Delete all FTS5 entries for an item */
  deleteItemFTS(sourceType: string, itemId: string): void {
    this.db.prepare(`
      DELETE FROM memory_chunks_fts WHERE item_id = ? AND source_type = ?
    `).run(itemId, sourceType);
  }

  /** Rebuild the FTS5 index from scratch (use after bulk deletes) */
  rebuildFTS(): void {
    this.db.exec(`INSERT INTO memory_chunks_fts(memory_chunks_fts) VALUES('rebuild')`);
  }

  /** Clear all FTS5 data */
  clearFTS(): void {
    this.db.exec(`DELETE FROM memory_chunks_fts`);
  }

  /** Full-text search across indexed chunks */
  searchFTS(
    query: string,
    options: {
      topK?: number;
      sourceTypes?: SourceType[];
      /** Logical project identifier (project_id) — exact match. */
      projectIdFilter?: string;
      /** Recency floor (epoch ms): only chunks with mtime >= sinceMs match.
       *  The free tier's search window; undefined = no floor. */
      sinceMs?: number;
    } = {}
  ): MemorySearchResult[] {
    const { topK = 20, sourceTypes, projectIdFilter, sinceMs } = options;

    // Escape FTS5 special characters and build query
    const ftsQuery = this.buildFTSQuery(query);
    if (!ftsQuery) return [];

    const limit = topK * 5;

    // Build WHERE clauses for post-filtering
    // FTS5 MATCH handles the text search, we filter source_type and project_id after
    let sql = `
      SELECT chunk_id, item_id, source_type, title, text, chunk_type, project_path, file_path, mtime,
             rank
      FROM memory_chunks_fts
      WHERE memory_chunks_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (sourceTypes && sourceTypes.length > 0) {
      const placeholders = sourceTypes.map(() => '?').join(', ');
      sql += ` AND source_type IN (${placeholders})`;
      params.push(...sourceTypes);
    }

    if (projectIdFilter) {
      // `-p`/projectFilter is a cleartext PATH SUBSTRING, not a resolved
      // project_id. Match against project_path (LIKE is case-insensitive for
      // ASCII in SQLite); exact project_id match made `-p` always return nothing.
      sql += ` AND project_path LIKE ?`;
      params.push(`%${projectIdFilter}%`);
    }

    if (sinceMs && Number.isFinite(sinceMs)) {
      sql += ` AND mtime >= ?`;
      params.push(sinceMs);
    }

    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    let rows: Array<{
      chunk_id: string; item_id: string; source_type: string;
      title: string; text: string; chunk_type: string;
      project_path: string; file_path: string; mtime: number;
      rank: number;
    }>;

    try {
      rows = this.db.prepare(sql).all(...params) as typeof rows;
    } catch {
      // If FTS query syntax fails, try a simpler approach
      const simpleQuery = query.replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean).join(' OR ');
      if (!simpleQuery) return [];
      params[0] = simpleQuery;
      try {
        rows = this.db.prepare(sql).all(...params) as typeof rows;
      } catch {
        return [];
      }
    }

    if (rows.length === 0) return [];

    // Group by item_id + source_type (same logic as vector search)
    const itemMap = new Map<string, {
      itemId: string;
      sourceType: SourceType;
      title: string;
      projectPath: string;
      filePath: string;
      mtime: number;
      chunks: Array<{ chunkType: string; text: string; score: number }>;
      bestScore: number;
    }>();

    for (const row of rows) {
      // FTS5 rank is negative (more negative = better match), normalize to 0-1
      const score = 1 / (1 + Math.abs(row.rank));
      const key = `${row.source_type}:${row.item_id}`;

      if (!itemMap.has(key)) {
        itemMap.set(key, {
          itemId: row.item_id,
          sourceType: row.source_type as SourceType,
          title: row.title,
          projectPath: row.project_path,
          filePath: row.file_path,
          mtime: row.mtime,
          chunks: [],
          bestScore: score,
        });
      }

      const item = itemMap.get(key)!;
      item.chunks.push({
        chunkType: row.chunk_type,
        text: row.text,
        score,
      });

      if (score > item.bestScore) {
        item.bestScore = score;
      }
    }

    // Convert to results
    const searchResults: MemorySearchResult[] = [];

    for (const [, item] of itemMap) {
      item.chunks.sort((a, b) => b.score - a.score);

      searchResults.push({
        itemId: item.itemId,
        sourceType: item.sourceType,
        title: item.title,
        text: item.chunks[0]?.text || '',
        score: item.bestScore,
        chunkType: item.chunks[0]?.chunkType || 'unknown',
        projectPath: item.projectPath,
        filePath: item.filePath,
        mtime: item.mtime,
        matchedChunks: item.chunks.slice(0, 3),
      });
    }

    searchResults.sort((a, b) => b.score - a.score);

    return searchResults.slice(0, topK);
  }

  /**
   * The high-importance memory feed (recall_wake_up).
   *
   * Selected by the classifier's OWN tag — chunks whose chunk_type carries
   * `:imp{minImportance..5}` (e.g. `assistant:decision:imp5`) — newest-first,
   * ranked by importance. This replaces the old approach of FTS-searching for
   * the literal words "decision preference milestone", which missed every
   * high-importance chunk that didn't happen to contain those nouns and
   * ordered results by keyword relevance instead of importance.
   */
  topImportantChunks(opts: { limit?: number; minImportance?: number; projectIdFilter?: string; sourceTypes?: SourceType[] } = {}): MemorySearchResult[] {
    const { limit = 10, minImportance = 4, projectIdFilter, sourceTypes } = opts;
    const impClauses: string[] = [];
    for (let i = minImportance; i <= 5; i++) impClauses.push(`chunk_type LIKE '%:imp${i}'`);
    let sql = `SELECT chunk_id, item_id, source_type, title, text, chunk_type, project_path, file_path, mtime
               FROM memory_chunks_fts WHERE (${impClauses.join(' OR ')})`;
    const params: (string | number)[] = [];
    if (sourceTypes && sourceTypes.length > 0) {
      sql += ` AND source_type IN (${sourceTypes.map(() => '?').join(', ')})`;
      params.push(...sourceTypes);
    }
    if (projectIdFilter) { sql += ` AND project_path LIKE ?`; params.push(`%${projectIdFilter}%`); }
    // chunk_type DESC puts :imp5 above :imp4 lexically; mtime breaks ties toward recent.
    sql += ` ORDER BY chunk_type DESC, mtime DESC LIMIT ?`; params.push(limit);
    let rows: Array<{ item_id: string; source_type: string; title: string; text: string; chunk_type: string; project_path: string; file_path: string; mtime: number }>;
    try { rows = this.db.prepare(sql).all(...params) as typeof rows; } catch { return []; }
    return rows.map((r) => ({
      itemId: r.item_id,
      sourceType: r.source_type as SourceType,
      title: r.title,
      text: r.text,
      score: 1,
      chunkType: r.chunk_type,
      projectPath: r.project_path,
      filePath: r.file_path,
      mtime: r.mtime,
      matchedChunks: [{ chunkType: r.chunk_type, text: r.text, score: 1 }],
    }));
  }

  /** Number of FTS chunks indexed for one item. 0 = listed-but-unsearchable
   *  (metadata/envelope exist but chunks were never written — the ingest
   *  atomicity gap the self-heal reconciler repairs). */
  countItemChunks(sourceType: string, itemId: string): number {
    try {
      const r = this.db.prepare(`SELECT COUNT(*) AS n FROM memory_chunks_fts WHERE item_id = ? AND source_type = ?`).get(itemId, sourceType) as { n: number };
      return r?.n ?? 0;
    } catch { return 0; }
  }

  /** Get FTS5 chunk count */
  getFTSCount(): number {
    try {
      const row = this.db.prepare(
        `SELECT COUNT(*) as count FROM memory_chunks_fts`
      ).get() as { count: number };
      return row.count;
    } catch {
      return 0;
    }
  }

  /** Test twin of PgStore.approxStoredBytes — the free tier's storage meter
   *  measures what is actually stored, and the unit suite exercises the same
   *  path through this driver. */
  approxStoredBytes(): number {
    let total = 0;
    try {
      const c = this.db.prepare(`SELECT COALESCE(SUM(length(text)),0) AS b FROM memory_chunks_fts`).get() as { b: number };
      total += Number(c?.b ?? 0);
    } catch { /* empty */ }
    try {
      const c = this.db.prepare(`SELECT COALESCE(SUM(length(content_json)),0) AS b FROM content_cache`).get() as { b: number };
      total += Number(c?.b ?? 0);
    } catch { /* empty */ }
    return total;
  }

  /**
   * Count distinct items (e.g. sessions) whose chunks match an FTS5 query.
   *
   * Use this instead of `searchFTS().length` when the caller only needs the
   * total — `searchFTS` caps at `topK * 5` rows internally, so for popular
   * keywords (authentication / docker / api) it would return the cap, not
   * the true count.
   */
  countDistinctItemsMatching(
    query: string,
    options: {
      sourceTypes?: SourceType[];
      projectFilter?: string;
      /** Count only items whose chunks are OLDER than this (mtime < beforeMs).
       *  The free tier's `locked_older` counter — how many matches sit behind
       *  the search window. */
      beforeMs?: number;
    } = {}
  ): number {
    const ftsQuery = this.buildFTSQuery(query);
    if (!ftsQuery) return 0;

    let sql = `
      SELECT COUNT(DISTINCT item_id) AS n
      FROM memory_chunks_fts
      WHERE memory_chunks_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (options.sourceTypes && options.sourceTypes.length > 0) {
      const placeholders = options.sourceTypes.map(() => '?').join(', ');
      sql += ` AND source_type IN (${placeholders})`;
      params.push(...options.sourceTypes);
    }

    if (options.projectFilter) {
      sql += ` AND project_path LIKE ?`;
      params.push(`%${options.projectFilter}%`);
    }

    if (options.beforeMs && Number.isFinite(options.beforeMs)) {
      sql += ` AND mtime < ?`;
      params.push(options.beforeMs);
    }

    try {
      const row = this.db.prepare(sql).get(...params) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch {
      // Match the fallback `searchFTS` uses for unparseable queries.
      const simpleQuery = query
        .replace(/[^a-zA-Z0-9\s]/g, ' ').trim()
        .split(/\s+/).filter(Boolean).join(' OR ');
      if (!simpleQuery) return 0;
      params[0] = simpleQuery;
      try {
        const row = this.db.prepare(sql).get(...params) as { n: number } | undefined;
        return row?.n ?? 0;
      } catch {
        return 0;
      }
    }
  }

  /**
   * Build an FTS5 query from a user-facing string.
   *
   * Syntax supported:
   *   - "exact phrase"   — wrap in double quotes for an FTS5 phrase
   *                        match (all tokens, in order)
   *   - +word            — require this token (AND)
   *   - bare words       — permissive OR match (legacy behavior)
   *
   * Mixed: `"erpc logs" +ireland eu-2`
   *   → ("erpc logs") AND (ireland) AND (eu OR 2)
   */
  private buildFTSQuery(query: string): string {
    const phrases: string[] = [];
    const requiredTokens: string[] = [];

    // Pull out "..." phrases first; what remains is unquoted.
    let remainder = query.replace(/"([^"]+)"/g, (_m, p1: string) => {
      const inner = p1
        .replace(/[^a-zA-Z0-9\s_.-]/g, ' ')
        .trim();
      if (inner.length > 0) phrases.push(`"${inner}"`);
      return ' ';
    });

    // +token → required AND term
    remainder = remainder.replace(/\+([a-zA-Z0-9_.-]{2,})/g, (_m, p1: string) => {
      requiredTokens.push(p1);
      return ' ';
    });

    // Whatever's left → OR-joined permissive tokens (legacy behavior).
    const orWords = remainder
      .replace(/[^a-zA-Z0-9\s_.-]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 1);

    const clauses: string[] = [];
    if (phrases.length > 0) clauses.push(phrases.join(' AND '));
    if (requiredTokens.length > 0) clauses.push(requiredTokens.join(' AND '));
    if (orWords.length > 0) clauses.push(`(${orWords.join(' OR ')})`);

    if (clauses.length === 0) return '';

    // Search in text and title columns only. Wrap the whole expression
    // in parentheses so the column filter applies to the full AND-chain
    // (otherwise `{text title} : a AND b` parses as `{text title}:a AND b`
    // and the column scope only binds to the first term).
    return `{text title} : (${clauses.join(' AND ')})`;
  }

  // ── KV store ───────────────────────────────────────────────────
  // The third memory primitive (alongside diary + KG): small persistent
  // values the agent can stash and read back. Scopes namespace keys so
  // an agent can keep per-project / per-task state without collisions.

  /** Set a key/value pair. Overwrites any previous value at (scope, key). */
  kvSet(scope: string, key: string, value: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO kv_store (scope, key, value, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(scope, key, value, Date.now());
  }

  /** Read a value. Returns null if (scope, key) is not set. */
  kvGet(scope: string, key: string): { value: string; updated_at: number } | null {
    const row = this.db.prepare(`
      SELECT value, updated_at FROM kv_store WHERE scope = ? AND key = ?
    `).get(scope, key) as { value: string; updated_at: number } | undefined;
    return row ?? null;
  }

  /** Delete a key. Returns true if a row was removed. */
  kvDelete(scope: string, key: string): boolean {
    const r = this.db.prepare('DELETE FROM kv_store WHERE scope = ? AND key = ?').run(scope, key);
    return r.changes > 0;
  }

  /** List keys in a scope (or all scopes if scope is undefined). */
  kvList(scope?: string, limit = 200): Array<{ scope: string; key: string; value: string; updated_at: number }> {
    if (scope === undefined) {
      return this.db.prepare(`
        SELECT scope, key, value, updated_at FROM kv_store
        ORDER BY updated_at DESC LIMIT ?
      `).all(limit) as any;
    }
    return this.db.prepare(`
      SELECT scope, key, value, updated_at FROM kv_store
      WHERE scope = ? ORDER BY updated_at DESC LIMIT ?
    `).all(scope, limit) as any;
  }

  // ── Cross-tool sync intents (Model B queue) ────────────────────
  // The UI enqueues an intent; the local CLI agent drains pending rows,
  // performs the filesystem copy on the user's machine, and acks status.

  /** Queue an intent. Returns the generated id. */
  enqueueSyncIntent(input: SyncIntentInput): string {
    const id = 'si_' + randomBytes(8).toString('hex');
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO sync_intents
        (id, device_id, kind, artifact_type, name, from_tool, to_tool, status, result, created_at, updated_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)
    `).run(id, input.deviceId ?? null, input.kind, input.artifactType ?? null, input.name ?? null,
           input.fromTool ?? null, input.toTool ?? null, now, now, input.createdBy ?? null);
    return id;
  }

  /** Pending intents targeted at `deviceId` (or untargeted, device_id IS NULL). */
  listPendingSyncIntents(deviceId?: string | null, limit = 50): SyncIntentRow[] {
    return this.db.prepare(`
      SELECT id, device_id, kind, artifact_type, name, from_tool, to_tool, status, result, created_at, updated_at, created_by
      FROM sync_intents
      WHERE status = 'pending' AND (device_id IS NULL OR device_id = ?)
      ORDER BY created_at ASC LIMIT ?
    `).all(deviceId ?? null, limit) as SyncIntentRow[];
  }

  /** All pending intents across all devices (used for the global matrix UI). */
  listAllPendingSyncIntents(limit = 1000): SyncIntentRow[] {
    return this.db.prepare(`
      SELECT id, device_id, kind, artifact_type, name, from_tool, to_tool, status, result, created_at, updated_at, created_by
      FROM sync_intents
      WHERE status = 'pending'
      ORDER BY created_at ASC LIMIT ?
    `).all(limit) as SyncIntentRow[];
  }

  /** Mark an intent done/error with a JSON result/error string. */
  ackSyncIntent(id: string, status: 'done' | 'error', result?: string | null): boolean {
    const r = this.db.prepare(`UPDATE sync_intents SET status = ?, result = ?, updated_at = ? WHERE id = ?`)
      .run(status, result ?? null, Date.now(), id);
    return r.changes > 0;
  }

  /** Recent intents (any status) — for the UI to show progress. */
  listSyncIntents(limit = 50): SyncIntentRow[] {
    return this.db.prepare(`
      SELECT id, device_id, kind, artifact_type, name, from_tool, to_tool, status, result, created_at, updated_at, created_by
      FROM sync_intents ORDER BY created_at DESC LIMIT ?
    `).all(limit) as SyncIntentRow[];
  }

  // ── Code intelligence (codeindex merge) ────────────────────────────────
  // Findings + hotspots are derived: replaced wholesale per project on each
  // re-index (first_seen_at + dismissals preserved). Actions carry durable
  // user state (queued/done/dismissed): upserted in place by deterministic id.

  upsertCodeProject(p: CodeProjectInput): void {
    const now = Date.now();
    // label is intentionally omitted from the UPDATE set so a user-assigned
    // label survives every re-index (set separately via setCodeProjectLabel).
    this.db.prepare(`
      INSERT INTO code_projects
        (project_id, root_path, file_count, symbol_count, langs_json, health_json, map_json, label, indexed_by, last_indexed_at, collector_version, created_at, updated_at)
      VALUES (@project_id, @root_path, @file_count, @symbol_count, @langs_json, @health_json, @map_json, @label, @indexed_by, @last_indexed_at, @collector_version, @now, @now)
      ON CONFLICT(project_id) DO UPDATE SET
        root_path=excluded.root_path, file_count=excluded.file_count, symbol_count=excluded.symbol_count,
        langs_json=excluded.langs_json, health_json=excluded.health_json, map_json=excluded.map_json,
        indexed_by=excluded.indexed_by, last_indexed_at=excluded.last_indexed_at,
        collector_version=excluded.collector_version, updated_at=excluded.updated_at
    `).run({
      project_id: p.projectId, root_path: p.rootPath, file_count: p.fileCount, symbol_count: p.symbolCount,
      langs_json: JSON.stringify(p.langs ?? {}), health_json: JSON.stringify(p.health ?? {}),
      map_json: JSON.stringify(p.map ?? {}), label: p.label ?? null, indexed_by: p.indexedBy ?? null,
      last_indexed_at: p.lastIndexedAt, collector_version: p.collectorVersion ?? null, now,
    });
  }

  getCodeProject(projectId: string): CodeProjectRow | null {
    const r = this.db.prepare(`SELECT * FROM code_projects WHERE project_id = ?`).get(projectId) as any;
    return r ? rowToCodeProject(r) : null;
  }

  listCodeProjects(): CodeProjectRow[] {
    return (this.db.prepare(`SELECT * FROM code_projects ORDER BY last_indexed_at DESC`).all() as any[]).map(rowToCodeProject);
  }

  setCodeProjectLabel(projectId: string, label: CodeProjectLabel | null): boolean {
    const r = this.db.prepare(`UPDATE code_projects SET label = ?, updated_at = ? WHERE project_id = ?`)
      .run(label, Date.now(), projectId);
    return r.changes > 0;
  }

  /** Remove a code project and all its findings/hotspots/actions. */
  deleteCodeProject(projectId: string): boolean {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM code_findings WHERE project_id = ?`).run(projectId);
      this.db.prepare(`DELETE FROM code_hotspots WHERE project_id = ?`).run(projectId);
      this.db.prepare(`DELETE FROM code_actions WHERE project_id = ?`).run(projectId);
      return this.db.prepare(`DELETE FROM code_projects WHERE project_id = ?`).run(projectId).changes > 0;
    });
    return tx();
  }

  /** Replace all findings for a project. Preserves first_seen_at + status of
   *  findings whose deterministic id reappears (so dismissals survive re-index). */
  replaceCodeFindings(projectId: string, findings: CodeFindingInput[]): number {
    const now = Date.now();
    const tx = this.db.transaction((items: CodeFindingInput[]) => {
      const prev = this.db.prepare(`SELECT id, first_seen_at, status FROM code_findings WHERE project_id = ?`)
        .all(projectId) as Array<{ id: string; first_seen_at: number; status: string }>;
      const prevById = new Map(prev.map((r) => [r.id, r]));
      this.db.prepare(`DELETE FROM code_findings WHERE project_id = ?`).run(projectId);
      // OR REPLACE: two findings can hash to the same deterministic id within a
      // single run (last wins) — collapse rather than crash.
      const ins = this.db.prepare(`
        INSERT OR REPLACE INTO code_findings (id, project_id, category, severity, file, line, rule, title, snippet, why, agent_prompt, status, first_seen_at, last_seen_at, extra_json)
        VALUES (@id, @project_id, @category, @severity, @file, @line, @rule, @title, @snippet, @why, @agent_prompt, @status, @first_seen_at, @last_seen_at, @extra_json)
      `);
      let n = 0;
      for (const f of items) {
        const id = f.id ?? codeFindingId(projectId, f);
        const carried = prevById.get(id);
        ins.run({
          id, project_id: projectId, category: f.category, severity: f.severity, file: f.file,
          line: f.line ?? null, rule: f.rule, title: f.title, snippet: f.snippet ?? '', why: f.why ?? '',
          agent_prompt: f.agentPrompt ?? '', status: carried?.status ?? 'open',
          first_seen_at: carried?.first_seen_at ?? now, last_seen_at: now,
          extra_json: JSON.stringify(f.extra ?? {}),
        });
        n++;
      }
      return n;
    });
    return tx(findings);
  }

  listCodeFindings(projectId?: string, opts: { severity?: CodeSeverity; category?: string; limit?: number } = {}): CodeFindingRow[] {
    const where: string[] = []; const params: any[] = [];
    if (projectId) { where.push('project_id = ?'); params.push(projectId); }
    if (opts.severity) { where.push('severity = ?'); params.push(opts.severity); }
    if (opts.category) { where.push('category = ?'); params.push(opts.category); }
    params.push(opts.limit ?? 500);
    const sql = `SELECT * FROM code_findings ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, last_seen_at DESC
      LIMIT ?`;
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToCodeFinding);
  }

  codeFindingsSummary(projectId?: string): CodeFindingsSummary {
    const where = projectId ? 'WHERE project_id = ?' : '';
    const params = projectId ? [projectId] : [];
    const rows = this.db.prepare(`SELECT severity, category, COUNT(*) c FROM code_findings ${where} GROUP BY severity, category`)
      .all(...params) as Array<{ severity: string; category: string; c: number }>;
    const sum: CodeFindingsSummary = { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, byCategory: {} };
    for (const r of rows) {
      sum.total += r.c;
      if (r.severity in sum.bySeverity) (sum.bySeverity as any)[r.severity] += r.c;
      sum.byCategory[r.category] = (sum.byCategory[r.category] ?? 0) + r.c;
    }
    return sum;
  }

  /** Replace all hotspots for a project (purely derived, no user state). */
  replaceCodeHotspots(projectId: string, hotspots: CodeHotspotInput[]): number {
    const now = Date.now();
    const tx = this.db.transaction((items: CodeHotspotInput[]) => {
      this.db.prepare(`DELETE FROM code_hotspots WHERE project_id = ?`).run(projectId);
      const ins = this.db.prepare(`
        INSERT OR REPLACE INTO code_hotspots (id, project_id, file, churn, complexity, score, ai_authored, lines, suggestion, last_seen_at)
        VALUES (@id, @project_id, @file, @churn, @complexity, @score, @ai_authored, @lines, @suggestion, @last_seen_at)
      `);
      let n = 0;
      for (const h of items) {
        ins.run({
          id: codeHotspotId(projectId, h.file), project_id: projectId, file: h.file,
          churn: h.churn | 0, complexity: h.complexity | 0, score: h.score,
          ai_authored: h.aiAuthored ? 1 : 0, lines: h.lines | 0, suggestion: h.suggestion ?? '', last_seen_at: now,
        });
        n++;
      }
      return n;
    });
    return tx(hotspots);
  }

  listCodeHotspots(projectId?: string, limit = 100): CodeHotspotRow[] {
    const where = projectId ? 'WHERE project_id = ?' : '';
    const params: any[] = projectId ? [projectId] : [];
    params.push(limit);
    return (this.db.prepare(`SELECT * FROM code_hotspots ${where} ORDER BY score DESC LIMIT ?`).all(...params) as any[]).map(rowToCodeHotspot);
  }

  /** Upsert actions by deterministic id. Preserves status/queued/created_at so
   *  user decisions (queued, done, dismissed) survive re-index. */
  upsertCodeActions(projectId: string, actions: CodeActionInput[]): number {
    const now = Date.now();
    const tx = this.db.transaction((items: CodeActionInput[]) => {
      const up = this.db.prepare(`
        INSERT INTO code_actions (id, project_id, pri, category, title, fix, loc_json, agent_prompt, status, queued, created_at, updated_at)
        VALUES (@id, @project_id, @pri, @category, @title, @fix, @loc_json, @agent_prompt, 'suggested', 0, @now, @now)
        ON CONFLICT(id) DO UPDATE SET
          pri=excluded.pri, category=excluded.category, title=excluded.title, fix=excluded.fix,
          loc_json=excluded.loc_json, agent_prompt=excluded.agent_prompt, updated_at=excluded.updated_at
      `);
      let n = 0;
      const keepIds = new Set<string>();
      for (const a of items) {
        const id = a.id ?? codeActionId(projectId, a);
        keepIds.add(id);
        up.run({
          id, project_id: projectId, pri: a.pri | 0, category: a.category, title: a.title,
          fix: a.fix, loc_json: JSON.stringify(a.loc ?? []), agent_prompt: a.agentPrompt, now,
        });
        n++;
      }
      // Prune stale suggestions the new run didn't produce; keep user-triaged
      // actions (queued/done/dismissed) so their state survives a re-index.
      const stale = this.db.prepare(`SELECT id FROM code_actions WHERE project_id=? AND status='suggested'`).all(projectId) as Array<{ id: string }>;
      const del = this.db.prepare(`DELETE FROM code_actions WHERE id=? AND project_id=?`);
      for (const s of stale) if (!keepIds.has(s.id)) del.run(s.id, projectId);
      return n;
    });
    return tx(actions);
  }

  listCodeActions(projectId?: string, opts: { status?: CodeActionStatus; queued?: boolean; limit?: number } = {}): CodeActionRow[] {
    const where: string[] = []; const params: any[] = [];
    if (projectId) { where.push('project_id = ?'); params.push(projectId); }
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    if (opts.queued !== undefined) { where.push('queued = ?'); params.push(opts.queued ? 1 : 0); }
    params.push(opts.limit ?? 200);
    return (this.db.prepare(`SELECT * FROM code_actions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY pri ASC, updated_at DESC LIMIT ?`).all(...params) as any[]).map(rowToCodeAction);
  }

  setCodeActionStatus(id: string, status: CodeActionStatus, queued?: boolean): boolean {
    if (queued === undefined) {
      const r = this.db.prepare(`UPDATE code_actions SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), id);
      return r.changes > 0;
    }
    const r = this.db.prepare(`UPDATE code_actions SET status = ?, queued = ?, updated_at = ? WHERE id = ?`)
      .run(status, queued ? 1 : 0, Date.now(), id);
    return r.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

// ── Code-intel row mappers (snake_case sqlite row → camelCase typed row) ─────
function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
function rowToCodeProject(r: any): CodeProjectRow {
  return {
    projectId: r.project_id, rootPath: r.root_path, fileCount: r.file_count, symbolCount: r.symbol_count,
    langs: safeJson<Record<string, number>>(r.langs_json, {}),
    health: safeJson<CodeHealth>(r.health_json, {} as CodeHealth),
    map: safeJson<CodeMap>(r.map_json, {} as CodeMap),
    label: (r.label ?? null) as CodeProjectLabel | null, indexedBy: r.indexed_by ?? null,
    lastIndexedAt: Number(r.last_indexed_at),
    collectorVersion: r.collector_version == null ? null : Number(r.collector_version),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}
function rowToCodeFinding(r: any): CodeFindingRow {
  return {
    id: r.id, projectId: r.project_id, category: r.category, severity: r.severity, file: r.file,
    line: r.line ?? null, rule: r.rule, title: r.title, snippet: r.snippet, why: r.why,
    agentPrompt: r.agent_prompt, status: r.status, firstSeenAt: Number(r.first_seen_at),
    lastSeenAt: Number(r.last_seen_at), extra: safeJson<Record<string, unknown>>(r.extra_json, {}),
  };
}
function rowToCodeHotspot(r: any): CodeHotspotRow {
  return {
    id: r.id, projectId: r.project_id, file: r.file, churn: r.churn, complexity: r.complexity,
    score: r.score, aiAuthored: !!r.ai_authored, lines: r.lines, suggestion: r.suggestion ?? '', lastSeenAt: Number(r.last_seen_at),
  };
}
function rowToCodeAction(r: any): CodeActionRow {
  return {
    id: r.id, projectId: r.project_id, pri: r.pri, category: r.category, title: r.title, fix: r.fix,
    loc: safeJson<CodeActionLoc[]>(r.loc_json, []), agentPrompt: r.agent_prompt, status: r.status,
    queued: !!r.queued, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

/** Input to enqueue a cross-tool sync intent. */
export interface SyncIntentInput {
  kind: 'copy' | 'sync_all' | 'code_apply' | 'recheck_session';
  /** Target device (null/undefined = any device in the tenant). */
  deviceId?: string | null;
  artifactType?: string | null;  // skill|mcp|command|agent (copy only)
  name?: string | null;          // artifact name (copy only)
  fromTool?: string | null;
  toTool?: string | null;
  createdBy?: string | null;
}

/** A persisted sync intent row. */
export interface SyncIntentRow {
  id: string;
  device_id: string | null;
  kind: 'copy' | 'sync_all' | 'code_apply' | 'recheck_session';
  artifact_type: string | null;
  name: string | null;
  from_tool: string | null;
  to_tool: string | null;
  status: 'pending' | 'done' | 'error';
  result: string | null;
  created_at: number;
  updated_at: number;
  created_by: string | null;
}
