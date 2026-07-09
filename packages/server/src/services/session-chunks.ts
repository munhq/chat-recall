/**
 * Shared FTS chunk-building for a session's conversation — the single source of
 * truth used by BOTH the sync ingest path (routes/sync.ts) and the server-side
 * self-heal (services/self-heal.ts). Kept here so a rebuilt-from-archive session
 * indexes identically to a freshly-synced one; no divergence between the two
 * write paths.
 */
import type { SourceType } from '../imports.js';
import { classifyChunk } from '../imports.js';

export interface SessionTurn {
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  text: string;
}

export interface SessionChunk {
  chunkId: string;
  itemId: string;
  sourceType: SourceType;
  title: string;
  text: string;
  chunkType: string;
  projectPath: string;
  projectId?: string;
  filePath: string;
  mtime: number;
}

/** Chunk a conversation's turns for FTS. Text turns only (Bash outputs would
 *  bury conversational content in ranking); long turns split so a wall-of-text
 *  doesn't dominate BM25. Chunk ids are `<session>:sync:<i>` — the ingest and
 *  heal paths share this scheme so re-indexing replaces cleanly. */
export function chunksFromTurns(
  sessionId: string,
  turns: SessionTurn[],
  projectPath: string,
  mtime: number,
  projectId?: string,
): SessionChunk[] {
  const MAX_CHARS = 2000;
  const out: SessionChunk[] = [];
  let i = 0;
  for (const t of turns) {
    if (t.role !== 'user' && t.role !== 'assistant') continue;
    if (!t.text?.trim()) continue;
    for (let off = 0; off < t.text.length; off += MAX_CHARS) {
      const text = t.text.slice(off, off + MAX_CHARS);
      let chunkType = t.role === 'user' ? 'user_context' : 'assistant';
      const cls = classifyChunk(text);
      if (cls.memoryType !== 'general') chunkType = `${chunkType}:${cls.memoryType}:imp${cls.importance}`;
      out.push({
        chunkId: `${sessionId}:sync:${i++}`,
        itemId: sessionId,
        sourceType: 'session' as SourceType,
        title: '',
        text,
        chunkType,
        projectPath,
        projectId,
        filePath: '',
        mtime,
      });
    }
  }
  return out;
}

export interface EnvSubagent { id?: string; kind?: string; messages?: Array<{ content?: string }> }

const SUBAGENT_WINDOW = 2000, SUBAGENT_OVERLAP = 100, SUBAGENT_MAX_WINDOWS = 120;

/** Window each subagent transcript into ≤2000-char slices (embed-safe: a single
 *  200k-char chunk HARD-FAILS a hosted embedder's token limit). Window id
 *  `<session>:subagent:<id>[:w<N>]` keeps the marker recall_subagent_search
 *  parses; the first window keeps the legacy bare id for backward-compat. */
export function subagentChunks(
  sessionId: string,
  subagents: EnvSubagent[],
  projectPath: string,
  mtime: number,
): SessionChunk[] {
  return subagents.flatMap((sa) => {
    const text = (sa.messages ?? []).map((m) => m.content).filter((c): c is string => !!c && c.trim().length > 0).join('\n');
    if (!text.trim() || !sa.id) return [];
    const kind = sa.kind || 'other';
    const step = Math.max(1, SUBAGENT_WINDOW - SUBAGENT_OVERLAP);
    const windows: string[] = [];
    for (let i = 0; i < text.length && windows.length < SUBAGENT_MAX_WINDOWS; i += step) {
      windows.push(text.slice(i, i + SUBAGENT_WINDOW));
    }
    return windows.map((w, wi): SessionChunk => ({
      chunkId: wi === 0 ? `${sessionId}:subagent:${sa.id}` : `${sessionId}:subagent:${sa.id}:w${wi}`,
      itemId: sessionId,
      sourceType: 'session' as SourceType,
      title: `subagent ${sa.id} [${kind}]${wi > 0 ? ` (${wi + 1})` : ''}`,
      text: w,
      chunkType: `subagent:${kind}`,
      projectPath,
      filePath: '',
      mtime,
    }));
  });
}
