/**
 * Subagent search — server-side surface for the MCP `recall_subagent_search`
 * tool. Subagents (Claude's explore/compact/aside sub-tasks) ship inside the
 * session envelope and are indexed at sync time as `subagent:<kind>` FTS chunks
 * (chunkId = `<sessionId>:subagent:<subagentId>`). This searches them so the
 * tool works against synced/cross-device history instead of local JSONL files.
 */

import express from 'express';
import { createStore } from '../imports.js';
import type { SourceType } from '../imports.js';

const router = express.Router();

interface SubagentHit { sessionId: string; subagent: string; kind: string; lineHits: number; sample: string }

// GET /api/subagents/search?query=&session_id=&kind=&limit=
router.get('/search', async (req, res) => {
  const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
  if (!query) return res.status(400).json({ error: 'query is required' });
  const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : undefined;
  const kindFilter = typeof req.query.kind === 'string' ? req.query.kind : undefined;
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
  const cap = Number.isFinite(limit) ? limit : 20;
  const needle = query.toLowerCase();

  const store = await createStore();
  try {
    // Candidate sessions: the requested one, or FTS-ranked sessions whose
    // chunks matched the query (cheap pre-filter before per-session scan).
    let candidates: string[];
    if (sessionId) {
      candidates = [sessionId];
    } else {
      const ranked = await store.searchFTS(query, { topK: cap * 5, sourceTypes: ['session' as SourceType] });
      candidates = [...new Set(ranked.map((r) => r.itemId))];
    }

    const hits: SubagentHit[] = [];
    for (const id of candidates) {
      const chunks = await store.listChunksByItem('session', id);
      for (const c of chunks) {
        if (!c.chunk_type.startsWith('subagent:')) continue;
        const kind = c.chunk_type.slice('subagent:'.length);
        if (kindFilter && kind !== kindFilter) continue;
        const lower = c.text.toLowerCase();
        if (!lower.includes(needle)) continue;
        const marker = ':subagent:';
        const subagent = c.chunk_id.includes(marker) ? c.chunk_id.slice(c.chunk_id.indexOf(marker) + marker.length) : c.chunk_id;
        const lineHits = lower.split(needle).length - 1;
        const idx = lower.indexOf(needle);
        const sample = c.text.slice(Math.max(0, idx - 60), idx + 140).replace(/\s+/g, ' ').trim();
        hits.push({ sessionId: id, subagent, kind, lineHits, sample });
        if (hits.length >= cap) break;
      }
      if (hits.length >= cap) break;
    }
    res.json({ query, hits });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'subagent search failed' });
  } finally {
    await store.close();
  }
});

export default router;
