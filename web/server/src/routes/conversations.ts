/**
 * Conversation routes.
 */

import express from 'express';
import { getRecentSessions, getSessionPath, getRelatedItems, getSessionMetadata } from '../services/sessions.js';
import { getConversation, getGeminiConversation, getOpenCodeConversation, getSubagents } from '../services/parser.js';
import type { Subagent } from '../services/parser.js';
import { MemoryStore } from '../imports.js';
import type { SourceType } from '../imports.js';
import { matchesPrefix } from '../utils/paths.js';

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

    // Filter by project — exact or folder prefix match (so clicking a
    // folder in the sidebar tree returns all descendant sessions too).
    if (projectFilter) {
      sessions = sessions.filter(s => matchesPrefix(s.projectPath || '', projectFilter));
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

    const store = new MemoryStore();
    try {
      // 1. Detect tool type and file path
      const item = store.getItem(id, 'session' as SourceType);
      let tool = 'claude';
      let filePath = '';
      let mtime = 0;

      if (item) {
        const extra = JSON.parse(item.extra_json || '{}');
        tool = extra.tool || 'claude';
        filePath = item.file_path;
        mtime = item.mtime;
      }

      if (tool === 'claude' && !filePath) {
        try {
          filePath = getSessionPath(id);
          const { statSync } = await import('fs');
          mtime = statSync(filePath).mtimeMs;
        } catch {}
      }

      // 2. Try Cache
      // PARSER_VERSION: bump when parser output shape changes so stale cache
      // entries from older buggy parsers are ignored instead of served.
      const PARSER_VERSION = 4;
      if (mtime > 0) {
        const cached = store.getCachedContent(id, 'session', mtime);
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed && parsed.v === PARSER_VERSION && Array.isArray(parsed.messages)) {
              return res.json({
                sessionId: id,
                messages: parsed.messages,
                subagents: parsed.subagents ?? [],
                count: parsed.messages.length,
                fromCache: true,
              });
            }
          } catch {
            // fall through and reparse
          }
        }
      }

      // 3. Parse and cache
      let messages;
      let subagents: Subagent[] = [];
      if (tool === 'gemini') {
        if (!filePath) throw new Error('Session path not found');
        messages = await getGeminiConversation(filePath);
      } else if (tool === 'opencode') {
        messages = await getOpenCodeConversation(id);
      } else {
        // Claude
        if (!filePath) throw new Error('Session not found');
        messages = await getConversation(filePath);
        subagents = await getSubagents(filePath);
      }

      // Store in cache (versioned envelope — see PARSER_VERSION above)
      if (mtime > 0 && messages.length > 0) {
        store.setCachedContent(id, 'session', mtime, JSON.stringify({ v: PARSER_VERSION, messages, subagents }));
      }

      res.json({
        sessionId: id,
        messages,
        subagents,
        count: messages.length,
      });
    } finally {
      store.close();
    }
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
