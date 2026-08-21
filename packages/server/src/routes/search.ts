/**
 * Search routes.
 */

import express from 'express';
import { SearchService } from '../services/search.js';
import { sanitizeQuery } from '@chat-recall/engine/core/query-sanitizer.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { tenantLimits } from '../util/billing.js';
import { createStore } from '../imports.js';
import type { SourceType } from '../imports.js';

const log = createLogger('search');

const router = express.Router();
const searchService = new SearchService();

/**
 * How many matching SESSIONS sit behind the free tier's search window —
 * "you have N older results, upgrade to unlock" is the conversion surface.
 * Counted on the raw (unexpanded) query: keyword expansion widens recall
 * inside the window, but the banner count only needs the direct matches.
 * Best-effort — a failed count must never fail the search.
 */
export async function countLockedOlder(
  query: string,
  windowFloorMs: number,
  projectFilter?: string,
  // undefined = count across all source types (unified memory search).
  sourceTypes?: SourceType[],
): Promise<number> {
  try {
    const store = await createStore();
    try {
      return await store.countDistinctItemsMatching(query, {
        sourceTypes,
        projectFilter,
        beforeMs: windowFloorMs,
      });
    } finally {
      await store.close();
    }
  } catch {
    return 0;
  }
}

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

    // Free-tier search window: a lapsed tenant searches only the last
    // `searchWindowDays` days; older data stays stored and locked. null (paid,
    // trialing, self-host) leaves the query untouched — byte-for-byte today's
    // behavior.
    const { searchWindowDays } = await tenantLimits(req.tenant || 'default');
    const windowFloorMs = typeof searchWindowDays === 'number'
      ? Date.now() - searchWindowDays * 86_400_000
      : undefined;

    // Session + memory search run in parallel — they're independent, so there's
    // no reason to pay their latencies back-to-back (was sequential awaits).
    // The locked-older count (matches behind the window — the upgrade surface)
    // rides the same Promise.all; it only runs when the window is active.
    const [results, memoryResults, lockedOlder] = await Promise.all([
      searchService.search(safeQuery, topK, projectFilter, wantSemantic, windowFloorMs),
      includeMemory
        ? searchService.searchUnified(safeQuery, topK, sourceTypes, projectFilter, wantSemantic, windowFloorMs).catch(() => undefined)
        : Promise.resolve(undefined),
      windowFloorMs !== undefined
        ? countLockedOlder(safeQuery, windowFloorMs, projectFilter, ['session'])
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
      // Only when windowed — the paid response shape is unchanged.
      ...(windowFloorMs !== undefined
        ? { window_days: searchWindowDays, locked_older: lockedOlder ?? 0 }
        : {}),
    });
  } catch (error) {
    log.error({ err: error }, 'search error');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Search failed',
    });
  }
});

export default router;
