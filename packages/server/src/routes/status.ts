/**
 * Status routes with Server-Sent Events support.
 */

import express from 'express';
import { SearchService } from '../services/search.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('status');

const router = express.Router();
const searchService = new SearchService();

// GET /api/status/sync — the trust panel's data: what fraction of reality
// this server holds. In local mode it can also see the disk (sessions the
// indexer knows about); in server mode it reports its own store coverage.
router.get('/sync', async (_req, res) => {
  try {
    const { createStore } = await import('../imports.js');
    const store = await createStore();
    try {
      const stats = await store.getStats();
      const raw = await store.listRawSessionVersions();
      const sessions = Number((stats as Record<string, number>).session || 0);
      // Most recent session row mtime = how fresh this store is.
      const recent = await store.querySessionIndex({ limit: 1, offset: 0, includeUntracked: true });
      const newestMtime = recent.rows[0]?.mtime ?? 0;
      // Collector walk progress, when one is in flight. Ignored once complete,
      // and ignored when the report has gone stale — a client that died mid-walk
      // must not leave the UI claiming "syncing, 62%" forever.
      const PROGRESS_STALE_MS = 10 * 60_000;
      let progress: { done: number; total: number } | null = null;
      // WHEN THE COLLECTOR LAST REPORTED, which is a different question from how
      // old the newest session is. Without this the UI could only say "1h
      // behind", meaning the newest transcript is an hour old — which is exactly
      // what a healthy install looks like when nobody has opened an AI tool for
      // an hour, and reads as a broken sync. Reported regardless of whether the
      // walk finished, because a finished walk is precisely the case that needs
      // it.
      let lastSyncAgeMs: number | null = null;
      try {
        const entry = await store.kvGet('collector', 'walk_progress');
        const raw = typeof entry === 'string' ? entry : (entry as { value?: string } | null)?.value;
        if (raw) {
          const p = JSON.parse(raw) as { done: number; total: number; complete: boolean; at: number };
          if (typeof p.at === 'number' && p.at > 0) lastSyncAgeMs = Math.max(0, Date.now() - p.at);
          // done >= total IS complete, whatever the flag says.
          //
          // The collector sets complete:true on the last line of the walk, after
          // its final upload has already gone out, so the flag only ships on the
          // NEXT post — and a walk that uploaded nothing new never makes one.
          // The server's last-received value is therefore the final in-loop
          // report: done === total with complete:false, refreshed often enough
          // that PROGRESS_STALE_MS never rescues it either. The UI then showed
          // "syncing 99%" indefinitely (99 because it clamps the percentage).
          //
          // Checked here rather than only in the client that sends it, because
          // collectors already in the field will keep reporting the old way.
          const finished = p.complete || p.done >= p.total;
          if (!finished && p.total > 0 && Date.now() - p.at < PROGRESS_STALE_MS) {
            progress = { done: p.done, total: p.total };
          }
        }
      } catch { /* no progress reported — the UI falls back to freshness */ }

      res.json({
        sessions,
        rawArchived: raw.length,
        rawBytes: 0, // size omitted from the cheap listing; panel shows counts
        newestSessionAgeMs: newestMtime ? Date.now() - newestMtime : null,
        sourceTypes: stats,
        progress,
        lastSyncAgeMs,
      });
    } finally {
      await store.close();
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'sync status failed' });
  }
});

/**
 * GET /api/status/archives — per-session archive sizes for this tenant.
 *
 * The client cannot tell whether the server is missing records without knowing
 * what the server holds. Returns `size` in the SAME unit the shrink guard
 * compares (gzipContainer().size, as stored), so `chat-recall verify --deep` can
 * diff it against the local union directly instead of guessing from mtimes.
 *
 * Ids + sizes only — no content, so this is cheap and leaks nothing a device
 * that owns the tenant did not already send.
 */
/**
 * GET /api/status/archives/:id/records — the record ids the archive holds.
 *
 * Size parity is strong evidence, not proof: two containers can agree on bytes
 * and differ in content. This returns the per-record `uuid` set so the client
 * can diff EXACTLY which records are missing — the check that found 589 absent
 * records in a session that size comparison classified as merely "pending".
 *
 * Ids only, never content, so it leaks nothing beyond what the device sent.
 */
router.get('/archives/:id/records', async (req, res) => {
  try {
    const { createStore, gunzipContainer } = await import('../imports.js');
    const store = await createStore();
    try {
      const raw = await store.getRawSession(req.params.id);
      if (!raw?.gz) return res.status(404).json({ error: 'no archive for that session' });
      const container = gunzipContainer(raw.gz);
      if (!container) return res.status(500).json({ error: 'archive unparseable' });
      const ids = new Set<string>();
      for (const f of container.files) {
        for (const line of f.text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const u = (JSON.parse(line) as { uuid?: unknown }).uuid;
            if (typeof u === 'string' && u) ids.add(u);
          } catch { /* not a record line */ }
        }
      }
      res.json({ id: req.params.id, count: ids.size, records: [...ids] });
    } finally { await store.close(); }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'record listing failed' });
  }
});

router.get('/archives', async (_req, res) => {
  try {
    const { createStore } = await import('../imports.js');
    const store = await createStore();
    try {
      const rows = await store.listRawSessionVersions();
      res.json({
        count: rows.length,
        archives: rows.map((r) => ({ id: r.session_id, size: Number(r.size) || 0, mtime: Number(r.mtime) || 0 })),
      });
    } finally { await store.close(); }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'archive listing failed' });
  }
});

// GET /api/status
router.get('/', async (req, res) => {
  try {
    const stats = await searchService.getStatus();
    res.json(stats);
  } catch (error) {
    log.error({ err: error }, 'status error');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get status',
    });
  }
});

// GET /api/status/stream (Server-Sent Events)
router.get('/stream', async (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send initial status
  try {
    const stats = await searchService.getStatus();
    res.write(`data: ${JSON.stringify(stats)}\n\n`);
  } catch (error) {
    log.error({ err: error }, 'SSE initial status error');
  }

  // Send updates every 2 seconds
  const interval = setInterval(async () => {
    try {
      const stats = await searchService.getStatus();
      res.write(`data: ${JSON.stringify(stats)}\n\n`);
    } catch (error) {
      log.error({ err: error }, 'SSE update error');
    }
  }, 2000);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

export default router;
