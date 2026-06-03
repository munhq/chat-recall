/**
 * Edits timeline routes — chronological view of file activity across
 * recent sessions, sourced from live transcript scans so the active
 * session shows up without waiting for a re-index.
 */

import express from 'express';
import { cachedRecentEdits, findRepoRoot } from '../imports.js';
import type { SessionEdit } from '../imports.js';

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
const TIMELINE_CACHE_TTL_MS = 30_000;
const TIMELINE_CACHE_MAX = 64;
const timelineCache = new Map<string, { data: SessionEdit[]; expiresAt: number }>();

async function getCachedTimeline(opts: {
  sinceMs: number;
  pattern?: string;
  projectFilter?: string;
  tools?: ReadonlyArray<string>;
}): Promise<SessionEdit[]> {
  const sinceBucket = Math.floor(opts.sinceMs / 60_000);
  const key = `${sinceBucket}|${opts.pattern || ''}|${opts.projectFilter || ''}|${(opts.tools || []).slice().sort().join(',')}`;
  const now = Date.now();
  const hit = timelineCache.get(key);
  if (hit && hit.expiresAt > now) return hit.data;

  // Cache-first: pulls events from compute_cache[diff] for any session
  // whose cached row is fresh (mtime matches memory_metadata). Falls
  // back to a live transcript scan only for sessions whose cache is
  // missing or stale (typically just the actively-running session).
  const data = await cachedRecentEdits({
    sinceMs: opts.sinceMs,
    pattern: opts.pattern,
    projectFilter: opts.projectFilter,
    tools: opts.tools as ('claude' | 'gemini' | 'opencode' | 'codex')[] | undefined,
  });
  timelineCache.set(key, { data, expiresAt: now + TIMELINE_CACHE_TTL_MS });
  while (timelineCache.size > TIMELINE_CACHE_MAX) {
    const oldest = timelineCache.keys().next().value;
    if (!oldest) break;
    timelineCache.delete(oldest);
  }
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

    const validTools = ['claude', 'gemini', 'opencode'] as const;
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

    // Cache of repo roots so we don't walk the filesystem per edit on a hot path.
    const repoCache = new Map<string, string | null>();
    const resolveRepo = (file: string): string | null => {
      if (repoCache.has(file)) return repoCache.get(file)!;
      const r = findRepoRoot(file);
      repoCache.set(file, r);
      return r;
    };

    const enriched = trimmed.map(e => {
      const repo = resolveRepo(e.file);
      return {
        ts: e.ts,
        tsIso: e.tsIso,
        sessionId: e.sessionId,
        projectPath: e.projectPath,
        repoRoot: repo,
        repoName: repo ? repo.split('/').filter(Boolean).pop() : null,
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
        const repo = resolveRepo(e.file);
        if (!repo) continue;
        const name = repo.split('/').filter(Boolean).pop() || repo;
        if (!byRepo[repo]) byRepo[repo] = { name, count: 0, sample: e.file };
        byRepo[repo].count++;
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
    console.error('Edits timeline error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to build edits timeline',
    });
  }
});

export default router;
