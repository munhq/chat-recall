/**
 * Edits timeline routes — chronological view of file activity across
 * recent sessions, sourced from live transcript scans so the active
 * session shows up without waiting for a re-index.
 */

import express from 'express';
import { cachedRecentEdits, createStore, createMetadataCache } from '../imports.js';
import type { SessionEdit } from '../imports.js';

/**
 * Display label for the repo/project a set of edits belongs to. Keys off the
 * logical project_id (`git:host/owner/repo`, `ws:name`, `path:…`) the collector
 * ships and the sidebar uses — NOT a `.git` filesystem walk, which was
 * meaningless on the server (synced paths don't exist on the pod, so every row
 * collapsed to "(no repo)"). Falls back to the path basename for untyped ids.
 */
function repoLabel(projectId: string | undefined, projectPath: string): { key: string; name: string } {
  const pid = projectId || '';
  if (pid.startsWith('git:')) {
    const seg = pid.split('/').filter(Boolean);
    return { key: pid, name: seg[seg.length - 1] || pid };
  }
  if (pid.startsWith('ws:')) return { key: pid, name: pid.slice(3) };
  const base = (projectPath || '').split('/').filter(Boolean).pop();
  return { key: pid || projectPath || '(unknown)', name: base || pid || '(unknown)' };
}
import { isServerMode } from '../util/mode.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { TenantTtlCache } from '../util/tenant-cache.js';

const log = createLogger('edits');

const router = express.Router();

/**
 * In-process TTL cache for `liveScanRecentEdits`. The scan walks every
 * recent JSONL across all 4 tools to extract Edit/Write/Read tool calls
 * — ~250ms per call. Caching the raw scan output for 30s collapses the
 * activity panel's repeated queries (filter changes, repo grouping
 * toggles, polling) into one walk per minute.
 *
 * Cache key buckets the since-time to the nearest minute so requests
 * within the same window share an entry rather than each second being a
 * unique key. Filtering / sorting / grouping happens on the cached list
 * after lookup, so different filter combos still share the underlying
 * scan output.
 */
// Tenant-scoped (TenantTtlCache prefixes the ambient tenant): the compound
// key below deliberately does NOT need to include the tenant itself — a plain
// Map here once served tenant A's edit timeline to tenant B for 30s.
const timelineCache = new TenantTtlCache<SessionEdit[]>(30_000, 64);

async function getCachedTimeline(opts: {
  sinceMs: number;
  pattern?: string;
  projectFilter?: string;
  tools?: ReadonlyArray<string>;
}): Promise<SessionEdit[]> {
  const sinceBucket = Math.floor(opts.sinceMs / 60_000);
  const key = `${sinceBucket}|${opts.pattern || ''}|${opts.projectFilter || ''}|${(opts.tools || []).slice().sort().join(',')}`;
  const hit = timelineCache.get(key);
  if (hit) return hit;

  // Cache-first: pulls events from compute_cache[diff] for any session
  // whose cached row is fresh (mtime matches memory_metadata). Falls
  // back to a live transcript scan only for sessions whose cache is
  // missing or stale (typically just the actively-running session).
  const data = await cachedRecentEdits({
    sinceMs: opts.sinceMs,
    pattern: opts.pattern,
    projectFilter: opts.projectFilter,
    tools: opts.tools as ('claude' | 'agy' | 'gemini' | 'opencode' | 'codex')[] | undefined,
    // Server deployments serve synced diff rows only — never live-scan the
    // server host's own filesystem.
    liveFallback: !isServerMode(),
  });
  timelineCache.set(key, data);
  return data;
}

// GET /api/edits/timeline?since_hours=24&limit=200&pattern=foo&project=chat-recall
//        &include_reads=false&tools=claude,opencode,gemini&group_by_repo=true
router.get('/timeline', async (req, res) => {
  try {
    const sinceHoursRaw = req.query.since_hours as string | undefined;
    const sinceHours = sinceHoursRaw ? Number(sinceHoursRaw) : 24;
    if (!Number.isFinite(sinceHours) || sinceHours <= 0) {
      return res.status(400).json({ error: 'since_hours must be a positive number' });
    }

    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 200, 1000));
    const pattern = (req.query.pattern as string | undefined)?.trim() || undefined;
    const projectFilter = (req.query.project as string | undefined)?.trim() || undefined;
    const includeReads = (req.query.include_reads as string | undefined) === 'true';
    const groupByRepo = (req.query.group_by_repo as string | undefined) === 'true';

    const validTools = ['claude', 'agy', 'gemini', 'opencode', 'codex'] as const;
    type AiTool = typeof validTools[number];
    const toolsParam = (req.query.tools as string | undefined)?.trim();
    const tools: AiTool[] | undefined = toolsParam
      ? (toolsParam.split(',').map(t => t.trim().toLowerCase()).filter(t => (validTools as readonly string[]).includes(t)) as AiTool[])
      : undefined;

    const sinceMs = Date.now() - sinceHours * 3600 * 1000;
    const all = await getCachedTimeline({ sinceMs, pattern, projectFilter, tools });
    const filtered = includeReads ? all : all.filter(e => e.op !== 'read');
    const trimmed = filtered.slice(0, limit);

    // Per-tool tally so the UI can render a "1k claude · 200 gemini · 80 opencode" header.
    const byTool: Record<string, number> = {};
    for (const e of filtered) byTool[e.tool] = (byTool[e.tool] || 0) + 1;

    // Per-project tally — drives the Activity view's project tree so it
    // shows ONLY projects with edits in the current window (instead of
    // the all-time list from `getStatus`, which goes stale).
    const byProject: Record<string, number> = {};
    for (const e of filtered) {
      const p = e.projectPath;
      if (!p) continue;
      byProject[p] = (byProject[p] || 0) + 1;
    }

    const enriched = trimmed.map(e => {
      const { key, name } = repoLabel(e.projectId, e.projectPath);
      return {
        ts: e.ts,
        tsIso: e.tsIso,
        sessionId: e.sessionId,
        projectPath: e.projectPath,
        projectId: e.projectId || null,
        repoRoot: key,
        repoName: name,
        file: e.file,
        op: e.op,
        toolName: e.toolName,
        tool: e.tool,
        line: e.line,
      };
    });

    let byRepo: Record<string, { name: string; count: number; sample: string }> | undefined;
    if (groupByRepo) {
      byRepo = {};
      for (const e of filtered) {
        const { key, name } = repoLabel(e.projectId, e.projectPath);
        if (!byRepo[key]) byRepo[key] = { name, count: 0, sample: e.file };
        byRepo[key].count++;
      }
    }

    res.json({
      sinceHours,
      total: filtered.length,
      truncated: filtered.length > trimmed.length,
      byTool,
      byProject,
      byRepo,
      edits: enriched,
    });
  } catch (error) {
    log.error({ err: error }, 'edits timeline error');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to build edits timeline',
    });
  }
});

// ── Activity summary — the "work rhythm" aggregation the rebuilt Activity view
// renders. One tenant-scoped call: pulse (edit intensity over time), per-project
// churn (files, ±lines, sessions, outcome mix, sparkline, hot files), global hot
// files, and titled session rows with outcomes. Aggregated from the (cached)
// edits timeline + per-session compute_cache diff/outcome + metadata title.
// Read ops excluded — this view is about changes.
interface ActivitySummary {
  window: { sinceHours: number; from: number; to: number };
  pulse: Array<{ bucket: number; edits: number; sessions: number }>;
  totals: { sessions: number; files: number; linesAdded: number; linesRemoved: number; shipped: number; interrupted: number; abandoned: number; inProgress: number };
  projects: Array<{ id: string; name: string; files: number; linesAdded: number; linesRemoved: number; sessions: number; outcomes: { shipped: number; interrupted: number; abandoned: number; inProgress: number }; sparkline: number[]; hotFiles: Array<{ file: string; edits: number }> }>;
  hotFiles: Array<{ file: string; project: string; edits: number }>;
  sessions: Array<{ id: string; title: string; tool: string; project: string; outcome: string; files: number; linesAdded: number; linesRemoved: number; mtime: number }>;
}
const summaryCache = new TenantTtlCache<ActivitySummary>(30_000, 16);
const MAX_ENRICH_SESSIONS = 400; // bound the per-session compute reads per call

// The metadata title is derived from the first prompt, which for some sessions
// is Claude Code local-command plumbing (`<local-command-caveat>`, `/model`…).
// Strip it so session rows read as real work, not tooling noise.
const CMD_NOISE = [
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<[^>]*command[^>]*>/g,
  // The bare caveat text (tags already stripped upstream on some rows) — nuke
  // from the phrase to the end; it's always a leading prefix, never real content.
  /Caveat: The messages below were generated by the user[\s\S]*/i,
  /\[Request interrupted[^\]]*\]/gi,      // interrupt marker leaking as a title
  /[─-╿]{3,}/g,                  // long runs of box-drawing separators
];
function cleanTitle(t: string): string {
  let s = t || '';
  for (const re of CMD_NOISE) s = s.replace(re, ' ');
  return s.replace(/\s{2,}/g, ' ').trim();
}

// GET /api/edits/summary?since_hours=168&project=&tools=claude,opencode
router.get('/summary', async (req, res) => {
  try {
    const sinceHoursRaw = req.query.since_hours as string | undefined;
    const sinceHours = sinceHoursRaw ? Number(sinceHoursRaw) : 168;
    if (!Number.isFinite(sinceHours) || sinceHours <= 0) return res.status(400).json({ error: 'since_hours must be a positive number' });
    const projectFilter = (req.query.project as string | undefined)?.trim() || undefined;
    const validTools = ['claude', 'agy', 'gemini', 'opencode', 'codex'] as const;
    const toolsParam = (req.query.tools as string | undefined)?.trim();
    const tools = toolsParam ? (toolsParam.split(',').map(t => t.trim().toLowerCase()).filter(t => (validTools as readonly string[]).includes(t))) : undefined;

    const sinceMs = Date.now() - sinceHours * 3600 * 1000;
    const cacheKey = `${Math.floor(sinceMs / 60_000)}|${projectFilter || ''}|${(tools || []).slice().sort().join(',')}`;
    const cached = summaryCache.get(cacheKey);
    if (cached) return res.json(cached);

    const edits = (await getCachedTimeline({ sinceMs, projectFilter, tools }))
      .filter(e => e.op !== 'read'); // changes only

    // Bucket the window for the pulse heatmap + per-project sparklines:
    // hourly for short windows, daily for long ones. Build the full ordered
    // bucket list so gaps render as empty (not collapsed).
    const bucketMs = sinceHours <= 48 ? 3600_000 : 86400_000;
    const now = Date.now();
    const firstBucket = Math.floor(sinceMs / bucketMs) * bucketMs;
    const lastBucket = Math.floor(now / bucketMs) * bucketMs;
    const buckets: number[] = [];
    for (let b = firstBucket; b <= lastBucket && buckets.length < 800; b += bucketMs) buckets.push(b);

    const pulse = new Map<number, { edits: number; sessions: Set<string> }>();
    const S = new Map<string, { edits: number; files: Set<string>; last: number; projectKey: string; tool: string }>();
    const P = new Map<string, { name: string; edits: number; files: Set<string>; sessions: Set<string>; hot: Map<string, number>; spark: Map<number, number> }>();
    const hot = new Map<string, { project: string; edits: number }>();

    for (const e of edits) {
      const b = Math.floor(e.ts / bucketMs) * bucketMs;
      const pm = pulse.get(b) ?? { edits: 0, sessions: new Set() }; pm.edits++; pm.sessions.add(e.sessionId); pulse.set(b, pm);
      const s = S.get(e.sessionId) ?? { edits: 0, files: new Set(), last: 0, projectKey: e.projectId || e.projectPath || '', tool: e.tool };
      s.edits++; s.files.add(e.file); s.last = Math.max(s.last, e.ts); S.set(e.sessionId, s);
      const pid = e.projectId || e.projectPath || '(unknown)';
      const { name } = repoLabel(e.projectId, e.projectPath);
      const p = P.get(pid) ?? { name, edits: 0, files: new Set(), sessions: new Set(), hot: new Map(), spark: new Map() };
      p.edits++; p.files.add(e.file); p.sessions.add(e.sessionId);
      p.hot.set(e.file, (p.hot.get(e.file) || 0) + 1); p.spark.set(b, (p.spark.get(b) || 0) + 1); P.set(pid, p);
      const h = hot.get(e.file) ?? { project: name, edits: 0 }; h.edits++; hot.set(e.file, h);
    }

    // Enrich the most-recent sessions with lines± (compute[diff]), outcome
    // (compute[outcome]) and title (metadata). Bounded per call.
    const store = await createStore();
    const metaCache = await createMetadataCache();
    const linesBy = new Map<string, { a: number; r: number }>();
    const outcomeBy = new Map<string, string>();
    const sessions: ActivitySummary['sessions'] = [];
    try {
      const ids = [...S.keys()].sort((a, b) => S.get(b)!.last - S.get(a)!.last).slice(0, MAX_ENRICH_SESSIONS);
      for (const id of ids) {
        const s = S.get(id)!;
        let title = '', tool = s.tool, projectKey = s.projectKey;
        try {
          const item = await store.getItem(id, 'session');
          if (item) { title = cleanTitle(item.title || ''); projectKey = item.project_id || item.project_path || projectKey; try { const ex = JSON.parse(item.extra_json || '{}'); if (ex.tool) tool = ex.tool; } catch { /* */ } }
        } catch { /* */ }
        let a = 0, r = 0;
        try { const d = await metaCache.getComputeStale<{ totalLinesAdded?: number; totalLinesRemoved?: number }>(id, 'diff'); a = d?.data?.totalLinesAdded || 0; r = d?.data?.totalLinesRemoved || 0; } catch { /* */ }
        linesBy.set(id, { a, r });
        let status = 'unknown';
        try { const o = await metaCache.getComputeStale<{ status?: string }>(id, 'outcome'); if (o?.data?.status) status = o.data.status; } catch { /* */ }
        outcomeBy.set(id, status);
        sessions.push({ id, title, tool, project: projectKey, outcome: status, files: s.files.size, linesAdded: a, linesRemoved: r, mtime: s.last });
      }
    } finally { await store.close(); await metaCache.close(); }

    const outcomeMix = () => ({ shipped: 0, interrupted: 0, abandoned: 0, inProgress: 0 });
    const addOutcome = (mix: ReturnType<typeof outcomeMix>, status: string | undefined) => {
      if (status === 'shipped') mix.shipped++;
      else if (status === 'interrupted') mix.interrupted++;
      else if (status === 'abandoned') mix.abandoned++;
      else if (status === 'in_progress') mix.inProgress++;
    };

    const projects = [...P.entries()].map(([id, p]) => {
      let la = 0, lr = 0; const outcomes = outcomeMix();
      for (const sid of p.sessions) { const l = linesBy.get(sid); if (l) { la += l.a; lr += l.r; } addOutcome(outcomes, outcomeBy.get(sid)); }
      return {
        id, name: p.name, files: p.files.size, linesAdded: la, linesRemoved: lr, sessions: p.sessions.size, outcomes,
        sparkline: buckets.map(b => p.spark.get(b) || 0),
        hotFiles: [...p.hot.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([file, edits]) => ({ file, edits })),
      };
    }).sort((x, y) => (y.linesAdded + y.linesRemoved) - (x.linesAdded + x.linesRemoved));

    const totals = { sessions: S.size, files: hot.size, linesAdded: 0, linesRemoved: 0, ...outcomeMix() };
    for (const { a, r } of linesBy.values()) { totals.linesAdded += a; totals.linesRemoved += r; }
    { const seen = new Set<string>(); for (const [id] of S) { if (seen.has(id)) continue; seen.add(id); addOutcome(totals, outcomeBy.get(id)); } }

    const result: ActivitySummary = {
      window: { sinceHours, from: sinceMs, to: now },
      pulse: buckets.map(b => ({ bucket: b, edits: pulse.get(b)?.edits || 0, sessions: pulse.get(b)?.sessions.size || 0 })),
      totals,
      projects,
      hotFiles: [...hot.entries()].sort((x, y) => y[1].edits - x[1].edits).slice(0, 15).map(([file, v]) => ({ file, project: v.project, edits: v.edits })),
      sessions,
    };
    summaryCache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    log.error({ err: error }, 'activity summary error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to build activity summary' });
  }
});

export default router;
