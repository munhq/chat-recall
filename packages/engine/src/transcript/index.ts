/**
 * Canonical transcript entry point — THE one way a conversation is parsed.
 *
 * `parseTranscript(sessionId)` routes to the per-tool parser via the same
 * backend registry everything else uses, and returns the canonical
 * {messages, subagents} shape. The indexer materializes this into
 * content_cache; every dashboard (local, self-host, SaaS) renders that.
 */
import { statSync } from 'fs';
import { detectTool, findSessionFile } from '../core/live-session-scan.js';
import { getBackend } from '../core/tool-backend.js';
import '../core/backends/index.js'; // side-effect: registers the backends

import type { Transcript, TranscriptMessage, Subagent } from './types.js';
import { TRANSCRIPT_VERSION } from './types.js';
import { parseClaudeTranscript, parseClaudeSubagents } from './claude.js';
import { parseGeminiTranscript } from './gemini.js';
import { parseOpenCodeTranscript, parseOpenCodeSubagents } from './opencode.js';
import { parseCodexTranscript, parseCodexSubagents } from './codex.js';

export * from './types.js';
export { parseClaudeTranscript, parseClaudeSubagents } from './claude.js';
export { parseGeminiTranscript } from './gemini.js';
export { parseOpenCodeTranscript, parseOpenCodeSubagents } from './opencode.js';
export { parseCodexTranscript, parseCodexSubagents } from './codex.js';

export interface ParsedTranscript extends Transcript {
  /** Source file mtime (ms) at parse time — the envelope freshness key. */
  mtime: number;
}

/** Parse a session (any tool, prefixed or bare id) into the canonical shape.
 *  Returns null when the session can't be located. */
export async function parseTranscript(sessionId: string): Promise<ParsedTranscript | null> {
  const tool = detectTool(sessionId);

  if (tool === 'claude') {
    const located = findSessionFile(sessionId);
    if (!located) return null;
    const [messages, subagents] = await Promise.all([
      parseClaudeTranscript(located.path),
      parseClaudeSubagents(located.path),
    ]);
    return { messages, subagents, mtime: safeMtime(located.path) };
  }

  if (tool === 'gemini') {
    const loc = getBackend('gemini').findSession(sessionId);
    if (!loc) return null;
    return { messages: await parseGeminiTranscript(loc.path), subagents: [], mtime: loc.mtime || safeMtime(loc.path) };
  }

  if (tool === 'opencode') {
    const messages = await parseOpenCodeTranscript(sessionId);
    if (messages.length === 0) return null;
    const subagents = await parseOpenCodeSubagents(sessionId);
    const loc = getBackend('opencode').findSession(sessionId);
    return { messages, subagents, mtime: loc?.mtime || 0 };
  }

  if (tool === 'codex') {
    const loc = getBackend('codex').findSession(sessionId);
    if (!loc) return null;
    const [messages, subagents] = await Promise.all([
      parseCodexTranscript(loc.path),
      parseCodexSubagents(loc.path),
    ]);
    return { messages, subagents, mtime: loc.mtime || safeMtime(loc.path) };
  }

  return null;
}

function safeMtime(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

/**
 * Trim a transcript for the sync wire: tool inputs/results and thinking are
 * capped so a session's envelope stays kilobytes, not megabytes — the raw
 * replay (full file contents inside tool calls) never leaves the machine.
 * Counts are preserved exactly; only payload bodies are truncated.
 */
export function trimTranscriptForSync(t: Transcript, capChars = 2000): Transcript {
  const cap = (v: unknown): unknown => {
    const s = typeof v === 'string' ? v : v === undefined ? undefined : JSON.stringify(v);
    if (s === undefined) return undefined;
    return s.length > capChars ? s.slice(0, capChars) + `… [+${s.length - capChars} chars]` : s;
  };
  const trimMsg = (m: TranscriptMessage): TranscriptMessage => ({
    ...m,
    thinking: m.thinking !== undefined ? (cap(m.thinking) as string) : undefined,
    toolCalls: m.toolCalls?.map((c) => ({
      name: c.name,
      input: cap(c.input),
      result: c.result !== undefined ? cap(c.result) : undefined,
      isError: c.isError,
    })),
  });
  const trimSub = (s: Subagent): Subagent => ({ ...s, messages: s.messages.map(trimMsg) });
  return { messages: t.messages.map(trimMsg), subagents: t.subagents.map(trimSub) };
}

/**
 * Materialize a session's canonical envelope into content_cache (R2).
 * Called by the indexer for every new/changed session, and by the
 * conversation route's freshness hook for the actively-running session.
 * Returns false when the session can't be located/parsed.
 */
export async function writeTranscriptEnvelope(
  store: { setCachedContent(id: string, sourceType: string, mtime: number, content: string): Promise<void> | void },
  sessionId: string,
): Promise<boolean> {
  const t = await parseTranscript(sessionId);
  if (!t || (t.messages.length === 0 && t.subagents.length === 0)) return false;
  await store.setCachedContent(
    sessionId, 'session', Math.floor(t.mtime),
    JSON.stringify({ v: TRANSCRIPT_VERSION, messages: t.messages, subagents: t.subagents }),
  );
  return true;
}
