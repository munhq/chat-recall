/**
 * Code-intelligence routes — the server surface for the codeindex merge.
 *
 * The local CLI (`chat-recall code index`) runs the collector on the user's
 * machine (it needs the repo's files + git history) and POSTs the result here;
 * the dashboard reads it back. Tenant comes from tenantAuth (ct_ agent token →
 * tenant, runWithTenant), so every store call is RLS-scoped automatically.
 *
 * Ingest is replace-semantics per project (findings/hotspots wholesale; actions
 * upsert-preserving-user-state) — exactly what the store methods implement.
 */

import express from 'express';
import { gunzipSync } from 'zlib';
import { createStore, buildRecommendations, createOutcomeCache, cachedRecentEdits, detectTool } from '../imports.js';
import type {
  CodeProjectInput, CodeFindingInput, CodeHotspotInput, CodeActionInput,
  CodeProjectLabel, CodeActionStatus, CodeSeverity, BehaviorSignal, SourceType,
} from '@chat-recall/engine';
import { openPgPoolRo, tenantQuery } from '@chat-recall/engine/core/store/pg-pool.js';
import {
  isCodeTaskStatus, codeTaskToStatus, statusToCodeTask, type CodeTaskStatus,
} from '@chat-recall/engine/core/code-task-status.js';
import { hydrateSessions } from '../services/sessions.js';
import type { SessionIndexEntry } from '../services/sessions.js';
import { isServerMode } from '../util/mode.js';
import { TenantTtlCache } from '../util/tenant-cache.js';

const router = express.Router();

const LABELS = new Set(['poc', 'production', 'engineering']);
const ACTION_STATUS = new Set(['suggested', 'queued', 'done', 'dismissed']);

// POST /api/code/index — ingest a full collector run for one project.
// Body: { project, findings[], hotspots[], actions[] }
router.post('/index', async (req, res) => {
  const body = req.body ?? {};
  const project = body.project as CodeProjectInput | undefined;
  if (!project || !project.projectId) {
    return res.status(400).json({ error: 'project (with projectId) is required' });
  }
  const findings = Array.isArray(body.findings) ? (body.findings as CodeFindingInput[]) : [];
  const hotspots = Array.isArray(body.hotspots) ? (body.hotspots as CodeHotspotInput[]) : [];
  const actions = Array.isArray(body.actions) ? (body.actions as CodeActionInput[]) : [];
  const store = await createStore();
  try {
    await store.upsertCodeProject(project);
    const f = await store.replaceCodeFindings(project.projectId, findings);
    const h = await store.replaceCodeHotspots(project.projectId, hotspots);
    const a = await store.upsertCodeActions(project.projectId, actions);
    res.json({ ok: true, projectId: project.projectId, findings: f, hotspots: h, actions: a });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'code index ingest failed' });
  } finally {
    await store.close();
  }
});

// GET /api/code/projects — all indexed projects (newest first).
router.get('/projects', async (_req, res) => {
  const store = await createStore();
  try { res.json({ projects: await store.listCodeProjects() }); }
  catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

// GET /api/code/projects/:id — one project (root, counts, health, map blob).
router.get('/projects/:id', async (req, res) => {
  const store = await createStore();
  try {
    const p = await store.getCodeProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'project not indexed' });
    res.json(p);
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

// DELETE /api/code/projects/:id — remove a project + its findings/hotspots/actions
// (clears it from the dashboard). Excluding it from future scans is a local
// concern handled by the CLI/daemon registry.
router.delete('/projects/:id', async (req, res) => {
  const store = await createStore();
  try {
    const ok = await store.deleteCodeProject(req.params.id);
    if (!ok) return res.status(404).json({ error: 'project not indexed' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

// GET /api/code/summary?project= — findings counts by severity + category.
router.get('/summary', async (req, res) => {
  const projectId = typeof req.query.project === 'string' ? req.query.project : undefined;
  const store = await createStore();
  try { res.json(await store.codeFindingsSummary(projectId)); }
  catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

// GET /api/code/findings?project=&severity=&category=&limit=
router.get('/findings', async (req, res) => {
  const projectId = typeof req.query.project === 'string' ? req.query.project : undefined;
  const severity = typeof req.query.severity === 'string' ? (req.query.severity as CodeSeverity) : undefined;
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
  const store = await createStore();
  try { res.json({ findings: await store.listCodeFindings(projectId, { severity, category, limit }) }); }
  catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

// GET /api/code/hotspots?project=&limit=
router.get('/hotspots', async (req, res) => {
  const projectId = typeof req.query.project === 'string' ? req.query.project : undefined;
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
  const store = await createStore();
  try { res.json({ hotspots: await store.listCodeHotspots(projectId, limit) }); }
  catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

// GET /api/code/file-sessions?project=<projectId>&file=<repo-relative path>
//
// The behaviour×code correlation: which sessions actually touched this file.
// Turns a hotspot/finding from a bare assertion into a navigable cause —
// each returned session carries its outcome + title, and the UI links
// through to the conversation.
//
// Matching: hotspots/findings store repo-relative paths; the synced diff
// rows (compute_cache[kind='diff']) store the session's absolute local
// paths. A session matches when any edited path ends with "/<file>" (or
// equals it). Scoped to the project's own sessions first, so the payload
// pass touches a few hundred rows, not the tenant's whole cache.
const fileSessionsCache = new TenantTtlCache<{ sessions: unknown[] }>(60_000, 128);

/** Does this diff payload (json or gz) contain an edit to `file`? */
function diffTouchesFile(payloadJson: string | null, payloadGz: Buffer | null, file: string): boolean {
  let raw = payloadJson;
  if (!raw && payloadGz) {
    try { raw = gunzipSync(payloadGz).toString('utf-8'); } catch { return false; }
  }
  if (!raw) return false;
  // Cheap reject before JSON.parse — the path must at least appear as a substring.
  if (!raw.includes(file)) return false;
  try {
    const diff = JSON.parse(raw) as { files?: Array<{ file?: string }> };
    return (diff.files ?? []).some((f) => typeof f.file === 'string' && (f.file === file || f.file.endsWith('/' + file)));
  } catch { return false; }
}

router.get('/file-sessions', async (req, res) => {
  const projectId = typeof req.query.project === 'string' ? req.query.project : '';
  const file = typeof req.query.file === 'string' ? req.query.file.trim() : '';
  if (!projectId || !file) return res.status(400).json({ error: 'project and file are required' });
  const limit = Math.max(1, Math.min(parseInt(String(req.query.limit)) || 8, 25));

  const cacheKey = `${projectId}|${file}|${limit}`;
  const hit = fileSessionsCache.get(cacheKey);
  if (hit) return res.json(hit);

  const store = await createStore();
  try {
    // The project's sessions, newest first — the candidate set.
    const rows = await store.listItemsByProjectId('session' as SourceType, projectId, 500);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const matched: string[] = [];

    if (isServerMode() && byId.size > 0) {
      // Synced diff rows, one batched read for the whole candidate set.
      const tenant = (req as { tenant?: string }).tenant || 'default';
      const pool = await openPgPoolRo();
      const cc = (await tenantQuery(
        pool, tenant,
        `SELECT session_id, payload_json, payload_gz FROM compute_cache
          WHERE tenant=$1 AND kind='diff' AND session_id = ANY($2)`,
        [tenant, [...byId.keys()]],
      )).rows as Array<{ session_id: string; payload_json: string | null; payload_gz: Buffer | null }>;
      for (const r of cc) {
        if (diffTouchesFile(r.payload_json, r.payload_gz, file)) matched.push(r.session_id);
      }
    } else {
      // Local mode: the cached timeline reads the same diff rows from the
      // local cache.db and live-scans the active session.
      const edits = await cachedRecentEdits({
        sinceMs: Date.now() - 180 * 86_400_000,
        pattern: file,
        liveFallback: true,
      });
      const seen = new Set<string>();
      for (const e of edits) {
        if (!(e.file === file || e.file.endsWith('/' + file))) continue;
        if (byId.size > 0 && !byId.has(e.sessionId)) continue;
        if (!seen.has(e.sessionId)) { seen.add(e.sessionId); matched.push(e.sessionId); }
      }
    }

    // Newest first, then hydrate the top slice (titles + outcomes).
    matched.sort((a, b) => (byId.get(b)?.mtime ?? 0) - (byId.get(a)?.mtime ?? 0));
    const entries: SessionIndexEntry[] = matched.slice(0, limit).map((id) => {
      const m = byId.get(id);
      let extra: Record<string, unknown> = {};
      try { extra = m?.extra_json ? JSON.parse(m.extra_json) : {}; } catch { /* tool falls back */ }
      return {
        sessionId: id,
        projectPath: m?.project_path || '',
        projectId: m?.project_id || projectId,
        mtime: m?.mtime || 0,
        tool: (extra.tool as SessionIndexEntry['tool']) || detectTool(id) as SessionIndexEntry['tool'],
        filePath: m?.file_path || undefined,
        preIndexedFirstPrompt: m?.content_preview || undefined,
      };
    });
    const sessions = await hydrateSessions(entries);
    const body = { file, project: projectId, total: matched.length, sessions };
    fileSessionsCache.set(cacheKey, body);
    res.json(body);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'failed' });
  } finally {
    await store.close();
  }
});

// GET /api/code/actions?project=&status=&queued=&limit=
router.get('/actions', async (req, res) => {
  const projectId = typeof req.query.project === 'string' ? req.query.project : undefined;
  const status = typeof req.query.status === 'string' ? (req.query.status as CodeActionStatus) : undefined;
  const queued = req.query.queued === undefined ? undefined : String(req.query.queued) === 'true';
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
  const store = await createStore();
  try { res.json({ actions: await store.listCodeActions(projectId, { status, queued, limit }) }); }
  catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

// PATCH /api/code/actions/:id — { status?, queued? } (the tasks-pill mutation).
router.patch('/actions/:id', async (req, res) => {
  const { status, queued } = req.body ?? {};
  if (status !== undefined && !ACTION_STATUS.has(status)) {
    return res.status(400).json({ error: `status must be one of ${[...ACTION_STATUS].join(', ')}` });
  }
  const store = await createStore();
  try {
    const ok = await store.setCodeActionStatus(req.params.id, (status ?? 'queued') as CodeActionStatus,
      typeof queued === 'boolean' ? queued : undefined);
    if (!ok) return res.status(404).json({ error: 'action not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

// GET /api/code/recommendations?project= — behavior × code → actionable recommendations.
router.get('/recommendations', async (req, res) => {
  const projectId = typeof req.query.project === 'string' ? req.query.project : '';
  if (!projectId) return res.status(400).json({ error: 'project is required' });
  const store = await createStore();
  try {
    const project = await store.getCodeProject(projectId);
    if (!project) return res.status(404).json({ error: 'project not indexed' });
    const [summary, findings, hotspots] = await Promise.all([
      store.codeFindingsSummary(projectId),
      store.listCodeFindings(projectId, { limit: 500 }),
      store.listCodeHotspots(projectId, 50),
    ]);
    // Behavioral signal: outcomes of this project's own sessions (the other half
    // of the moat). Optional — empty when no sessions are synced for the project.
    let behavior: BehaviorSignal | undefined;
    try {
      const sessions = await store.listItemsByProjectId('session', projectId, 200);
      const ids = sessions.map((s) => s.id);
      if (ids.length) {
        const oc = await createOutcomeCache();
        try {
          const rows = await oc.getMany(ids);
          let failed = 0;
          // 'interrupted' = the user bailed before resolution — our unresolved signal.
          for (const [, r] of rows) if (r && r.status === 'interrupted') failed++;
          behavior = { failedOrAbandoned: failed, totalSessions: ids.length };
        } finally { await oc.close(); }
      }
    } catch { /* behavioral signal is optional */ }
    const recommendations = buildRecommendations({ project, summary, findings, hotspots, behavior });
    res.json({ recommendations, behavior: behavior ?? null });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

// POST /api/code/tasks/write — { project }
// Materialise the queued tasks as CODE_TASKS.md in the repo (via the local
// agent), so the user can point Claude Code at it: "do the tasks in
// CODE_TASKS.md". Far more usable than copy/paste.
function buildTasksMd(projectId: string, actions: Array<{ id: string; pri: number; category: string; title: string; fix: string; agentPrompt: string; status: string }>): string {
  const head = `# CODE_TASKS.md — ${projectId}\n\n` +
    `> Generated by chat-recall. Investigate and complete the tasks below. Use the codeindex MCP tools ` +
    `(find_callers, get_change_impact, get_imported_by, find_symbol) to verify before editing. Tackle them in priority order; show diffs.\n>\n` +
    `> **To update a task:** change its \`status:\` from \`todo\` to \`done\` (or \`dismissed\`) and tick the box. Your edits sync to the ` +
    `dashboard on the next \`chat-recall sync\`. The \`<!-- cr-task … -->\` markers are machine anchors — **leave them intact.**\n\n`;
  const body = actions.map((a, i) => {
    const token = statusToCodeTask(a.status);
    const checked = token === 'done' || token === 'dismissed';
    return `## ${i + 1}. [P${a.pri} · ${a.category}] ${a.title}\n\n${a.fix}\n\n\`\`\`\n${a.agentPrompt}\n\`\`\`\n\n` +
      `- [${checked ? 'x' : ' '}] status: \`${token}\` — implement, then set \`done\` (or \`dismissed\`) <!-- cr-task kind=code id=${a.id} was=${token} -->\n`;
  }).join('\n');
  return head + body + '\n';
}
router.post('/tasks/write', async (req, res) => {
  const projectId = typeof req.body?.project === 'string' ? req.body.project : '';
  if (!projectId) return res.status(400).json({ error: 'project is required' });
  const store = await createStore();
  try {
    const project = await store.getCodeProject(projectId);
    if (!project) return res.status(404).json({ error: 'project not indexed' });
    // Include every actionable task (suggested + queued + done), not just queued
    // — the collector's suggestions are now trustworthy, so the file IS the
    // worklist. Only dismissed items are hidden.
    const actions = (await store.listCodeActions(projectId, { limit: 200 }))
      .filter((a) => a.status !== 'dismissed').sort((a, b) => a.pri - b.pri);
    if (!actions.length) return res.json({ ok: true, queued: false, message: 'No actionable code tasks. Run `chat-recall code index` in the repo to generate them.' });
    const content = buildTasksMd(project.projectId, actions);
    const intentId = await store.enqueueSyncIntent({
      kind: 'code_apply', artifactType: 'write_tasks_file',
      name: JSON.stringify({ rootPath: project.rootPath, filename: 'CODE_TASKS.md', content }),
      createdBy: 'code-tasks',
    });
    res.json({ ok: true, queued: true, intentId, filename: 'CODE_TASKS.md', count: actions.length, message: 'Queued — your local agent writes CODE_TASKS.md to the repo (≤45s). Then tell your AI: "Read CODE_TASKS.md and complete the tasks."' });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

// GET /api/code/tasks/tracked — filesystem rootPaths of code projects that have
// queued tasks. The CLI checks each for a CODE_TASKS.md to read back.
router.get('/tasks/tracked', async (_req, res) => {
  const store = await createStore();
  try {
    const projects = await store.listCodeProjects();
    const out: string[] = [];
    for (const p of projects) {
      if (!p.rootPath) continue;
      const actionable = (await store.listCodeActions(p.projectId, { limit: 100 })).some((a) => a.status !== 'dismissed');
      if (actionable) out.push(p.rootPath);
    }
    res.json({ projects: [...new Set(out)].sort() });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

// POST /api/code/tasks/status — { project?, items: [{id, status}] }
// The file→server half of the two-way sync for code tasks. The CLI parses
// CODE_TASKS.md and posts each task's id + status token; we map the token to the
// action status/queued and persist. Idempotent; unknown/invalid ids are reported.
router.post('/tasks/status', express.json(), async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: 'items[] is required' });
  const store = await createStore();
  try {
    let applied = 0; const unknown: string[] = []; let invalid = 0;
    for (const it of items) {
      const id = typeof it?.id === 'string' ? it.id : '';
      const status = it?.status;
      if (!id || !isCodeTaskStatus(status)) { invalid++; continue; }
      const mapped = codeTaskToStatus(status as CodeTaskStatus);
      const ok = await store.setCodeActionStatus(id, mapped.status, mapped.queued);
      if (!ok) { unknown.push(id); continue; }
      applied++;
    }
    res.json({ ok: true, applied, unknown, unknownCount: unknown.length, invalid });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

// POST /api/code/recommendations/:id/apply — { project }
// set_label applies immediately (server-side). Local actions (append a CLAUDE.md
// rule, install a skill) enqueue a sync_intent the user's machine agent drains
// and executes — same rail as toolkit sync. reset_db is never auto-run.
router.post('/recommendations/:id/apply', async (req, res) => {
  const projectId = typeof req.body?.project === 'string' ? req.body.project : '';
  if (!projectId) return res.status(400).json({ error: 'project is required' });
  const store = await createStore();
  try {
    const project = await store.getCodeProject(projectId);
    if (!project) return res.status(404).json({ error: 'project not indexed' });
    const [summary, findings, hotspots] = await Promise.all([
      store.codeFindingsSummary(projectId),
      store.listCodeFindings(projectId, { limit: 500 }),
      store.listCodeHotspots(projectId, 50),
    ]);
    const recs = buildRecommendations({ project, summary, findings, hotspots });
    const rec = recs.find((r) => r.id === req.params.id);
    if (!rec) return res.status(404).json({ error: 'recommendation not found (re-fetch; it may have changed)' });

    if (rec.action.type === 'set_label') {
      await store.setCodeProjectLabel(projectId, (rec.action.payload.label as any) ?? null);
      return res.json({ ok: true, applied: true, message: `Project labelled ${rec.action.payload.label}.` });
    }
    if (rec.action.type === 'reset_db') {
      // Destructive — never auto-run. Surface guidance instead.
      return res.json({ ok: true, applied: false, message: 'POC db reset is destructive — run it yourself (e.g. docker compose down -v && up).' });
    }
    if (rec.action.type === 'install_skill') {
      return res.json({ ok: true, applied: false, message: `Install the ${rec.action.payload.skill} skill, then re-sync.` });
    }
    if (rec.action.type === 'open_findings') {
      return res.json({ ok: true, applied: false, message: 'Open the Structure tab to review these.' });
    }
    // append_claude_md → hand to the local agent (it has the repo's CLAUDE.md).
    const id = await store.enqueueSyncIntent({
      kind: 'code_apply',
      artifactType: rec.action.type,
      name: JSON.stringify({ recId: rec.id, projectId, rootPath: project.rootPath, payload: rec.action.payload }),
      createdBy: 'code-recommendation',
    });
    res.json({ ok: true, queued: true, intentId: id, message: 'Queued for your machine — the local agent appends the rule to this project\'s CLAUDE.md on next drain (≤45s).' });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

// PATCH /api/code/projects/:id/label — { label: poc|production|engineering|null }
router.patch('/projects/:id/label', async (req, res) => {
  const { label } = req.body ?? {};
  if (label !== null && !LABELS.has(label)) {
    return res.status(400).json({ error: `label must be null or one of ${[...LABELS].join(', ')}` });
  }
  const store = await createStore();
  try {
    const ok = await store.setCodeProjectLabel(req.params.id, (label ?? null) as CodeProjectLabel | null);
    if (!ok) return res.status(404).json({ error: 'project not indexed' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
  finally { await store.close(); }
});

export default router;
