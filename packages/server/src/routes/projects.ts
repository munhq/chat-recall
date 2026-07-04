/**
 * Projects route — read/write the user's projects.json + expose the
 * resolver's view of the index so the UI can render workspaces,
 * declared projects, and auto-detected git repos in one tree.
 *
 *   GET  /api/projects                → { config, detected, declared, all }
 *   PUT  /api/projects                → save config + trigger backfill
 *   GET  /api/projects/:id/dossier    → markdown dossier for one project
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { dirname } from 'path';
import Database from 'better-sqlite3';
import { Router } from 'express';

import {
  createStore,
  buildProjectDossier,
  loadProjectsConfig,
  getProjectsConfigPath,
  resetProjectResolverCache,
  resolveProjectId,
  resolveWorkspaceId,
  type ProjectsConfig,
} from '../imports.js';
import { getCacheDbPath } from '@chat-recall/engine/core/paths.js';
import { requireLocalMode } from '../util/mode.js';

const router = Router();

interface ProjectSummaryRow {
  project_id: string;
  items: number;
  last_mtime: number;
}

interface AggregatedProject {
  project_id: string;
  display_name: string;
  source: 'git-remote' | 'git-local' | 'auto-workspace' | 'path' | 'user' | 'ignored';
  items: number;
  last_mtime: number;
  /** Workspace this project rolls up under, if any. */
  workspace_id?: string;
  /** True when this row is itself a workspace (rollup of children). */
  is_workspace?: boolean;
}

/* -----------------------------------------------------------------------
 * GET /api/projects
 * --------------------------------------------------------------------- */

router.get('/', async (_req, res) => {
  try {
    const cfg = loadProjectsConfig();
    const summaries = await listProjectsSummary();

    // Annotate each project_id with its source (parse the prefix) and
    // workspace membership (from the config).
    const projects: AggregatedProject[] = summaries.map(s => annotate(s, cfg));

    // Group: workspaces at top, then plain projects, sorted by activity.
    const workspaces = projects.filter(p => p.is_workspace);
    const standalone = projects.filter(p => !p.is_workspace);

    res.json({
      config_path: getProjectsConfigPath(),
      config: cfg,
      workspaces,
      standalone,
      all: projects,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* -----------------------------------------------------------------------
 * PUT /api/projects  — save config + run targeted backfill
 *
 * Body: { config: ProjectsConfig }
 *
 * The resolver caches per-realpath. After a config change we invalidate
 * the cache and re-run the backfill so existing rows pick up the new
 * grouping immediately.
 * --------------------------------------------------------------------- */

router.put('/', requireLocalMode, (req, res) => {
  try {
    const body = req.body as { config?: ProjectsConfig };
    if (!body || typeof body !== 'object' || !body.config) {
      res.status(400).json({ error: 'body must be { config: ProjectsConfig }' });
      return;
    }
    const cfg = body.config;
    validateConfig(cfg);

    const path = getProjectsConfigPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(cfg, null, 2));

    resetProjectResolverCache();
    const changed = runBackfill();

    res.json({ ok: true, changed_rows: changed });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/* -----------------------------------------------------------------------
 * GET /api/projects/tree  — the single source of truth for the sidebar
 *
 * Returns ProjectTreeNode[] (shape the client's Sidebar.tsx already
 * renders) built from `project_id`, not raw paths.
 *
 * Structure:
 *   - Top-level: workspaces first (ws:* + user-declared workspace=true),
 *     then standalone projects (git: / git-local: / user-declared
 *     non-workspace).
 *   - Workspace nodes have git/local-git children whose `projectPath`
 *     lives under that workspace's root.
 *   - Final node: "Untracked locations" (id starts with `untracked:`) —
 *     collapsed by default; aggregates all `source = 'path'` rows so
 *     `/`, `/home/user`, `/tmp`, and PR-bot worktrees (e.g. `379`) are
 *     accessible but don't pollute the main tree.
 *   - Orphan transcripts (projectPath no longer exists on disk) are
 *     marked with `orphan = true` so the UI can dim them.
 * --------------------------------------------------------------------- */

interface TreeNode {
  id: string;          // project_id (filter value)
  name: string;        // displayName
  count: number;       // items directly at this id
  totalCount: number;  // count + sum of descendants
  children: TreeNode[];
  source?: string;     // 'git-remote' | 'auto-workspace' | 'path' | 'automation' | …
  orphan?: boolean;    // path-source rows whose folder no longer exists
  workspace?: boolean; // true for grouping rows
  lastMtime?: number;  // newest session mtime under this node — powers "Recent"
}

/**
 * Path-source rows that are NOT real projects and must never appear as one:
 * filesystem roots, scratch dirs, the user's home, downloads, chat-recall's
 * own internal transcript store, and bare session-UUID folders. These polluted
 * the tree with `/`, `/tmp`, `~/Downloads`, `.claude/projects`, `e0a584b4-…`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isJunkPath(p: string): boolean {
  if (!p) return true;
  if (p === '/' || p === '.') return true;
  const segs = p.split('/').filter(Boolean);
  if (segs.length === 0) return true;
  const base = segs[segs.length - 1];
  if (UUID_RE.test(base)) return true;                       // raw session dir
  if (p.includes('/.claude/projects')) return true;          // internal store
  if (/^\/tmp(\/|$)/.test(p) || /^\/var\/tmp(\/|$)/.test(p)) return true;
  if (/\/(Downloads|Desktop|Library)(\/|$)/.test(p)) return true;
  // The user's home itself (and bare "/home", "/Users") — a container, not a project.
  if (/^\/(home|Users)\/[^/]+\/?$/.test(p) || /^\/(home|Users)\/?$/.test(p)) return true;
  return false;
}

/** A resolver bug produced paths with duplicated segments
 *  (…/acme/acme/gcp/infrastructure/gcp/infrastructure/…). Detect a segment
 *  equal to the one before it and drop the phantom project. */
function isMalformedPath(p: string): boolean {
  const segs = p.split('/').filter(Boolean);
  for (let i = 1; i < segs.length; i++) if (segs[i] && segs[i] === segs[i - 1]) return true;
  return false;
}

/** Automation roots — throwaway worktrees the bots create. Real work, but not a
 *  project you browse by; grouped separately and off by default so 9k+ bot
 *  sessions never bury your actual repos. */
const AUTOMATION_SUBSTR = ['/.claude-pr-bot', '/.claude-work/worktrees', '/.claude-pr/'];
function isAutomationPath(p: string): boolean {
  return AUTOMATION_SUBSTR.some((s) => p.includes(s));
}

router.get('/tree', async (_req, res) => {
  try {
    const cfg = loadProjectsConfig();
    const store = await createStore();
    let summaries: Array<{ project_id: string; items: number; last_mtime: number }>;
    let pathMap: Map<string, string>;
    try {
      summaries = await store.listProjectsSummary();
      // project_id → representative project_path (used for orphan + membership checks).
      pathMap = new Map((await store.listAllProjectIdPaths()).map(r => [r.project_id, r.project_path]));
    } finally {
      await store.close();
    }

    const tree = buildTreeFromSummaries(summaries, pathMap, cfg);
    res.json({ nodes: tree, totalCount: tree.reduce((s, n) => s + n.totalCount, 0) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

function buildTreeFromSummaries(
  summaries: Array<{ project_id: string; items: number; last_mtime: number }>,
  pathMap: Map<string, string>,
  cfg: ProjectsConfig,
): TreeNode[] {
  interface Annotated extends TreeNode { projectPath: string }
  const annotated: Annotated[] = summaries.map(s => {
    const { source, displayName } = parseProjectId(s.project_id);
    const projectPath = pathMap.get(s.project_id) || '';
    const orphan = source === 'path' && projectPath !== '' && !existsSync(projectPath);
    return {
      id: s.project_id,
      name: cfgDisplayNameOverride(s.project_id, cfg) || displayName,
      count: s.items,
      totalCount: s.items,
      children: [],
      source,
      orphan,
      workspace: false,
      lastMtime: s.last_mtime,
      projectPath,
    };
  });

  // Workspace membership is decided by the resolver, not re-derived from
  // paths here. `resolveWorkspaceId(repPath)` walks up from the git repo
  // root to find the enclosing workspace, so it is depth-independent (a
  // session's CWD may be any subdir) and deterministic across requests.
  // Workspace nodes are keyed by id; we synthesise one when a child names
  // a workspace that has no direct sessions of its own (so no summary row).
  const byId = new Map<string, Annotated>(annotated.map(n => [n.id, n]));
  const isWorkspaceId = (n: Annotated) =>
    n.source === 'auto-workspace' || isUserWorkspace(n.id, cfg);

  const workspaces: Annotated[] = [];
  const ensureWorkspace = (id: string): Annotated => {
    let w = byId.get(id);
    if (!w) {
      const { displayName } = parseProjectId(id);
      w = {
        id,
        name: cfgDisplayNameOverride(id, cfg) || displayName,
        count: 0,
        totalCount: 0,
        children: [],
        source: id.startsWith('ws:') ? 'auto-workspace' : 'user',
        workspace: true,
        projectPath: '',
      };
      byId.set(id, w);
    }
    if (!w.workspace) { w.workspace = true; }
    if (!workspaces.includes(w)) workspaces.push(w);
    return w;
  };

  // Register workspaces that already have their own summary row.
  for (const n of annotated) {
    if (isWorkspaceId(n)) ensureWorkspace(n.id);
  }

  // String-only workspace nesting fallback for server mode: the FS-based
  // resolver (realpath + git toplevel) can't run against paths that only
  // exist on the producer's machine. Derive each known workspace's root
  // from its own pathMap entry (the path prefix up to the segment matching
  // the workspace name), then nest children by plain prefix. Longest root
  // wins so nested workspaces resolve correctly.
  const wsRoots: Array<{ id: string; root: string }> = [];
  for (const n of annotated) {
    if (!isWorkspaceId(n) || !n.id.startsWith('ws:')) continue;
    const wsName = n.id.slice(3);
    const samplePath = n.projectPath || pathMap.get(n.id) || '';
    const segs = samplePath.split('/');
    const idx = segs.indexOf(wsName);
    if (idx > 0) wsRoots.push({ id: n.id, root: segs.slice(0, idx + 1).join('/') });
  }
  wsRoots.sort((a, b) => b.root.length - a.root.length);
  const wsIdByPrefix = (path: string): string | null => {
    if (!path) return null;
    for (const w of wsRoots) if (path === w.root || path.startsWith(w.root + '/')) return w.id;
    return null;
  };

  const standaloneGit: TreeNode[] = [];
  const untracked: TreeNode[] = [];
  const automation: TreeNode[] = [];
  for (const n of annotated) {
    if (n.workspace || isWorkspaceId(n)) continue;
    if (n.source === 'path') {
      const p = n.projectPath || n.id.replace(/^path:/, '');
      if (isJunkPath(p) || isMalformedPath(p)) continue;      // never a project — drop
      if (isAutomationPath(p)) { automation.push(n); continue; }
      untracked.push(n);
      continue;
    }
    const wsId = (n.projectPath ? resolveWorkspaceId(n.projectPath) : null) ?? wsIdByPrefix(n.projectPath);
    if (wsId) {
      const w = ensureWorkspace(wsId);
      w.children.push(n);
      w.totalCount += n.totalCount;
      w.lastMtime = Math.max(w.lastMtime ?? 0, n.lastMtime ?? 0);
    } else {
      standaloneGit.push(n);
    }
  }

  // Sort: workspaces+standalone by totalCount desc; automation + untracked last.
  const sortByActivity = (a: TreeNode, b: TreeNode) => b.totalCount - a.totalCount;
  for (const w of workspaces) w.children.sort(sortByActivity);
  workspaces.sort(sortByActivity);
  standaloneGit.sort(sortByActivity);

  const top: TreeNode[] = [...workspaces, ...standaloneGit];

  // Automation (bot worktrees) — its own group, above untracked, default-off in
  // the UI so it never buries real projects even at 9k+ sessions.
  if (automation.length > 0) {
    automation.sort(sortByActivity);
    top.push({
      id: 'automation:all',
      name: 'Automation (bot worktrees)',
      count: 0,
      totalCount: automation.reduce((s, n) => s + n.totalCount, 0),
      children: automation,
      source: 'automation',
      lastMtime: automation.reduce((m, n) => Math.max(m, n.lastMtime ?? 0), 0),
    });
  }

  if (untracked.length > 0) {
    untracked.sort(sortByActivity);
    top.push({
      id: 'untracked:all',
      name: `Untracked locations (${untracked.length})`,
      count: 0,
      totalCount: untracked.reduce((s, n) => s + n.totalCount, 0),
      children: untracked,
      source: 'untracked',
      lastMtime: untracked.reduce((m, n) => Math.max(m, n.lastMtime ?? 0), 0),
    });
  }

  return top;
}

function isUserWorkspace(id: string, cfg: ProjectsConfig): boolean {
  return (cfg.projects || []).some(p => p.id === id && p.workspace);
}

/* -----------------------------------------------------------------------
 * GET /api/projects/:id/dossier
 * --------------------------------------------------------------------- */

router.get('/:id/dossier', async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const md = await buildProjectDossier(id, {
      recentSessionLimit: numParam(req.query.sessions, 10),
      taskLimit: numParam(req.query.tasks, 20),
      planLimit: numParam(req.query.plans, 20),
    });
    res.json({ project_id: id, markdown: md });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* -----------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------- */

async function listProjectsSummary(): Promise<ProjectSummaryRow[]> {
  const store = await createStore();
  try {
    return await store.listProjectsSummary();
  } finally {
    await store.close();
  }
}

function annotate(s: ProjectSummaryRow, cfg: ProjectsConfig): AggregatedProject {
  const { source, displayName } = parseProjectId(s.project_id);

  // Check whether the user config considers this a workspace or has it
  // listed as a sub-project under a parent.
  let workspaceId: string | undefined;
  let isWorkspace = source === 'auto-workspace';
  for (const proj of cfg.projects || []) {
    if (proj.id === s.project_id && proj.workspace) {
      isWorkspace = true;
    }
    // Sub-project id convention: "<parent>/<child>"
    if (s.project_id.startsWith(proj.id + '/')) {
      workspaceId = proj.id;
    }
  }

  return {
    project_id: s.project_id,
    display_name: cfgDisplayNameOverride(s.project_id, cfg) || displayName,
    source,
    items: s.items,
    last_mtime: s.last_mtime,
    workspace_id: workspaceId,
    is_workspace: isWorkspace,
  };
}

function cfgDisplayNameOverride(projectId: string, cfg: ProjectsConfig): string | null {
  for (const proj of cfg.projects || []) {
    if (proj.id === projectId && proj.name) return proj.name;
    for (const child of proj.children || []) {
      if (`${proj.id}/${child.id}` === projectId && child.name) return child.name;
    }
  }
  return null;
}

function parseProjectId(id: string): {
  source: AggregatedProject['source'];
  displayName: string;
} {
  let m = /^git:([^/]+)\/([^/]+)\/(.+)$/.exec(id);
  if (m) return { source: 'git-remote', displayName: m[3] };
  m = /^ws:(.+)$/.exec(id);
  if (m) return { source: 'auto-workspace', displayName: m[1] };
  m = /^git-local:(.+)$/.exec(id);
  if (m) return { source: 'git-local', displayName: `local ${m[1]}` };
  m = /^path:(.+)$/.exec(id);
  if (m) {
    const segs = m[1].split('/').filter(Boolean);
    return { source: 'path', displayName: segs[segs.length - 1] || m[1] };
  }
  return { source: 'user', displayName: id };
}

function validateConfig(cfg: ProjectsConfig): void {
  if (!Array.isArray(cfg.projects || [])) throw new Error('projects must be an array');
  for (const p of cfg.projects || []) {
    if (!p.id || typeof p.id !== 'string') throw new Error('project.id required');
    if (!p.root || typeof p.root !== 'string') throw new Error('project.root required');
    if (p.children) {
      for (const c of p.children) {
        if (!c.id || !c.path) throw new Error(`project ${p.id}: each child needs id+path`);
      }
    }
  }
  if (cfg.ignore) {
    for (const r of cfg.ignore) {
      if (!r.match || typeof r.match !== 'string') throw new Error('ignore.match must be string');
    }
  }
}

/**
 * Mini backfill — same logic as scripts/backfill-project-id.ts but
 * called in-process so the PUT response can report how many rows
 * actually changed. Idempotent.
 */
function runBackfill(): number {
  const db = new Database(getCacheDbPath());
  try {
    try { db.exec(`ALTER TABLE memory_metadata ADD COLUMN project_id TEXT NOT NULL DEFAULT '';`); } catch { /* exists */ }

    const rows = db.prepare(
      `SELECT project_path, project_id
       FROM memory_metadata
       WHERE project_path <> ''
       GROUP BY project_path`,
    ).all() as Array<{ project_path: string; project_id: string }>;

    const update = db.prepare(`UPDATE memory_metadata SET project_id = ? WHERE project_path = ?`);
    let changed = 0;
    const txn = db.transaction(() => {
      for (const r of rows) {
        const resolved = resolveProjectId(r.project_path);
        const newId = resolved.source === 'ignored' || !resolved.id ? '' : resolved.id;
        if (newId === r.project_id) continue;
        const result = update.run(newId, r.project_path);
        changed += result.changes;
      }
    });
    txn();
    return changed;
  } finally {
    db.close();
  }
}

function numParam(q: unknown, def: number): number {
  if (typeof q === 'string') {
    const n = Number(q);
    return Number.isFinite(n) ? n : def;
  }
  return def;
}

export default router;
