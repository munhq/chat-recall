/**
 * Edits timeline routes — chronological view of file activity across
 * recent sessions, sourced from live transcript scans so the active
 * session shows up without waiting for a re-index.
 */

import express from 'express';
import { liveScanRecentEdits } from '../imports.js';

const router = express.Router();

// GET /api/edits/timeline?since_hours=24&limit=200&pattern=foo&project=chat-recall&include_reads=false
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

    const sinceMs = Date.now() - sinceHours * 3600 * 1000;
    const all = liveScanRecentEdits({
      sinceMs,
      pattern,
      projectFilter,
    });
    const filtered = includeReads ? all : all.filter(e => e.op !== 'read');
    const trimmed = filtered.slice(0, limit);

    res.json({
      sinceHours,
      total: filtered.length,
      truncated: filtered.length > trimmed.length,
      edits: trimmed.map(e => ({
        ts: e.ts,
        tsIso: e.tsIso,
        sessionId: e.sessionId,
        projectPath: e.projectPath,
        file: e.file,
        op: e.op,
        toolName: e.toolName,
        line: e.line,
      })),
    });
  } catch (error) {
    console.error('Edits timeline error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to build edits timeline',
    });
  }
});

export default router;
