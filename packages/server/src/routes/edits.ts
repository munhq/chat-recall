/**
 * Edits timeline routes — chronological view of file activity across
 * recent sessions, sourced from live transcript scans so the active
 * session shows up without waiting for a re-index.
 */

import express from 'express';
import { cachedRecentEdits } from '../imports.js';
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

export default router;
