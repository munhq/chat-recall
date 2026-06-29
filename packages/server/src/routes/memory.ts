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
import { MemoryService } from '../services/memory.js';
import { createStore } from '../imports.js';
import type { SourceType } from '../imports.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('memory');

const router = express.Router();
const memoryService = new MemoryService();

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
    const { query, topK: rawTopK = 10, sourceTypes, projectFilter, projectIdFilter } = req.body;
    const topK = Math.min(Math.max(parseInt(rawTopK) || 10, 1), 100);

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const results = await memoryService.search(
      query,
      topK,
      sourceTypes as SourceType[] | undefined,
      projectIdFilter ?? projectFilter
    );

    res.json({ query, results, count: results.length });
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
let memoryStatusCache: { data: unknown; expiresAt: number } | null = null;
const MEMORY_STATUS_TTL_MS = 30_000;

// GET /api/memory/status
router.get('/status', async (req, res) => {
  try {
    const now = Date.now();
    if (memoryStatusCache && memoryStatusCache.expiresAt > now) {
      return res.json(memoryStatusCache.data);
    }
    const status = await memoryService.getStatus();
    memoryStatusCache = { data: status, expiresAt: now + MEMORY_STATUS_TTL_MS };
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

    const items = await memoryService.listItems(sourceType, limit, offset);

    res.json({ items, count: items.length, sourceType });
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
    const hits = await store.searchFTS('decision preference milestone', { topK: 60, projectIdFilter: projectFilter });
    const highFacts = hits
      .filter((r) => r.chunkType.includes(':imp4') || r.chunkType.includes(':imp5'))
      .slice(0, Number.isFinite(maxFacts) ? maxFacts : 10)
      .map((c) => ({ type: c.chunkType.match(/:(\w+):imp/)?.[1] ?? 'fact', text: c.text.replace(/\n/g, ' ').trim().slice(0, 150) }));

    let kg: { stats: unknown; facts: Array<{ subject: string; predicate: string; object: string }> } = { stats: {}, facts: [] };
    const graph = await createKnowledgeGraph();
    try {
      const stats = await graph.stats();
      let facts: Array<{ subject: string; predicate: string; object: string }> = [];
      if (stats.current_facts > 0) {
        const all = (await graph.timeline(undefined, 500)).filter((e) => e.current);
        const filtered = projectFilter
          ? all.filter((f) => f.subject.toLowerCase().includes(projectFilter.toLowerCase()) || f.object.toLowerCase().includes(projectFilter.toLowerCase()))
          : all;
        facts = filtered.slice(0, Number.isFinite(maxKgFacts) ? maxKgFacts : 15).map((f) => ({ subject: f.subject, predicate: f.predicate, object: f.object }));
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

export default router;
