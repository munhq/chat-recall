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
const MAX_CHARS = 2000;
const OVERLAP = 100;

/**
 * Split a turn's text into ≤MAX_CHARS windows on PARAGRAPH boundaries (C6):
 * pack whole paragraphs together until the next won't fit, and only hard-cut
 * (with overlap) a single paragraph that's itself larger than the window. This
 * keeps chunks readable in isolation instead of slicing mid-sentence.
 */
function windowText(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const paras = text.split(/\n\s*\n/);
  const out: string[] = [];
  let buf = '';
  const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
  for (const p of paras) {
    if (p.length > MAX_CHARS) {
      flush();
      for (let off = 0; off < p.length; off += (MAX_CHARS - OVERLAP)) out.push(p.slice(off, off + MAX_CHARS));
      continue;
    }
    if (buf.length + p.length + 2 > MAX_CHARS) flush();
    buf += (buf ? '\n\n' : '') + p;
  }
  flush();
  return out;
}

export function chunksFromTurns(
  sessionId: string,
  turns: SessionTurn[],
  projectPath: string,
  mtime: number,
  projectId?: string,
  // C3/C4: the session's opening prompt — used to build a self-describing title
  // for every chunk and to emit one dedicated searchable first_prompt chunk.
  firstPrompt?: string,
): SessionChunk[] {
  const TOOL_RESULT_CAP = 60;
  const out: SessionChunk[] = [];
  let i = 0;
  let toolResults = 0;

  // A human-readable descriptor so an isolated search hit says what it is,
  // instead of showing a blank title (C3): "<opening prompt> · <date> · <project>".
  const proj = projectPath.split('/').filter(Boolean).pop() || '';
  const date = mtime ? new Date(mtime).toISOString().slice(0, 10) : '';
  const fp = (firstPrompt || '').replace(/\s+/g, ' ').trim();
  const title = [fp.slice(0, 70), date, proj].filter(Boolean).join(' · ');

  // C5: skip near-duplicate windows within a session (a decision restated
  // across turns, boilerplate) so the index isn't diluted with repetition.
  // Signature = normalized 200-char prefix; cheap and exact enough for FTS.
  const seenText = new Set<string>();
  const push = (base: string, text: string, chunkType: string) => {
    const sig = text.replace(/\s+/g, ' ').trim().slice(0, 200).toLowerCase();
    if (sig && seenText.has(sig)) return;
    if (sig) seenText.add(sig);
    out.push({ chunkId: `${sessionId}:sync:${i++}`, itemId: sessionId, sourceType: 'session' as SourceType, title, text, chunkType, projectPath, projectId, filePath: '', mtime });
  };

  // C4: a dedicated first_prompt chunk — the opening intent is high-signal for
  // "find the session where I was working on X" and wasn't searchable before.
  if (fp) push('first_prompt', fp.slice(0, MAX_CHARS), 'first_prompt');

  for (const t of turns) {
    let base: 'user_context' | 'assistant' | 'tool_result';
    if (t.role === 'user') base = 'user_context';
    else if (t.role === 'assistant') base = 'assistant';
    else if (t.role === 'tool_result') {
      if (toolResults >= TOOL_RESULT_CAP) continue;
      base = 'tool_result';
    } else continue; // tool_use (the call input) is noise; only results are indexed
    if (!t.text?.trim()) continue;
    if (base === 'tool_result') toolResults++;
    for (const text of windowText(t.text)) {
      let chunkType: string = base;
      // Raw tool output isn't a decision/preference — don't run the classifier
      // on it (it would mislabel command output as a "milestone", etc.).
      if (base !== 'tool_result') {
        const cls = classifyChunk(text);
        if (cls.memoryType !== 'general') chunkType = `${base}:${cls.memoryType}:imp${cls.importance}`;
      }
      push(base, text, chunkType);
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
