/**
 * File-level recall routes. `redundant` scores historical filenames (from each
 * synced session's `filesModified` telemetry) against a target filename so the
 * agent can spot "you've created a file like this before" before writing a new
 * one. Server-side equivalent of the MCP recall_redundant_files tool — the
 * cross-session filename index lives in the store, not on the collector.
 */

import express from 'express';
import { createStore } from '../imports.js';
import type { SourceType } from '../imports.js';

const router = express.Router();

interface Hit { file: string; sessionId: string; project: string; mtime: number; score: number; reason: string }

// GET /api/files/redundant?filename=&project=&limit=
router.get('/redundant', async (req, res) => {
  const filename = typeof req.query.filename === 'string' ? req.query.filename.trim() : '';
  if (!filename) return res.status(400).json({ error: 'filename is required' });
  const project = typeof req.query.project === 'string' ? req.query.project : undefined;
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;

  const targetBase = filename.split('/').pop() || filename;
  const targetStem = targetBase.replace(/\.[^.]+$/, '').toLowerCase();

  const store = await createStore();
  try {
    const items = await store.listItems('session' as SourceType, 5000, 0);
    const hits: Hit[] = [];
    for (const item of items) {
      if (project && !item.project_path?.includes(project)) continue;
      let extra: { filesModified?: string[] } = {};
      try { extra = JSON.parse(item.extra_json || '{}'); } catch { /* skip */ }
      const files = Array.isArray(extra.filesModified) ? extra.filesModified : [];
      for (const f of files) {
        const fbase = f.split('/').pop() || f;
        const fstem = fbase.replace(/\.[^.]+$/, '').toLowerCase();
        const stemsMatchable = fstem.length >= 4 && targetStem.length >= 4;
        let score = 0, reason = '';
        if (fbase === targetBase) { score = 1.0; reason = 'exact basename match'; }
        else if (fstem === targetStem) { score = 0.85; reason = 'same name, different extension'; }
        else if (stemsMatchable && (fstem.includes(targetStem) || targetStem.includes(fstem))) { score = 0.6; reason = 'stem substring match'; }
        else if (filename.includes('/') && f.includes(filename.split('/').slice(0, -1).join('/'))) { score = 0.4; reason = 'same directory'; }
        if (score > 0) hits.push({ file: f, sessionId: item.id, project: item.project_path || '(unknown)', mtime: item.mtime, score, reason });
      }
    }
    // Dedup by file path — keep the most recent / highest-scoring session.
    const byFile = new Map<string, Hit>();
    for (const h of hits) {
      const cur = byFile.get(h.file);
      if (!cur || h.mtime > cur.mtime || h.score > cur.score) byFile.set(h.file, h);
    }
    const ranked = [...byFile.values()].sort((a, b) => b.score - a.score || b.mtime - a.mtime).slice(0, Number.isFinite(limit) ? limit : 20);
    res.json({ filename, hits: ranked });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'redundant-files failed' });
  } finally {
    await store.close();
  }
});

export default router;
