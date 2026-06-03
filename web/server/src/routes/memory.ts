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
    console.error('Memory search error:', error);
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
    console.error('Memory status error:', error);
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
    console.error('Memory item error:', error);
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

      if (!item.file_path) {
        return res.status(400).json({ error: 'Item has no associated file path' });
      }

      // 1. Try Cache
      const cached = await store.getCachedContent(id, sourceType, item.mtime);
      if (cached) {
        return res.json({ content: cached, fromCache: true });
      }

      // 2. Read from disk
      const { readFile } = await import('fs/promises');
      const { existsSync } = await import('fs');

      if (!existsSync(item.file_path)) {
        return res.status(404).json({ error: `File not found at path: ${item.file_path}` });
      }

      const content = await readFile(item.file_path, 'utf-8');

      // 3. Store in Cache
      await store.setCachedContent(id, sourceType, item.mtime, content);

      res.json({ content });
    } finally {
      await store.close();
    }
  } catch (error) {
    console.error('Memory item content error:', error);
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
    console.error('Memory links error:', error);
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
    console.error('Memory browse error:', error);
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
    console.error('Memory reindex error:', error);
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
    console.error('Memory item update error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to update item',
    });
  }
});

export default router;
