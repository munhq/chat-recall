/**
 * Diary routes — server-side surface for the MCP `recall_diary_write` /
 * `recall_diary_read` tools. The local CLI used to write diary JSON to disk
 * (`DiarySource`), but a thin collector has no local store; entries live on
 * the server as `source_type: 'diary'` memory items (the same shape the sync
 * ingest produces), so they read back through the same tenant-scoped store the
 * dashboard uses. `extra.agent` namespaces entries per agent.
 */

import express from 'express';
import { createStore } from '../imports.js';

const router = express.Router();

interface DiaryExtra extends Record<string, unknown> {
  agent: string;
  topic: string;
  content: string;
  timestamp: string;
  sessionId?: string;
  projectPath?: string;
}

function agentSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

// POST /api/diary/write — { agent_name, topic, entry, session_id?, project_path? }
router.post('/write', async (req, res) => {
  const { agent_name, topic, entry, session_id, project_path } = req.body ?? {};
  if (!agent_name || !topic || !entry) {
    return res.status(400).json({ error: 'agent_name, topic, and entry are required' });
  }
  const ts = new Date().toISOString();
  const id = `diary_${agentSlug(agent_name)}_${ts.replace(/[:.]/g, '-')}`;
  const store = await createStore();
  try {
    const extra: DiaryExtra = { agent: agent_name, topic, content: entry, timestamp: ts, sessionId: session_id, projectPath: project_path };
    await store.setItem({
      id,
      sourceType: 'diary',
      title: `[${agent_name}] ${topic}: ${String(entry).slice(0, 80)}`,
      projectPath: project_path || '',
      filePath: '',
      mtime: Date.parse(ts),
      contentPreview: String(entry).slice(0, 500),
      extra,
    });
    await store.addChunksFTS([{
      chunkId: `${id}:0`,
      itemId: id,
      sourceType: 'diary',
      title: `[${agent_name}] ${topic}`,
      text: String(entry),
      chunkType: 'diary',
      projectPath: project_path || '',
      filePath: '',
      mtime: Date.parse(ts),
    }]);
    res.json({ id });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'diary write failed' });
  } finally {
    await store.close();
  }
});

// GET /api/diary/read?agent=&last_n= — recent entries for an agent, newest first.
router.get('/read', async (req, res) => {
  const agent = typeof req.query.agent === 'string' ? req.query.agent : '';
  const lastN = req.query.last_n ? parseInt(String(req.query.last_n), 10) : 10;
  if (!agent) return res.status(400).json({ error: 'agent is required' });
  const store = await createStore();
  try {
    const rows = await store.listItems('diary', 50000, 0);
    const want = agentSlug(agent);
    const entries = rows
      .map((r) => { try { return JSON.parse(r.extra_json || '{}') as DiaryExtra; } catch { return null; } })
      .filter((e): e is DiaryExtra => !!e && agentSlug(e.agent || '') === want)
      .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
      .slice(0, Number.isFinite(lastN) ? lastN : 10);
    res.json({ agent, entries });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'diary read failed' });
  } finally {
    await store.close();
  }
});

export default router;
