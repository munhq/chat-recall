/**
 * Conversation routes.
 */

import express from 'express';
import { getRecentSessions, getSessionPath, getRelatedItems, getSessionMetadata } from '../services/sessions.js';
import { getConversation, getGeminiConversation, getOpenCodeConversation, getCodexConversation, getCodexSubagents, getSubagents } from '../services/parser.js';
import type { Subagent } from '../services/parser.js';
import {
  MemoryStore,
  liveScanModifiedFiles,
  replaySession,
  getSessionCommits,
  computeOutcome,
  extractTurns,
  markPrompt,
  summarizeMarkers,
  findCodexSessionFile,
  extractTurnsAny,
  replaySessionAny,
  getSessionCommitsAny,
  computeOutcomeAny,
} from '../imports.js';
import type { SourceType } from '../imports.js';
import { matchesPrefix } from '../utils/paths.js';

const router = express.Router();

/**
 * The per-session features below — diff replay, git commits, outcome,
 * turns, markers — read Claude's tool_use shape directly from JSONL.
 * Codex (apply_patch shell calls), Gemini (different tool format), and
 * OpenCode (SQLite + tool parts) need their own implementations and
 * aren't wired up yet, so for now we short-circuit to a graceful empty
 * payload instead of 404. The UI's tab panels render an empty state
 * naturally; the network tab stays clean.
 */
function isNonClaude(id: string): boolean {
  return id.startsWith('codex_') || id.startsWith('gemini_') || id.startsWith('opencode_');
}

function emptyDiff(id: string) {
  return { sessionId: id, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };
}

function emptyOutcome(id: string) {
  return {
    sessionId: id,
    found: true,
    status: 'unknown',
    reason: 'outcome analysis not yet implemented for this AI tool',
    startMs: 0, endMs: 0,
    decisions: [], blockers: [], claimReaction: {},
    prompts: [],
    promptMarkers: { total: 0, interrupt: 0, frustrated: 0, correction: 0, approval: 0, question: 0, directive: 0, clarification_request: 0, peakIntensity: 0 },
    commits: { sessionId: id, startMs: 0, endMs: 0, repos: [], totalCommits: 0 },
    fileCount: 0, filesChanged: [], totalLinesAdded: 0, totalLinesRemoved: 0,
  };
}

// GET /api/conversations/recent
router.get('/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const projectFilter = req.query.project as string | undefined;
    const toolFilter = req.query.tool as string | undefined;
    const sinceHoursRaw = req.query.since_hours as string | undefined;
    const sinceHours = sinceHoursRaw ? Number(sinceHoursRaw) : undefined;

    // Fetch all when any filter is active so we can apply project/tool/time
    // checks before the final slice.
    const needsAll = projectFilter || toolFilter || sinceHours !== undefined;
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

    // Filter by time window
    if (sinceHours !== undefined && Number.isFinite(sinceHours) && sinceHours > 0) {
      const cutoff = Date.now() - sinceHours * 3600 * 1000;
      sessions = sessions.filter(s => (s.fileMtime || 0) >= cutoff);
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

// GET /api/conversations/:id/files-live
// Live transcript scan of the session's tool_uses — works on the active
// session even though the indexer hasn't run yet.
router.get('/:id/files-live', async (req, res) => {
  try {
    const { id } = req.params;
    const live = liveScanModifiedFiles(id);
    if (!live.found) return res.status(404).json({ error: 'Session not found' });

    // Bucket by extension to mirror the MCP tool's response shape.
    const byExt: Record<string, string[]> = {};
    for (const f of live.files) {
      const ext = f.includes('.') ? f.split('.').pop()!.toLowerCase() : '(no ext)';
      (byExt[ext] = byExt[ext] || []).push(f);
    }

    res.json({
      sessionId: id,
      tool: live.tool,
      projectPath: live.projectPath,
      files: live.files,
      reads: live.reads,
      filesByExt: byExt,
      edits: live.edits.map(e => ({
        ts: e.ts,
        tsIso: e.tsIso,
        file: e.file,
        op: e.op,
        toolName: e.toolName,
        tool: e.tool,
        line: e.line,
      })),
      source: 'live',
    });
  } catch (error) {
    console.error('Files-live error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to live-scan session',
    });
  }
});

// GET /api/conversations/:id/diff
// Per-file cumulative diff replayed from Edit/Write/MultiEdit/NotebookEdit
// tool calls. Optional ?file=<absolute path> narrows to one file.
router.get('/:id/diff', async (req, res) => {
  try {
    const { id } = req.params;
    const fileFilter = (req.query.file as string | undefined)?.trim() || undefined;
    const result = isNonClaude(id) ? replaySessionAny(id) : replaySession(id);
    if (!result.found) return res.status(404).json({ error: 'Session not found' });
    const files = fileFilter ? result.files.filter(f => f.file === fileFilter) : result.files;
    res.json({
      sessionId: id,
      projectPath: result.projectPath,
      totalLinesAdded: result.totalLinesAdded,
      totalLinesRemoved: result.totalLinesRemoved,
      files: files.map(f => ({
        file: f.file,
        diff: f.diff,
        linesAdded: f.linesAdded,
        linesRemoved: f.linesRemoved,
        reverted: f.reverted,
        succeededEvents: f.succeededEvents,
        failedEvents: f.failedEvents,
        initialKnown: f.initialKnown,
        events: f.events.map(e => ({
          ts: e.ts,
          tsIso: e.tsIso,
          line: e.line,
          toolName: e.toolName,
          toolUseId: e.toolUseId,
          succeeded: e.succeeded,
          toolError: e.toolError,
          applyError: e.applyError,
          editsCount: e.edits?.length,
          writeBytes: e.content?.length,
        })),
      })),
    });
  } catch (error) {
    console.error('Diff error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to compute diff' });
  }
});

// GET /api/conversations/:id/commits
// Git commits (across all detected repos) that landed during the session window.
router.get('/:id/commits', async (req, res) => {
  try {
    const { id } = req.params;
    if (isNonClaude(id)) {
      return res.json(getSessionCommitsAny(id));
    }
    const replay = replaySession(id);
    if (!replay.found) return res.status(404).json({ error: 'Session not found' });
    const turns = extractTurns(id, { maxTurns: 50_000 });
    const result = getSessionCommits(
      id,
      replay.files.map(f => f.file),
      turns.startMs || Date.now() - 86400_000,
      turns.endMs || Date.now(),
    );
    res.json(result);
  } catch (error) {
    console.error('Commits error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to compute commits' });
  }
});

// GET /api/conversations/:id/outcome
// Structured outcome: status, decisions, blockers, claim/reaction, markers.
router.get('/:id/outcome', async (req, res) => {
  try {
    const { id } = req.params;
    const out = isNonClaude(id) ? computeOutcomeAny(id) : computeOutcome(id);
    if (!out.found) return res.status(404).json({ error: 'Session not found' });
    res.json(out);
  } catch (error) {
    console.error('Outcome error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to compute outcome' });
  }
});

// GET /api/conversations/:id/turns
// Interleaved user/assistant/tool turns with bash command + tool-result snippets.
router.get('/:id/turns', async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 5000, 50_000));
    const result = extractTurnsAny(id, { maxTurns: limit });
    if (!result.found) return res.status(404).json({ error: 'Session not found' });
    res.json(result);
  } catch (error) {
    console.error('Turns error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to extract turns' });
  }
});

// GET /api/conversations/:id/markers
// Just the marked prompts + counts. Cheaper than /outcome when the UI only
// needs the badge counts without the diff/commit work.
router.get('/:id/markers', async (req, res) => {
  try {
    const { id } = req.params;
    const turns = extractTurnsAny(id, { maxTurns: 50_000 });
    if (!turns.found) return res.status(404).json({ error: 'Session not found' });
    const prompts = turns.turns
      .filter(t => t.kind === 'user' && t.text)
      .map(t => ({ line: t.line, ts: t.ts, tsIso: t.tsIso, ...markPrompt(t.text!) }));
    res.json({ sessionId: id, prompts, summary: summarizeMarkers(prompts) });
  } catch (error) {
    console.error('Markers error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to mark prompts' });
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
      } else if (id.startsWith('codex_')) {
        // Codex sessions surfaced from a live filesystem scan aren't always
        // in memory_metadata yet — locate the rollout file on disk so we
        // can still render the conversation.
        tool = 'codex';
      } else if (id.startsWith('gemini_')) {
        tool = 'gemini';
      } else if (id.startsWith('opencode_')) {
        tool = 'opencode';
      }

      if (tool === 'claude' && !filePath) {
        try {
          filePath = getSessionPath(id);
          const { statSync } = await import('fs');
          mtime = statSync(filePath).mtimeMs;
        } catch {}
      } else if (tool === 'codex' && !filePath) {
        // Stripped id matches the rollout filename body: <timestamp>-<uuid>.
        const located = findCodexSessionFile(id.replace(/^codex_/, ''));
        if (located) {
          filePath = located.path;
          try {
            const { statSync } = await import('fs');
            mtime = statSync(filePath).mtimeMs;
          } catch {}
        }
      }

      // 2. Try Cache
      // PARSER_VERSION: bump when parser output shape changes so stale cache
      // entries from older buggy parsers are ignored instead of served.
      const PARSER_VERSION = 5;
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
      } else if (tool === 'codex') {
        if (!filePath) throw new Error('Session path not found');
        messages = await getCodexConversation(filePath);
        subagents = await getCodexSubagents(filePath);
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

    // Codex — JSONL stream from ~/.codex/sessions/YYYY/MM/DD/.
    if (id.startsWith('codex_')) {
      const located = findCodexSessionFile(id.replace(/^codex_/, ''));
      if (!located) return res.status(404).json({ error: 'Session not found' });
      const { readFileSync } = await import('fs');
      const lines: any[] = [];
      for (const line of readFileSync(located.path, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try { lines.push(JSON.parse(line)); } catch { /* skip */ }
      }
      return res.json({ sessionId: id, tool: 'codex', lines, count: lines.length });
    }

    // OpenCode — SQLite-backed; surface session row + its parts as the
    // canonical raw representation.
    if (id.startsWith('opencode_')) {
      const ocId = id.replace(/^opencode_/, '');
      const Database = (await import('better-sqlite3')).default;
      const path = (await import('path')).join((await import('os')).homedir(), '.local', 'share', 'opencode', 'opencode.db');
      try {
        const db = new Database(path, { readonly: true, fileMustExist: true });
        try {
          const session = db.prepare('SELECT * FROM session WHERE id = ?').get(ocId) as any;
          if (!session) return res.status(404).json({ error: 'Session not found' });
          const parts = db.prepare('SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC').all(ocId) as any[];
          const lines = parts.map(p => {
            let data: any;
            try { data = JSON.parse(p.data); } catch { data = p.data; }
            return { id: p.id, message_id: p.message_id, time_created: p.time_created, data };
          });
          return res.json({ sessionId: id, tool: 'opencode', session, lines, count: lines.length });
        } finally { db.close(); }
      } catch (e) {
        console.error('OpenCode raw error:', e);
        return res.status(404).json({ error: e instanceof Error ? e.message : 'OpenCode database not found' });
      }
    }

    // Gemini — single JSON file under ~/.gemini/tmp/<hash>/chats/.
    if (id.startsWith('gemini_')) {
      const store = new MemoryStore();
      let filePath = '';
      try {
        const item = store.getItem(id, 'session' as SourceType);
        if (item) filePath = item.file_path;
      } finally { store.close(); }
      if (!filePath) return res.status(404).json({ error: 'Session not found' });
      const { readFileSync } = await import('fs');
      const json = JSON.parse(readFileSync(filePath, 'utf-8'));
      const messages = Array.isArray(json.messages) ? json.messages : [];
      return res.json({ sessionId: id, tool: 'gemini', lines: messages, count: messages.length, raw: json });
    }

    // Claude — original path.
    const sessionPath = getSessionPath(id);
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
      tool: 'claude',
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
