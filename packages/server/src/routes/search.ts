/**
 * Search routes.
 */

import express from 'express';
import { SearchService } from '../services/search.js';
import { sanitizeQuery } from '@chat-recall/engine/core/query-sanitizer.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('search');

const router = express.Router();
const searchService = new SearchService();

// POST /api/search
router.post('/', async (req, res) => {
  try {
    const { query, topK: rawTopK = 10, projectFilter, includeMemory = false, sourceTypes, semantic = false } = req.body;
    const topK = Math.min(Math.max(parseInt(rawTopK) || 10, 1), 100);

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    if (typeof query !== 'string') {
      return res.status(400).json({ error: 'Query must be a string' });
    }

    // Sanitise HERE, not in the MCP client. Search results are fed back into an
    // assistant's context, so the query is a prompt-injection carrier; a control
    // that lives only in the CLI is bypassed by anything that talks HTTP —
    // including this product's own web UI.
    const sanitized = sanitizeQuery(query);
    if (sanitized.wasSanitized) {
      log.warn({ reason: sanitized.reason, originalLength: sanitized.originalLength }, 'search query sanitized');
    }
    if (!sanitized.cleanQuery) {
      return res.status(400).json({ error: 'Query is empty after sanitization' });
    }
    const safeQuery = sanitized.cleanQuery;

    // `semantic` is set only by an explicit search (Enter / Search button); the
    // debounced type-ahead leaves it false → FTS only, no embed. See SearchService.
    const wantSemantic = semantic === true;

    // Session + memory search run in parallel — they're independent, so there's
    // no reason to pay their latencies back-to-back (was sequential awaits).
    const [results, memoryResults] = await Promise.all([
      searchService.search(safeQuery, topK, projectFilter, wantSemantic),
      includeMemory
        ? searchService.searchUnified(safeQuery, topK, sourceTypes, projectFilter, wantSemantic).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const memoryCount = memoryResults?.length ?? 0;

    res.json({
      // Echo what actually ran, not what was typed, so the caller can see when
      // sanitisation changed the query.
      query: safeQuery,
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
