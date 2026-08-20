/**
 * ⚠️ RESERVED — NOT THE PRODUCTION CHUNKER. Do not assume this runs.
 *
 * This "smart chunker" feeds the DISABLED LanceDB local index (via
 * `SessionSource`, itself only reached on the sqlite/test backend). The shipped
 * product chunks synced sessions with `chunksFromTurns` in
 * `server/src/services/session-chunks.ts` — that is what actually indexes your
 * data. This file is kept as a head-start for a possible future local mode and
 * because its ideas (summary-first, tool-output, overlap) informed the server
 * chunker. If you change chunking behaviour, change `chunksFromTurns`, not this.
 *
 * ── original doc ──
 * Smart chunking for Claude Code sessions.
 *
 * Strategy:
 * 1. Primary: Use existing Claude summaries (best signal)
 * 2. Secondary: First user prompt (captures intent)
 * 3. Tertiary: User messages combined (for context)
 * 4. Quaternary: Assistant key responses (what was discovered/explained)
 * 5. Quinary: Tool results and web searches (valuable context)
 */

import type { SessionEntry, SessionContent } from './session.js';
import { isToolOutputRedactionEnabled, redactToolResultBody } from '../core/secret-redactor.js';

export interface SessionChunk {
  chunkId: string; // session_id + chunk_type + index
  sessionId: string;
  chunkType: 'summary' | 'first_prompt' | 'user_context' | 'assistant' | 'tool_result' | 'web_search';
  text: string;
  
  // Metadata from session entry
  projectPath: string;
  created: string;
  modified: string;
  mtime: number;
  firstPrompt: string; // Always include for display
  
  // Source reference for retrieval
  sourceFile: string;  // Path to session JSONL
  sourceLine: number;  // Line number in file (0 = not applicable)
}

/**
 * Claude Code and related clients occasionally prepend status banners
 * to user messages (e.g. when MCP servers fail or context runs low).
 * They aren't part of the user's intent and shouldn't show up in
 * summaries, previews, or search hits.
 */
const INJECTED_BANNERS: RegExp[] = [
  /MCP issues detected\. ?Run \/mcp list for status\.?/g,
  /Context low[^\n]*Run \/compact[^\n]*/g,
  /API Error:[^\n]{0,120}/g,
];

export function stripInjectedBanners(text: string): string {
  let result = text;
  for (const re of INJECTED_BANNERS) result = result.replace(re, ' ');
  return result;
}

function cleanText(text: string): string {
  let result = text.replace(/<system-reminder>.*?<\/system-reminder>/gs, '');
  result = stripInjectedBanners(result);
  result = result.replace(/\x1b\[[0-9;]*m/g, '');
  result = result.replace(/\s+/g, ' ');
  return result.trim();
}

/**
 * Split a long message into 500-char windows so the searchable surface
 * actually covers the whole text instead of only its first ~2 KB.
 *
 * Windows overlap by 80 chars so a term that lands on a boundary
 * isn't split between two chunks and made unfindable. We cap windows
 * per message so a 200 KB pasted log doesn't generate hundreds of
 * chunks per single message.
 */
function windowText(text: string, maxChars: number, maxWindows = 12): string[] {
  const clean = cleanText(text);
  if (clean.length <= maxChars) return clean ? [clean] : [];
  const out: string[] = [];
  const overlap = 80;
  const step = Math.max(1, maxChars - overlap);
  for (let i = 0; i < clean.length && out.length < maxWindows; i += step) {
    out.push(clean.slice(i, i + maxChars));
  }
  return out;
}

export function chunkSession(
  entry: SessionEntry,
  content: SessionContent,
  // Cap raised from 8 → 80. The old cap meant only the opening of every
  // session was searchable; mid-conversation technical content (CPU
  // models, error codes, deep tool output) was silently dropped from
  // FTS5 and the vector index.
  maxChunks = 80,
  maxTokensPerChunk = 500
): SessionChunk[] {
  const chunks: SessionChunk[] = [];

  // Estimate ~4 chars per token
  const maxChars = maxTokensPerChunk * 4;
  
  // Common metadata
  const baseData = {
    sessionId: entry.sessionId,
    projectPath: entry.projectPath,
    created: entry.created,
    modified: entry.modified,
    mtime: entry.fileMtime,
    firstPrompt: entry.firstPrompt || content.firstPrompt,
    sourceFile: content.sessionPath,
  };
  
  // 1. Summary chunks (highest priority)
  for (let i = 0; i < Math.min(2, content.summaries.length); i++) {
    const summary = content.summaries[i];
    if (!summary?.trim()) continue;
    
    const chunkText = cleanText(summary.slice(0, maxChars));
    if (chunkText.length > 8000) {
      chunks.push({
        chunkId: `${entry.sessionId}_summary_${i}`,
        chunkType: 'summary',
        text: chunkText.slice(0, 8000),
        sourceLine: 0,
        ...baseData,
      });
    } else {
      chunks.push({
        chunkId: `${entry.sessionId}_summary_${i}`,
        chunkType: 'summary',
        text: chunkText,
        sourceLine: 0,
        ...baseData,
      });
    }
  }
  
  if (chunks.length >= maxChunks) {
    return chunks.slice(0, maxChunks);
  }
  
  // 2. First prompt chunk
  const firstPrompt = entry.firstPrompt || content.firstPrompt;
  if (firstPrompt?.trim()) {
    const firstLine = content.userMessages[0]?.lineNumber || 0;
    
    chunks.push({
      chunkId: `${entry.sessionId}_first_prompt`,
      chunkType: 'first_prompt',
      text: cleanText(firstPrompt.slice(0, maxChars)),
      sourceLine: firstLine,
      ...baseData,
    });
  }
  
  if (chunks.length >= maxChunks) {
    return chunks.slice(0, maxChunks);
  }
  
  // 3. Per-message user chunks for FULL conversation coverage.
  //    The old "combined first 5 user messages × 500 chars" scheme threw
  //    away everything past message #5 and truncated each at 500 chars,
  //    so any technical content (CPU models, error strings, etc.) past
  //    the opening turns was unsearchable. Now every user message gets
  //    its own chunk, and long messages get windowed.
  const userStart = firstPrompt ? 1 : 0;
  for (let i = userStart; i < content.userMessages.length; i++) {
    if (chunks.length >= maxChunks) break;
    const msg = content.userMessages[i];
    if (!msg.text.trim()) continue;
    const windows = windowText(msg.text, maxChars);
    for (let w = 0; w < windows.length; w++) {
      if (chunks.length >= maxChunks) break;
      chunks.push({
        chunkId: `${entry.sessionId}_user_${i}_${w}`,
        chunkType: 'user_context',
        text: windows[w],
        sourceLine: msg.lineNumber,
        ...baseData,
      });
    }
  }

  if (chunks.length >= maxChunks) {
    return chunks.slice(0, maxChunks);
  }

  // 4. Per-message assistant chunks. Same logic — keep all messages,
  //    window the long ones. Drop tiny acks (< 50 chars) which are
  //    purely conversational noise.
  for (let i = 0; i < content.assistantMessages.length; i++) {
    if (chunks.length >= maxChunks) break;
    const msg = content.assistantMessages[i];
    if (!msg.text.trim() || msg.text.length <= 50) continue;
    const windows = windowText(msg.text, maxChars);
    for (let w = 0; w < windows.length; w++) {
      if (chunks.length >= maxChunks) break;
      chunks.push({
        chunkId: `${entry.sessionId}_assistant_${i}_${w}`,
        chunkType: 'assistant',
        text: windows[w],
        sourceLine: msg.lineNumber,
        ...baseData,
      });
    }
  }

  if (chunks.length >= maxChunks) {
    return chunks.slice(0, maxChunks);
  }

  // 5. Tool results — keep more of them, but still privilege web searches.
  if (content.toolResults.length > 0) {
    const webSearches = content.toolResults.filter(r => r.contentType === 'web_search');
    const otherResults = content.toolResults.filter(r => r.contentType !== 'web_search');

    // Bumped from (2 web + 1 other) → (5 web + 10 other). The old limit
    // meant deep tool output (which often contains the literal terms the
    // user would later search for) was almost entirely thrown away.
    const resultsToProcess = [...webSearches.slice(0, 5), ...otherResults.slice(0, 10)];

    // Privacy gate: when on, replace non-web tool result bodies with a
    // placeholder before chunking so the index never sees command output
    // (most common accidental-secret carrier). Web search results stay —
    // they're public data and useful for retrieval.
    const stripBodies = isToolOutputRedactionEnabled();

    for (let i = 0; i < resultsToProcess.length; i++) {
      if (chunks.length >= maxChunks) break;

      const result = resultsToProcess[i];
      if (result.text.trim()) {
        const body = stripBodies && result.contentType !== 'web_search'
          ? redactToolResultBody(result.contentType, result.text)
          : result.text.slice(0, maxChars);
        chunks.push({
          chunkId: `${entry.sessionId}_${result.contentType}_${i}`,
          chunkType: result.contentType as SessionChunk['chunkType'],
          text: cleanText(body),
          sourceLine: result.lineNumber,
          ...baseData,
        });
      }
    }
  }
  
  return chunks.slice(0, maxChunks);
}
