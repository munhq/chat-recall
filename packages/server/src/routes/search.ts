/**
 * Search routes.
 */

import express from 'express';
import { SearchService } from '../services/search.js';
import { sanitizeQuery } from '@chat-recall/engine/core/query-sanitizer.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { tenantLimits, searchWindow, windowMeta } from '../util/billing.js';
import { createStore } from '../imports.js';
import type { SourceType } from '../imports.js';
import { TenantTtlCache } from '../util/tenant-cache.js';

const log = createLogger('search');

const router = express.Router();
const searchService = new SearchService();

/** 60s cache on the locked-older count, keyed tenant|query|filters. The client
 *  debounces typing at 300 ms, so a free tenant composing a query would
 *  otherwise pay an unbounded COUNT aggregate per keystroke burst — for a
 *  banner number that does not change within a minute. */
const lockedOlderCache = new TenantTtlCache<number>(60_000);

/**
 * How many matching SESSIONS sit behind the free tier's search window —
 * "you have N older results, upgrade to unlock" is the conversion surface.
 * Counted on the raw (unexpanded) query: keyword expansion widens recall
 * inside the window, but the banner count only needs the direct matches.
 * Best-effort — a failed count must never fail the search.
 */
export async function countLockedOlder(
  tenant: string,
  query: string,
  windowFloorMs: number,
  projectFilter?: string,
  // undefined = count across all source types (unified memory search).
  sourceTypes?: SourceType[],
): Promise<number> {
  // The key carries the tenant: two tenants asking the same query must never
  // share a count. The floor is bucketed to the hour so the rolling
  // Date.now() cannot make every call a cache miss.
  const key = `${tenant}|${query}|${projectFilter ?? ''}|${(sourceTypes ?? []).join(',')}|${Math.floor(windowFloorMs / 3_600_000)}`;
  const cached = lockedOlderCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const store = await createStore();
    try {
      const n = await store.countDistinctItemsMatching(query, {
        sourceTypes,
        projectFilter,
        beforeMs: windowFloorMs,
      });
      lockedOlderCache.set(key, n);
      return n;
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

    // Free-tier search window: a lapsed tenant searches only the last
    // `searchWindowDays` days; older data stays stored and locked. null (paid,
    // trialing, self-host) leaves the query untouched — byte-for-byte today's
    // behavior.
    const limits = await tenantLimits(req.tenant || 'default');
    const win = await searchWindow(req.tenant || 'default');
    const windowFloorMs = win.floorMs;

    // `semantic` is set only by an explicit search (Enter / Search button); the
    // debounced type-ahead leaves it false → FTS only, no embed. ALSO forced
    // off when the tenant's limits say no embeddings: a free tenant's chunks
    // are never embedded, so a semantic pass would bill the embedding gateway
    // for a query that can match nothing.
    const wantSemantic = semantic === true && limits.embeddings;

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
        ? countLockedOlder(req.tenant || 'default', safeQuery, windowFloorMs, projectFilter, ['session'])
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
      ...windowMeta(win, lockedOlder),
    });
  } catch (error) {
    log.error({ err: error }, 'search error');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Search failed',
    });
  }
});

export default router;
