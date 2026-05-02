/**
 * Interleaved user/assistant/tool-result turn extractor.
 *
 * extractConversationContext() in core/context.ts gives a deduplicated bag of
 * "userInputs", "claudeWork", "decisions" — useful for a high-level summary
 * but lossy: it doesn't preserve order, doesn't keep assistant text more than
 * twice, and doesn't keep bash stdout / exit codes that are critical for
 * verifying "done" claims.
 *
 * This module returns turns in transcript order with enough payload to judge
 * what the agent actually did and what tool output it saw — exactly the gap
 * called out in the review session.
 */

import { readFileSync, statSync } from 'fs';
import { findSessionFile, resolveSessionContentPaths, detectTool } from './live-session-scan.js';

export type TurnKind = 'user' | 'assistant_text' | 'tool_use' | 'tool_result';

export interface SessionTurn {
  kind: TurnKind;
  ts: number;
  tsIso?: string;
  line: number;
  // Content shape varies by kind:
  text?: string;                                          // user / assistant_text
  toolName?: string;                                      // tool_use / tool_result
  toolUseId?: string;                                     // both
  toolInputSummary?: string;                              // tool_use — short
  command?: string;                                       // tool_use Bash command
  resultSummary?: string;                                 // tool_result — short
  resultIsError?: boolean;                                // tool_result
  resultExitCode?: number;                                // tool_result for Bash, parsed when present
  resultBytes?: number;                                   // tool_result raw size
}

export interface ExtractedTurns {
  sessionId: string;
  found: boolean;
  turns: SessionTurn[];
  /** Exposed so callers don't have to reparse for the same numbers. */
  startMs: number;
  endMs: number;
}

const SHORT = 600;

function safeParse(line: string): Record<string, unknown> | null {
  try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
}

function shortenText(text: string, max = SHORT): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function summariseToolInput(toolName: string, input: Record<string, unknown>): { summary: string; command?: string } {
  if (!input) return { summary: '' };
  if (toolName === 'Bash') {
    const cmd = typeof input.command === 'string' ? (input.command as string) : '';
    return { summary: cmd.slice(0, 240), command: cmd };
  }
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    return { summary: typeof input.file_path === 'string' ? `${input.file_path}` : (typeof input.notebook_path === 'string' ? input.notebook_path as string : '') };
  }
  if (toolName === 'Write') {
    const len = typeof input.content === 'string' ? (input.content as string).length : 0;
    return { summary: `${typeof input.file_path === 'string' ? input.file_path : ''} (${len} bytes)` };
  }
  if (toolName === 'Read') {
    return { summary: typeof input.file_path === 'string' ? (input.file_path as string) : '' };
  }
  if (toolName === 'Grep' || toolName === 'Glob') {
    const pat = (input.pattern as string) || (input.query as string) || '';
    return { summary: pat.slice(0, 240) };
  }
  // Fallback: stringify the first scalar field.
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > 0) return { summary: `${k}: ${v.slice(0, 200)}` };
    if (typeof v === 'number' || typeof v === 'boolean') return { summary: `${k}: ${v}` };
  }
  return { summary: '' };
}

/**
 * Detect "exit code: N" markers in tool_result content. Bash tool results
 * commonly include an exit code line; pulling it out as a structured field
 * lets the UI surface "❌ exit 1" without parsing strings on the client.
 */
function parseExitCode(text: string): number | undefined {
  const m = text.match(/(?:^|\n)\s*(?:exit\s+code|returncode|exit\s+status|exit)\s*[:=]\s*(\d+)\b/i);
  return m ? Number(m[1]) : undefined;
}

export function extractTurns(sessionId: string, opts: { maxTurns?: number; assistantMax?: number } = {}): ExtractedTurns {
  const tool = detectTool(sessionId);
  if (tool !== 'claude') return { sessionId, found: false, turns: [], startMs: 0, endMs: 0 };

  const located = findSessionFile(sessionId);
  if (!located) return { sessionId, found: false, turns: [], startMs: 0, endMs: 0 };
  const paths = resolveSessionContentPaths(located.path);

  const maxTurns = opts.maxTurns ?? 5000;
  const assistantMax = opts.assistantMax ?? 1500;

  const turns: SessionTurn[] = [];
  let startMs = 0, endMs = 0;
  let lineNum = 0;

  outer: for (const filePath of paths) {
    let mtime = 0;
    try { mtime = statSync(filePath).mtimeMs; } catch { /* */ }
    let raw = '';
    try { raw = readFileSync(filePath, 'utf-8'); } catch { continue; }

    for (const line of raw.split('\n')) {
      lineNum++;
      if (!line.trim()) continue;
      const obj = safeParse(line);
      if (!obj) continue;
      const tsIso = typeof obj.timestamp === 'string' ? (obj.timestamp as string) : undefined;
      const ts = tsIso ? Date.parse(tsIso) || mtime : mtime;
      if (ts) {
        if (!startMs || ts < startMs) startMs = ts;
        if (!endMs || ts > endMs) endMs = ts;
      }

      if (obj.type === 'user') {
        const msg = obj.message as Record<string, unknown> | undefined;
        const content = msg?.content;
        let userText = '';
        let toolResultsHere: Array<{ id: string; body: string; isError: boolean }> = [];
        if (typeof content === 'string') userText = content;
        else if (Array.isArray(content)) {
          const parts: string[] = [];
          for (const item of content) {
            if (!item || typeof item !== 'object') continue;
            const it = item as Record<string, unknown>;
            if (it.type === 'text') {
              const t = it.text;
              if (typeof t === 'string') parts.push(t);
            } else if (it.type === 'tool_result') {
              const id = typeof it.tool_use_id === 'string' ? (it.tool_use_id as string) : '';
              let body = '';
              const c = it.content;
              if (typeof c === 'string') body = c;
              else if (Array.isArray(c)) {
                for (const sub of c) {
                  if (sub && typeof sub === 'object' && (sub as Record<string, unknown>).type === 'text') {
                    const t = (sub as Record<string, unknown>).text;
                    if (typeof t === 'string') body += t;
                  }
                }
              }
              toolResultsHere.push({ id, body, isError: it.is_error === true });
            }
          }
          userText = parts.join('\n');
        }
        // Skip system reminders and pure-tool-result messages with no text body.
        if (userText && !userText.includes('<system-reminder>')) {
          turns.push({ kind: 'user', ts, tsIso, line: lineNum, text: shortenText(userText, 1200) });
        }
        for (const tr of toolResultsHere) {
          turns.push({
            kind: 'tool_result',
            ts, tsIso, line: lineNum,
            toolUseId: tr.id,
            resultSummary: shortenText(tr.body, 800),
            resultIsError: tr.isError,
            resultExitCode: parseExitCode(tr.body),
            resultBytes: tr.body.length,
          });
        }
      } else if (obj.type === 'assistant') {
        const msg = obj.message as Record<string, unknown> | undefined;
        const content = msg?.content;
        if (!Array.isArray(content)) continue;
        for (const item of content) {
          if (!item || typeof item !== 'object') continue;
          const it = item as Record<string, unknown>;
          if (it.type === 'text') {
            const t = it.text;
            if (typeof t === 'string' && t.trim().length > 0) {
              turns.push({ kind: 'assistant_text', ts, tsIso, line: lineNum, text: shortenText(t, assistantMax) });
            }
          } else if (it.type === 'tool_use') {
            const toolName = typeof it.name === 'string' ? (it.name as string) : '';
            const id = typeof it.id === 'string' ? (it.id as string) : '';
            const input = (it.input as Record<string, unknown>) || {};
            const sum = summariseToolInput(toolName, input);
            turns.push({
              kind: 'tool_use',
              ts, tsIso, line: lineNum,
              toolName, toolUseId: id,
              toolInputSummary: sum.summary,
              command: sum.command,
            });
          }
        }
      }

      if (turns.length >= maxTurns) break outer;
    }
  }

  return { sessionId, found: true, turns, startMs, endMs };
}
