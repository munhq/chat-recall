/**
 * Memory API routes.
 *
 * /api/memory/search  - Unified search across all memory types
 * /api/memory/status  - Memory system statistics
 * /api/memory/item    - Get a specific memory item
 * /api/memory/links   - Get relationships for an item
 * /api/memory/browse  - List items by source type
 */

import express from 'express';
import { sanitizeQuery } from '@chat-recall/engine/core/query-sanitizer.js';
import { MemoryService } from '../services/memory.js';
import { createStore, classifyChunk } from '../imports.js';
import type { SourceType } from '../imports.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { TenantTtlCache } from '../util/tenant-cache.js';
import { tenantLimits } from '../util/billing.js';
import { countLockedOlder } from './search.js';

const log = createLogger('memory');

const router = express.Router();
const memoryService = new MemoryService();

// Per-project team visibility is enforced in the DB (RLS `author_visibility`),
// so a fetch of an unshared item returns no rows under the request's
// `app.viewer` and these handlers 404 naturally — no per-route guard needed.

// Memory route only validates the "what was said / what happened" set.
// Toolkit primitives (skill, mcp, command, agent, hook, plugin) are
// validated separately by /api/toolkit. The underlying store is shared.
const VALID_SOURCE_TYPES = ['session', 'plan', 'task', 'claude_md', 'paste', 'history', 'diary'];

function validateSourceType(sourceType: string): sourceType is SourceType {
  return VALID_SOURCE_TYPES.includes(sourceType);
}

// POST /api/memory/search
router.post('/search', async (req, res) => {
  try {
    // `projectFilter` body field is accepted for backwards compatibility
    // with older clients (web build pre-deploy) but now treated as a
    // project_id, matching the rest of the system.
    const { query, topK: rawTopK = 10, sourceTypes, projectFilter, projectIdFilter, semantic } = req.body;
    const topK = Math.min(Math.max(parseInt(rawTopK) || 10, 1), 100);

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    if (typeof query !== 'string') {
      return res.status(400).json({ error: 'Query must be a string' });
    }

    // Server-side sanitisation — see the note in routes/search.ts. Memory hits
    // are fed straight back into an assistant, so this is the boundary that
    // matters, not the MCP client.
    const safeQuery = sanitizeQuery(query).cleanQuery;
    if (!safeQuery) {
      return res.status(400).json({ error: 'Query is empty after sanitization' });
    }

    // Free-tier search window: a lapsed tenant searches only the last
    // `searchWindowDays` days. null (paid, trialing, self-host) leaves the
    // query untouched. See routes/search.ts for the same clamp.
    const { searchWindowDays } = await tenantLimits(req.tenant || 'default');
    const windowFloorMs = typeof searchWindowDays === 'number'
      ? Date.now() - searchWindowDays * 86_400_000
      : undefined;

    // `semantic` opts into the vector tier, matching /api/search. Without it
    // this route could never reach pgvector — the flag was missing all the way
    // down, so unified memory search was FTS-only even with an embedder
    // configured. Default stays false: only an explicit search asks to embed.
    const [results, lockedOlder] = await Promise.all([
      memoryService.search(
        safeQuery,
        topK,
        sourceTypes as SourceType[] | undefined,
        projectIdFilter ?? projectFilter,
        semantic === true || semantic === 'true',
        windowFloorMs
      ),
      windowFloorMs !== undefined
        ? countLockedOlder(safeQuery, windowFloorMs, projectIdFilter ?? projectFilter, sourceTypes as SourceType[] | undefined)
        : Promise.resolve(undefined),
    ]);

    res.json({
      query,
      results,
      count: results.length,
      // Only when windowed — the paid response shape is unchanged.
      ...(windowFloorMs !== undefined
        ? { window_days: searchWindowDays, locked_older: lockedOlder ?? 0 }
        : {}),
    });
  } catch (error) {
    log.error({ err: error }, 'memory search error');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Memory search failed',
    });
  }
});

// In-process TTL cache for /memory/status. The aggregate counts
// (across 9 source types) are derived from a SQL group-by — fast
// individually but adds up to ~250ms cold. The Memory tab fires this
// on every render; caching for 30s keeps tab switches snappy.
// Tenant-scoped: a plain module-level value here leaked one tenant's
// counts to every other tenant for the TTL window.
const memoryStatusCache = new TenantTtlCache<unknown>(30_000);

// GET /api/memory/status
router.get('/status', async (req, res) => {
  try {
    const cached = memoryStatusCache.get();
    if (cached) return res.json(cached);
    const status = await memoryService.getStatus();
    memoryStatusCache.set(status);
    res.json(status);
  } catch (error) {
    log.error({ err: error }, 'memory status error');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get memory status',
    });
  }
});

// GET /api/memory/item/:sourceType/:id
router.get('/item/:sourceType/:id', async (req, res) => {
  try {
    const { sourceType, id } = req.params;
    if (!validateSourceType(sourceType)) {
      return res.status(400).json({ error: `Invalid source type: ${sourceType}` });
    }
    const item = await memoryService.getItem(id, sourceType);

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    res.json(item);
  } catch (error) {
    log.error({ err: error }, 'memory item error');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get memory item',
    });
  }
});

// GET /api/memory/item/:sourceType/:id/content
router.get('/item/:sourceType/:id/content', async (req, res) => {
  try {
    const { sourceType, id } = req.params;
    if (!validateSourceType(sourceType)) {
      return res.status(400).json({ error: `Invalid source type: ${sourceType}` });
    }
    
    const store = await createStore();
    try {
      const item = await store.getItem(id, sourceType);

      if (!item) {
        return res.status(404).json({ error: 'Item not found' });
      }

      // 1. Try Cache
      const cached = await store.getCachedContent(id, sourceType, item.mtime);
      if (cached) {
        return res.json({ content: cached, fromCache: true });
      }

      const { existsSync } = await import('fs');

      // 2. Local mode: read the source file from disk when it exists.
      if (item.file_path && existsSync(item.file_path)) {
        const { readFile } = await import('fs/promises');
        const content = await readFile(item.file_path, 'utf-8');
        await store.setCachedContent(id, sourceType, item.mtime, content);
        return res.json({ content });
      }

      // 3. Server mode: synced items have no local file. Reconstruct the
      // content from the stored FTS chunks (the canonical server-side copy),
      // joined in chunk order. This covers plans/items synced from a client.
      const chunks = await store.listChunksByItem(sourceType, id);
      if (chunks.length > 0) {
        const content = chunks.map((c) => c.text).join('\n\n');
        await store.setCachedContent(id, sourceType, item.mtime, content);
        return res.json({ content, fromChunks: true });
      }

      // 4. Nothing on disk, nothing in chunks — genuinely unavailable.
      return res.status(404).json({
        error: item.file_path
          ? `File not found at path: ${item.file_path}`
          : 'Item has no content (no file and no chunks)',
      });
    } finally {
      await store.close();
    }
  } catch (error) {
    log.error({ err: error }, 'memory item content error');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get memory item content',
    });
  }
});

// GET /api/memory/links/:sourceType/:id
router.get('/links/:sourceType/:id', async (req, res) => {
  try {
    const { sourceType, id } = req.params;
    if (!validateSourceType(sourceType)) {
      return res.status(400).json({ error: `Invalid source type: ${sourceType}` });
    }
    const links = await memoryService.getLinks(sourceType, id);

    res.json({ links, count: links.length });
  } catch (error) {
    log.error({ err: error }, 'memory links error');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get memory links',
    });
  }
});

// GET /api/memory/browse/:sourceType
router.get('/browse/:sourceType', async (req, res) => {
  try {
    const { sourceType } = req.params;
    if (!validateSourceType(sourceType)) {
      return res.status(400).json({ error: `Invalid source type: ${sourceType}` });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit as string || '50', 10) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset as string || '0', 10) || 0, 0);

    // Free-tier list window: browse reaches back only `searchWindowDays` days.
    // No cheap total exists here (listItems is page-only), so the response
    // carries `window_days` for the banner but no locked_older count.
    const { searchWindowDays } = await tenantLimits(req.tenant || 'default');
    const windowFloorMs = typeof searchWindowDays === 'number'
      ? Date.now() - searchWindowDays * 86_400_000
      : undefined;

    const items = await memoryService.listItems(sourceType, limit, offset, windowFloorMs);

    res.json({
      items,
      count: items.length,
      sourceType,
      ...(windowFloorMs !== undefined ? { window_days: searchWindowDays } : {}),
    });
  } catch (error) {
    log.error({ err: error }, 'memory browse error');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to browse memory items',
    });
  }
});

// POST /api/memory/reindex
router.post('/reindex', async (req, res) => {
  try {
    const { sourceTypes, force = false } = req.body;

    if (!Array.isArray(sourceTypes) || sourceTypes.length === 0) {
      return res.status(400).json({ error: 'sourceTypes array is required' });
    }

    // Start reindexing in background
    const result = await memoryService.reindex(sourceTypes as SourceType[], force);

    res.json({
      message: 'Reindexing started',
      sourceTypes,
      force,
      ...result
    });
  } catch (error) {
    log.error({ err: error }, 'memory reindex error');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to start reindexing',
    });
  }
});

// POST /api/memory/reclassify — re-run the current classifier over already-
// indexed chunks so classifier improvements reach old data (the reclassify
// sweep). Idempotent; only rewrites tags that actually changed.
router.post('/reclassify', async (req, res) => {
  try {
    const { createStore } = await import('../imports.js');
    const store = await createStore() as { reclassifyChunks?: (batch?: number) => Promise<{ scanned: number; updated: number }> };
    if (typeof store.reclassifyChunks !== 'function') {
      return res.status(501).json({ error: 'reclassify not supported by this storage backend' });
    }
    const result = await store.reclassifyChunks();
    res.json({ message: 'Reclassify sweep complete', ...result });
  } catch (error) {
    log.error({ err: error }, 'memory reclassify error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Reclassify failed' });
  }
});

// PATCH /api/memory/item/:sourceType/:id
router.patch('/item/:sourceType/:id', async (req, res) => {
  try {
    const { sourceType, id } = req.params;
    const { project_path } = req.body;

    if (typeof project_path !== 'string') {
      return res.status(400).json({ error: 'project_path is required' });
    }

    const success = await memoryService.updateItemProjectPath(
      id,
      sourceType as SourceType,
      project_path
    );

    if (success) {
      res.json({ message: 'Project path updated', id, sourceType, project_path });
    } else {
      res.status(404).json({ error: 'Item not found' });
    }
  } catch (error) {
    log.error({ err: error }, 'memory item update error');
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to update item',
    });
  }
});

// GET /api/memory/wake-up?project_filter=&max_facts=&max_kg_facts=
// Server-side wake-up context for the thin-collector MCP: the high-importance
// facts the classifier tagged during indexing (FTS chunks at imp4/imp5) plus
// the current knowledge-graph snapshot. Identity (a tiny local file) stays on
// the MCP side; the server only supplies the data it holds.
router.get('/wake-up', async (req, res) => {
  const projectFilter = typeof req.query.project_filter === 'string' ? req.query.project_filter : undefined;
  const maxFacts = req.query.max_facts ? parseInt(String(req.query.max_facts), 10) : 10;
  const maxKgFacts = req.query.max_kg_facts ? parseInt(String(req.query.max_kg_facts), 10) : 15;
  const { createStore, createKnowledgeGraph } = await import('../imports.js');
  const store = await createStore();
  try {
    // Select high-importance facts by the classifier's OWN tag (imp4/imp5),
    // ordered by importance — not by keyword-searching the words "decision
    // preference milestone", which missed every tagged chunk that didn't
    // literally contain those nouns and ordered by relevance instead.
    const want = Number.isFinite(maxFacts) ? maxFacts : 10;
    const hits = await store.topImportantChunks({
      // Over-fetch: the presentation filter below drops fragments and
      // duplicates, so it needs a candidate pool larger than the ask.
      limit: want * 3,
      minImportance: 4,
      projectIdFilter: projectFilter,
      // Decisions/milestones/preferences live in real work artifacts — not in
      // shell command history or paste-cache, which the classifier also tags
      // but which are noise in a "high-importance facts" feed.
      sourceTypes: ['session', 'plan', 'claude_md', 'diary'],
    });
    const highFacts = selectWakeUpFacts(hits, want);

    let kg: { stats: unknown; facts: Array<{ subject: string; predicate: string; object: string; origin: string }> } = { stats: {}, facts: [] };
    const graph = await createKnowledgeGraph();
    try {
      const stats = await graph.stats();
      let facts: Array<{ subject: string; predicate: string; object: string; origin: string }> = [];
      if (stats.current_facts > 0) {
        const all = (await graph.timeline(undefined, 500))
          // KG4: only surface facts we're reasonably sure of — a 0.5 single-mention
          // auto-guess shouldn't carry the same weight as a recorded decision.
          // Human-asserted facts are always trusted regardless of confidence.
          .filter((e) => e.current && (e.origin === 'asserted' || (e.confidence ?? 1) >= 0.7));
        const filtered = projectFilter
          ? all.filter((f) => f.subject.toLowerCase().includes(projectFilter.toLowerCase()) || f.object.toLowerCase().includes(projectFilter.toLowerCase()))
          : all;
        // Asserted facts first (they're the ones you deliberately recorded).
        filtered.sort((a, b) => (a.origin === 'asserted' ? 0 : 1) - (b.origin === 'asserted' ? 0 : 1));
        facts = filtered.slice(0, Number.isFinite(maxKgFacts) ? maxKgFacts : 15)
          .map((f) => ({ subject: f.subject, predicate: f.predicate, object: f.object, origin: f.origin }));
      }
      kg = { stats, facts };
    } finally {
      await graph.close();
    }
    res.json({ highFacts, kg });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'wake-up failed' });
  } finally {
    await store.close();
  }
});

/**
 * Presentation cleanup for wake-up facts. Raw top-importance chunks arrive
 * with three defects the chunker/classifier can't avoid, and this fixes all
 * three at the serving edge so every consumer (CLI, MCP, coolcode) benefits:
 *
 * 1. Leading fragments — the chunker splits mid-word, so a chunk can open
 *    with "ed server hardware…". Detect a fragment start, advance to the
 *    first clean sentence start, and drop the candidate if none exists.
 * 2. Hard mid-word truncation — cut at a word boundary and add an ellipsis
 *    instead of slicing at a fixed byte offset.
 * 3. Near-duplicates — overlapping chunks repeat the same sentence, and one
 *    verbose session can fill every slot. Dedup by normalized prefix and cap
 *    facts per source item.
 */
const FRAGMENT_ALLOWED_STARTS = new Set([
  'a', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'i', 'if', 'in', 'is',
  'it', 'my', 'no', 'of', 'ok', 'on', 'or', 'so', 'to', 'up', 'we', 'use',
]);
const FACT_MAX_CHARS = 160;

export function selectWakeUpFacts(
  hits: Array<{ itemId: string; chunkType: string; text: string }>,
  want: number,
): Array<{ type: string; text: string }> {
  const out: Array<{ type: string; text: string }> = [];
  const seen = new Set<string>();
  const perItem = new Map<string, number>();

  for (const c of hits) {
    if (out.length >= want) break;
    let text = c.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    // Markdown table dumps ("| When | Session | …") are listings the
    // classifier tags as decisions; they are never a useful one-line fact.
    if ((text.match(/ \| /g) ?? []).length >= 3) continue;

    // 1. Fragment start: the LEADING LETTER RUN is lowercase, very short,
    //    and not a real short word — "ed server…" (run "ed" + space) and
    //    's."chat-recall…' (run "s" + punctuation) are both mid-word chunk
    //    openings. Advance to the first sentence start; if the remainder
    //    is too short to be a useful fact, drop the candidate.
    const leadingRun = text.match(/^[a-z]+/)?.[0] ?? '';
    const fragmentStart =
      /^[^A-Za-z0-9"'`*#>\[-]/.test(text) ||
      (leadingRun.length > 0 && leadingRun.length <= 2 && !FRAGMENT_ALLOWED_STARTS.has(leadingRun));
    if (fragmentStart) {
      const m = text.match(/[.!?]\s+(?=[A-Z0-9"'`*#-])/);
      const rest = m && m.index !== undefined ? text.slice(m.index + m[0].length).trim() : '';
      if (rest.length < 40) continue;
      text = rest;
    }

    // 2. Surface the EVIDENCE, not the chunk head. The classifier tags whole
    //    chunks, so a chunk can earn imp5 from one sentence deep inside while
    //    its head shows unrelated text. Find the first 1-2 sentence window
    //    that itself classifies at wake-up importance for this type and show
    //    that; keep the cleaned head only when no window fires (evidence
    //    spread across the chunk).
    const type = c.chunkType.match(/:(\w+):imp/)?.[1] ?? 'fact';
    const sentences = text.split(/(?<=[.!?])\s+/);
    if (sentences.length > 1) {
      outer: for (const windowSize of [1, 2]) {
        for (let i = 0; i + windowSize <= sentences.length; i++) {
          const win = sentences.slice(i, i + windowSize).join(' ');
          const cls = classifyChunk(win);
          if (cls.memoryType === type && cls.importance >= 4) {
            text = win;
            break outer;
          }
        }
      }
    }

    // 3. Word-boundary truncation with an ellipsis.
    if (text.length > FACT_MAX_CHARS) {
      const cut = text.lastIndexOf(' ', FACT_MAX_CHARS - 1);
      text = `${text.slice(0, cut > 60 ? cut : FACT_MAX_CHARS - 1).trimEnd()}…`;
    }

    // 4. Dedup by normalized prefix + cap facts per source item, so one
    //    session cannot fill the whole feed with the same content.
    const key = text.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    if (seen.has(key)) continue;
    const itemCount = perItem.get(c.itemId) ?? 0;
    if (itemCount >= 2) continue;
    seen.add(key);
    perItem.set(c.itemId, itemCount + 1);

    out.push({ type, text });
  }
  return out;
}

export default router;
