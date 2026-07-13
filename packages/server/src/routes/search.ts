/**
 * Search routes.
 */

import express from 'express';
import { SearchService } from '../services/search.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('search');

const router = express.Router();
const searchService = new SearchService();

// POST /api/search
router.post('/', async (req, res) => {
  try {
    const { query, topK: rawTopK = 10, projectFilter, includeMemory = false, sourceTypes } = req.body;
    const topK = Math.min(Math.max(parseInt(rawTopK) || 10, 1), 100);

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Session + memory search run in parallel — they're independent, so there's
    // no reason to pay their latencies back-to-back (was sequential awaits).
    const [results, memoryResults] = await Promise.all([
      searchService.search(query, topK, projectFilter),
      includeMemory
        ? searchService.searchUnified(query, topK, sourceTypes, projectFilter).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const memoryCount = memoryResults?.length ?? 0;

    res.json({
      query,
      results,
      count: results.length,
      memoryResults,
      memoryCount,
    });
  } catch (error) {
    log.error({ err: error }, 'search error');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Search failed',
    });
  }
});

export default router;
