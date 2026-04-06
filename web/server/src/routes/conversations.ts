/**
 * Conversation routes.
 */

import express from 'express';
import { getRecentSessions, getSessionPath, getRelatedItems, getSessionMetadata } from '../services/sessions.js';
import { getConversation, getGeminiConversation, getOpenCodeConversation } from '../services/parser.js';
import { MemoryStore } from '../imports.js';
import type { SourceType } from '../imports.js';

const router = express.Router();

// GET /api/conversations/recent
router.get('/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const projectFilter = req.query.project as string | undefined;
    const toolFilter = req.query.tool as string | undefined;

    // Fetch all when filtering, otherwise use limit
    const needsAll = projectFilter || toolFilter;
    let sessions = await getRecentSessions(needsAll ? 0 : limit);

    // Filter by project — exact match
    if (projectFilter) {
      sessions = sessions.filter(s => s.projectPath === projectFilter);
    }

    // Filter by tool
    if (toolFilter) {
      sessions = sessions.filter(s => (s.tool || 'claude') === toolFilter);
    }

    // Limit after filtering
    sessions = sessions.slice(0, limit);

    res.json({
      sessions,
      count: sessions.length,
    });
  } catch (error) {
    console.error('Recent sessions error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get recent sessions',
    });
  }
});

// GET /api/conversations/:id/related
router.get('/:id/related', async (req, res) => {
  try {
    const { id } = req.params;
    const related = getRelatedItems(id);
    res.json(related);
  } catch (error) {
    console.error('Related items error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get related items',
    });
  }
});

// GET /api/conversations/:id/metadata
router.get('/:id/metadata', async (req, res) => {
  try {
    const { id } = req.params;
    const metadata = await getSessionMetadata(id);
    if (!metadata) {
      return res.status(404).json({ error: 'Session metadata not found' });
    }
    res.json(metadata);
  } catch (error) {
    console.error('Session metadata error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get session metadata',
    });
  }
});

// GET /api/conversations/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Detect tool type from MemoryStore
    let tool = 'claude';
    const store = new MemoryStore();
    try {
      const item = store.getItem(id, 'session' as SourceType);
      if (item) {
        const extra = JSON.parse(item.extra_json || '{}');
        tool = extra.tool || 'claude';
      }
    } finally {
      store.close();
    }

    let messages;
    if (tool === 'gemini') {
      // Find the Gemini session file path from the store
      const store2 = new MemoryStore();
      try {
        const item = store2.getItem(id, 'session' as SourceType);
        if (!item) throw new Error('Session not found');
        messages = await getGeminiConversation(item.file_path);
      } finally {
        store2.close();
      }
    } else if (tool === 'opencode') {
      messages = await getOpenCodeConversation(id);
    } else {
      // Claude — use JSONL parser
      const sessionPath = getSessionPath(id);
      messages = await getConversation(sessionPath);
    }

    res.json({
      sessionId: id,
      messages,
      count: messages.length,
    });
  } catch (error) {
    console.error('Conversation error:', error);

    if (error instanceof Error && error.message.includes('not found')) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get conversation',
    });
  }
});

// GET /api/conversations/:id/raw
router.get('/:id/raw', async (req, res) => {
  try {
    const { id } = req.params;

    // Find session file path
    const sessionPath = getSessionPath(id);

    // Read raw JSONL and parse each line
    const { open } = await import('fs/promises');
    const file = await open(sessionPath);
    const rawLines: any[] = [];

    for await (const line of file.readLines()) {
      if (line.trim()) {
        try {
          rawLines.push(JSON.parse(line));
        } catch (e) {
          // Skip malformed lines
        }
      }
    }

    await file.close();

    res.json({
      sessionId: id,
      lines: rawLines,
      count: rawLines.length,
    });
  } catch (error) {
    console.error('Raw conversation error:', error);

    if (error instanceof Error && error.message.includes('not found')) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get raw conversation',
    });
  }
});

export default router;
