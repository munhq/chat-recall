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
import { canonicalEventsToMessages } from './from-events.js';

export * from './types.js';
export {
  buildRawContainer, gzipContainer, gunzipContainer, mapContainerText,
  parseTranscriptFromContainer, parseOpenCodeDumpText, archiveRawSession,
  detectForkPredecessor,
  type RawContainer,
} from './raw.js';
export {
  updateShadow, snapshotShadow, seedShadow, readShadowContainer, writeShadowContainer,
  mergeContainer, mergeLineText, shadowFileFor, shadowRoot, shadowSizeOnDisk,
  type ShadowUpdate, type ShadowStatus, type ShadowMerge,
} from './shadow.js';
export { parseClaudeTranscript, parseClaudeSubagents } from './claude.js';
export { parseGeminiTranscript } from './gemini.js';
export { parseOpenCodeTranscript, parseOpenCodeSubagents } from './opencode.js';
export { parseCodexTranscript, parseCodexSubagents } from './codex.js';
export { canonicalEventsToMessages } from './from-events.js';

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
    const [tail, allSubagents] = await Promise.all([
      parseClaudeTranscript(located.path),
      parseClaudeSubagents(located.path),
    ]);
    // Compaction stitching: when Claude Code compacts, the prior history
    // moves into agent-acompact-* sidecars and the main JSONL keeps only
    // the tail. `--resume` reconstructs the whole conversation; so do we —
    // compact sidecars are spliced inline (chronological, before the tail)
    // instead of hidden in side panels, with a divider message so the seam
    // is visible. Non-compact subagents stay as panels.
    const compacts = allSubagents.filter((s) => s.kind === 'compact');
    const subagents = allSubagents.filter((s) => s.kind !== 'compact');
    let messages = tail;
    if (compacts.length > 0) {
      const stitched: TranscriptMessage[] = [];
      for (const c of compacts) {
        stitched.push(...c.messages);
        stitched.push({
          line: 0,
          role: 'summary',
          content: `— conversation compacted here (${c.id}) — earlier history above is the compaction record —`,
        });
      }
      messages = [...stitched, ...tail].map((m, i) => ({ ...m, line: i + 1 }));
    }
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

  // Generic fallback for any registered backend that exposes a canonical event
  // stream (e.g. agy/Antigravity). Without this a newly-added ToolBackend parses
  // to null here and never syncs — exactly what dropped every agy session until
  // this was added. Explicit branches above keep their tool-specific handling
  // (Claude compaction stitching, etc.); this only ever runs for tools that have
  // none, so it can't regress them.
  try {
    const backend = getBackend(tool);
    if (backend?.readEvents) {
      const rawId = backend.toRawId(sessionId);
      const loc = backend.findSession(rawId);
      if (loc) {
        const messages = canonicalEventsToMessages(backend.readEvents(rawId));
        if (messages.length > 0) return { messages, subagents: [], mtime: loc.mtime || safeMtime(loc.path) };
      }
    }
  } catch { /* fall through to null */ }
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
  // Preserve structure: objects (Edit inputs with old_string/new_string,
  // tool results) stay objects when they fit — the viewer renders real
  // diffs from them. Only oversized values degrade to truncated strings.
  const cap = (v: unknown): unknown => {
    if (v === undefined) return undefined;
    if (typeof v === 'string') {
      return v.length > capChars ? v.slice(0, capChars) + `… [+${v.length - capChars} chars]` : v;
    }
    let s = '';
    try { s = JSON.stringify(v) ?? ''; } catch { return undefined; }
    if (s.length <= capChars * 4) return v; // structured + reasonably sized → keep as-is
    if (Array.isArray(v)) return s.slice(0, capChars) + `… [+${s.length - capChars} chars]`;
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = cap(val);
      return o;
    }
    return v;
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
