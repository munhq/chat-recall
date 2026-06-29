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
      res.json({
        sessions,
        rawArchived: raw.length,
        rawBytes: 0, // size omitted from the cheap listing; panel shows counts
        newestSessionAgeMs: newestMtime ? Date.now() - newestMtime : null,
        sourceTypes: stats,
      });
    } finally {
      await store.close();
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'sync status failed' });
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
