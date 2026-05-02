/**
 * Edits timeline routes — chronological view of file activity across
 * recent sessions, sourced from live transcript scans so the active
 * session shows up without waiting for a re-index.
 */

import express from 'express';
import { liveScanRecentEdits, findRepoRoot } from '../imports.js';

const router = express.Router();

// GET /api/edits/timeline?since_hours=24&limit=200&pattern=foo&project=chat-recall
//        &include_reads=false&tools=claude,opencode,gemini&group_by_repo=true
router.get('/timeline', (req, res) => {
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
    const all = liveScanRecentEdits({
      sinceMs,
      pattern,
      projectFilter,
      tools,
    });
    const filtered = includeReads ? all : all.filter(e => e.op !== 'read');
    const trimmed = filtered.slice(0, limit);

    // Per-tool tally so the UI can render a "1k claude · 200 gemini · 80 opencode" header.
    const byTool: Record<string, number> = {};
    for (const e of filtered) byTool[e.tool] = (byTool[e.tool] || 0) + 1;

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
