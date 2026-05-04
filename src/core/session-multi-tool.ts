/**
 * Per-tool session analysis (turns, file edits, commits, outcome) for the
 * non-Claude tools — Codex, Gemini, OpenCode. The Claude implementations
 * in session-turns / session-replay / session-outcome read Claude's
 * native tool_use shape directly, which doesn't apply to the other
 * tools. Each AI tool has its own equivalent — apply_patch payloads in
 * Codex JSONL, replace/write_file args in Gemini JSON, edit/write rows
 * in the OpenCode SQLite store — and this module surfaces them in the
 * same shapes the Claude pipeline produces, so the existing routes and
 * UI panels work unchanged.
 */

import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { createHash } from 'crypto';
import { createPatch } from 'diff';

import { detectTool, findCodexSessionFile } from './live-session-scan.js';
import type { ExtractedTurns, SessionTurn } from './session-turns.js';
import { extractTurns } from './session-turns.js';
import type { SessionDiffResult, FileReplayResult } from './session-replay.js';
import { replaySession } from './session-replay.js';
import { getSessionCommits } from './session-git.js';
import type { SessionCommitsResult } from './session-git.js';
import { markPrompt, summarizeMarkers } from './session-sentiment.js';
import type { MarkedPrompt } from './session-sentiment.js';
import { computeOutcome } from './session-outcome.js';
import type { SessionOutcome, SessionDecision, SessionBlocker } from './session-outcome.js';

// ── Universal turn extraction ──────────────────────────────────────

/**
 * Extract turns for any AI tool. Falls back to the existing Claude
 * extractor when the session id has no tool prefix.
 */
export function extractTurnsAny(
  sessionId: string,
  opts: { maxTurns?: number; assistantMax?: number } = {},
): ExtractedTurns {
  const tool = detectTool(sessionId);
  if (tool === 'claude') return extractTurns(sessionId, opts);
  if (tool === 'codex')   return extractCodexTurns(sessionId, opts);
  if (tool === 'gemini')  return extractGeminiTurns(sessionId, opts);
  if (tool === 'opencode') return extractOpencodeTurns(sessionId, opts);
  return { sessionId, found: false, turns: [], startMs: 0, endMs: 0 };
}

const SHORT = 600;
function shortenText(text: string, max = SHORT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function tsFrom(iso: unknown, fallback: number): { ts: number; tsIso?: string } {
  if (typeof iso === 'string') {
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return { ts: t, tsIso: iso };
  }
  return { ts: fallback };
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((seg) => (typeof seg === 'string' ? seg : seg && typeof seg === 'object' && typeof (seg as any).text === 'string' ? (seg as any).text : ''))
    .filter(Boolean)
    .join('\n');
}

function isCodexInjectedWrapper(text: string): boolean {
  const t = text.trim();
  return t.startsWith('<environment_context>') ||
    t.startsWith('<permissions instructions>') ||
    t.startsWith('<user_instructions>') ||
    t.startsWith('<system_prompt>');
}

function extractCodexTurns(sessionId: string, opts: { maxTurns?: number }): ExtractedTurns {
  const located = findCodexSessionFile(sessionId.replace(/^codex_/, ''));
  if (!located) return { sessionId, found: false, turns: [], startMs: 0, endMs: 0 };

  let raw = '';
  let mtime = 0;
  try { raw = readFileSync(located.path, 'utf-8'); mtime = statSync(located.path).mtimeMs; }
  catch { return { sessionId, found: false, turns: [], startMs: 0, endMs: 0 }; }

  const maxTurns = opts.maxTurns ?? 5000;
  const turns: SessionTurn[] = [];
  let startMs = 0, endMs = 0;
  let lineNum = 0;

  // Maps function_call call_id → command (Codex emits matching call_id on the
  // function_call_output so we can reconnect tool invocations and results).
  const callIdToCommand = new Map<string, string>();

  for (const line of raw.split('\n')) {
    lineNum++;
    if (!line.trim()) continue;
    let obj: any; try { obj = JSON.parse(line); } catch { continue; }

    const { ts, tsIso } = tsFrom(obj.timestamp, mtime);
    if (ts) { if (!startMs || ts < startMs) startMs = ts; if (ts > endMs) endMs = ts; }

    const payload = obj.payload || {};
    if (obj.type === 'event_msg' && payload.type === 'user_message') {
      const text = String(payload.message || '').trim();
      if (text && !isCodexInjectedWrapper(text)) {
        turns.push({ kind: 'user', ts, tsIso, line: lineNum, text: shortenText(text, 1200) });
      }
    } else if (obj.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      const text = flattenContent(payload.content).trim();
      if (text) turns.push({ kind: 'assistant_text', ts, tsIso, line: lineNum, text: shortenText(text, 1500) });
    } else if (obj.type === 'response_item' && payload.type === 'function_call') {
      const name = String(payload.name || '');
      const callId = String(payload.call_id || '');
      let args: any = payload.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep string */ } }

      let command: string | undefined;
      let summary = name;
      if (name === 'shell' || name === 'exec_command' || name === 'local_shell') {
        const cmd = Array.isArray(args?.command) ? args.command.join(' ') : String(args?.command ?? '');
        command = cmd;
        summary = `$ ${cmd}`.slice(0, 120);
      } else if (name === 'apply_patch') {
        const input = String(args?.input || '');
        const filesTouched = Array.from(input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)).map(m => m[1]);
        summary = `apply_patch: ${filesTouched.slice(0, 3).join(', ')}${filesTouched.length > 3 ? ` (+${filesTouched.length - 3})` : ''}`;
      } else if (typeof args === 'object' && args) {
        summary = `${name}(${Object.keys(args).slice(0, 3).join(', ')})`;
      }

      if (callId) callIdToCommand.set(callId, summary);
      turns.push({
        kind: 'tool_use', ts, tsIso, line: lineNum,
        toolName: name, toolUseId: callId,
        toolInputSummary: summary,
        command,
      });
    } else if (obj.type === 'response_item' && payload.type === 'function_call_output') {
      const callId = String(payload.call_id || '');
      const out = payload.output;
      let body = '';
      let isError = false;
      if (typeof out === 'string') body = out;
      else if (out && typeof out === 'object') {
        body = String(out.content ?? out.output ?? out.stdout ?? out.text ?? '');
        // Codex doesn't expose a clean `is_error` flag — check exit code or
        // common error markers in the output instead.
        const exitCode = typeof out.exit_code === 'number' ? out.exit_code : null;
        isError = exitCode !== null && exitCode !== 0;
      }
      turns.push({
        kind: 'tool_result', ts, tsIso, line: lineNum,
        toolUseId: callId,
        toolName: callIdToCommand.get(callId),
        resultSummary: shortenText(body, 800),
        resultIsError: isError,
        resultBytes: body.length,
      });
    }

    if (turns.length >= maxTurns) break;
  }

  return { sessionId, found: true, turns, startMs, endMs };
}

function extractGeminiTurns(sessionId: string, opts: { maxTurns?: number }): ExtractedTurns {
  // Gemini sessions aren't located by id alone — the indexer stores the file
  // path. We need to find it via the same projects mapping the live-scan
  // uses. Keep it simple: walk ~/.gemini/tmp/*/chats/ looking for a matching
  // sessionId in the JSON.
  const id = sessionId.replace(/^gemini_/, '');
  const tmpRoot = join(homedir(), '.gemini', 'tmp');
  if (!existsSync(tmpRoot)) return { sessionId, found: false, turns: [], startMs: 0, endMs: 0 };

  let filePath = '';
outer: for (const proj of readdirSync(tmpRoot, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const chats = join(tmpRoot, proj.name, 'chats');
    if (!existsSync(chats)) continue;
    for (const f of readdirSync(chats)) {
      if (!f.startsWith('session-') || !f.endsWith('.json')) continue;
      const fb = f.replace(/\.json$/, '');
      if (fb === id) { filePath = join(chats, f); break outer; }
      try {
        const j = JSON.parse(readFileSync(join(chats, f), 'utf-8'));
        if (j.sessionId === id) { filePath = join(chats, f); break outer; }
      } catch { /* skip */ }
    }
  }
  if (!filePath) return { sessionId, found: false, turns: [], startMs: 0, endMs: 0 };

  let json: any;
  let mtime = 0;
  try { json = JSON.parse(readFileSync(filePath, 'utf-8')); mtime = statSync(filePath).mtimeMs; }
  catch { return { sessionId, found: false, turns: [], startMs: 0, endMs: 0 }; }

  const messages = Array.isArray(json.messages) ? json.messages : [];
  const turns: SessionTurn[] = [];
  let startMs = 0, endMs = 0;
  let lineNum = 0;
  const maxTurns = opts.maxTurns ?? 5000;

  for (const m of messages) {
    lineNum++;
    const { ts, tsIso } = tsFrom(m?.timestamp, mtime);
    if (ts) { if (!startMs || ts < startMs) startMs = ts; if (ts > endMs) endMs = ts; }

    if (m?.type === 'user') {
      // Gemini user messages can be either a flat `text` string or a
      // `content` array of {text} segments — flatten both shapes.
      let text = '';
      if (typeof m.text === 'string') text = m.text;
      else if (Array.isArray(m.content)) text = flattenContent(m.content);
      else if (typeof m.content === 'string') text = m.content;
      text = text.trim();
      if (text) turns.push({ kind: 'user', ts, tsIso, line: lineNum, text: shortenText(text, 1200) });
    } else if (m?.type === 'gemini') {
      const text = (typeof m.text === 'string' ? m.text : flattenContent(m.content || [])).trim();
      if (text) turns.push({ kind: 'assistant_text', ts, tsIso, line: lineNum, text: shortenText(text, 1500) });
      const tcs = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      for (const tc of tcs) {
        const name = String(tc?.name || '');
        const args = tc?.args || {};
        const file = args.file_path || args.absolute_path || args.path || '';
        const summary = file ? `${name}(${basename(String(file))})` : name;
        turns.push({
          kind: 'tool_use', ts, tsIso, line: lineNum,
          toolName: name, toolUseId: String(tc?.id || ''),
          toolInputSummary: summary,
        });
        if (tc?.result !== undefined) {
          const body = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result);
          turns.push({
            kind: 'tool_result', ts, tsIso, line: lineNum,
            toolUseId: String(tc?.id || ''), toolName: name,
            resultSummary: shortenText(body, 800),
            resultIsError: tc?.status === 'error',
            resultBytes: body.length,
          });
        }
      }
    }
    if (turns.length >= maxTurns) break;
  }

  return { sessionId, found: true, turns, startMs, endMs };
}

function extractOpencodeTurns(sessionId: string, opts: { maxTurns?: number }): ExtractedTurns {
  const ocId = sessionId.replace(/^opencode_/, '');
  const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return { sessionId, found: false, turns: [], startMs: 0, endMs: 0 };

  let db: Database.Database;
  try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); }
  catch { return { sessionId, found: false, turns: [], startMs: 0, endMs: 0 }; }

  try {
    const sessRow = db.prepare('SELECT id FROM session WHERE id = ?').get(ocId);
    if (!sessRow) return { sessionId, found: false, turns: [], startMs: 0, endMs: 0 };

    // OpenCode's `message.role` lives inside the JSON `data` blob, not a
    // dedicated column, so pull message.data and parse it client-side.
    const parts = db.prepare(`
      SELECT p.id, p.message_id, p.time_created, p.data, m.data AS msg_data
      FROM part p JOIN message m ON m.id = p.message_id
      WHERE p.session_id = ? ORDER BY p.time_created ASC
    `).all(ocId) as Array<{ id: string; message_id: string; time_created: number; data: string; msg_data: string }>;

    const turns: SessionTurn[] = [];
    let startMs = 0, endMs = 0;
    let lineNum = 0;
    const maxTurns = opts.maxTurns ?? 5000;
    const callIdToTool = new Map<string, string>();

    for (const p of parts) {
      lineNum++;
      const ts = p.time_created;
      if (ts) { if (!startMs || ts < startMs) startMs = ts; if (ts > endMs) endMs = ts; }
      let d: any; try { d = JSON.parse(p.data); } catch { continue; }
      let role = '';
      try { role = String(JSON.parse(p.msg_data || '{}').role || ''); } catch { /* leave blank */ }
      const tsIso = ts ? new Date(ts).toISOString() : undefined;

      if (d?.type === 'text') {
        const text = String(d.text || '').trim();
        if (!text) continue;
        if (role === 'user') {
          turns.push({ kind: 'user', ts, tsIso, line: lineNum, text: shortenText(text, 1200) });
        } else {
          turns.push({ kind: 'assistant_text', ts, tsIso, line: lineNum, text: shortenText(text, 1500) });
        }
      } else if (d?.type === 'tool') {
        const name = String(d.tool || '');
        const callId = String(d.callID || d.id || p.id);
        const input = d?.state?.input || {};
        const file = input.filePath || input.file_path || input.path;
        const summary = file ? `${name}(${basename(String(file))})` : name;
        callIdToTool.set(callId, name);
        turns.push({
          kind: 'tool_use', ts, tsIso, line: lineNum,
          toolName: name, toolUseId: callId,
          toolInputSummary: summary,
          command: name === 'bash' && typeof input.command === 'string' ? input.command : undefined,
        });
        const out = d?.state?.output;
        if (out !== undefined && out !== null) {
          const body = typeof out === 'string' ? out : JSON.stringify(out);
          turns.push({
            kind: 'tool_result', ts, tsIso, line: lineNum,
            toolUseId: callId, toolName: name,
            resultSummary: shortenText(body, 800),
            resultIsError: d?.state?.status === 'error',
            resultBytes: body.length,
          });
        }
      }
      if (turns.length >= maxTurns) break;
    }

    return { sessionId, found: true, turns, startMs, endMs };
  } finally {
    db.close();
  }
}

// ── Universal diff replay ──────────────────────────────────────────

/**
 * Build a SessionDiffResult by walking each tool's native edit events.
 * Where we have both `before` and `after` content (Gemini replace,
 * OpenCode edit) we compute a unified diff and lines added/removed; for
 * pure writes we count every line as added.
 */
export function replaySessionAny(sessionId: string): SessionDiffResult {
  const tool = detectTool(sessionId);
  if (tool === 'claude') return replaySession(sessionId);
  if (tool === 'codex')   return replayCodexSession(sessionId);
  if (tool === 'gemini')  return replayGeminiSession(sessionId);
  if (tool === 'opencode') return replayOpenCodeSession(sessionId);
  return { sessionId, found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };
}

interface FileAccumulator {
  file: string;
  events: any[];   // FileEditEvent shape — we only fill the fields the UI uses
  before: string | null;
  after: string | null;
  succeeded: number;
  failed: number;
}

function makeFileResult(acc: FileAccumulator): FileReplayResult {
  let linesAdded = 0;
  let linesRemoved = 0;
  let diff = '';
  if (acc.before !== null && acc.after !== null && acc.before !== acc.after) {
    diff = createPatch(acc.file, acc.before, acc.after, '', '');
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
      else if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
    }
  } else if (acc.before === null && acc.after !== null) {
    linesAdded = acc.after.split('\n').length;
    diff = createPatch(acc.file, '', acc.after, '', '');
  }
  return {
    file: acc.file,
    events: acc.events,
    initialContent: acc.before,
    initialKnown: acc.before !== null,
    finalContent: acc.after,
    diff,
    linesAdded,
    linesRemoved,
    reverted: false,
    succeededEvents: acc.succeeded,
    failedEvents: acc.failed,
  };
}

/**
 * Walk a single Codex rollout file and accumulate file edits into the
 * given Map. Three signal sources:
 *   1. function_call name='apply_patch' with patch text in args.input
 *   2. event_msg/exec_command_end with Codex's pre-classified parsed_cmd
 *   3. response_item/function_call name='exec_command' (used by sub-agents)
 *      whose `cmd` string is a shell write (sed -i / cat > / tee / heredoc /
 *      apply_patch heredoc / printf > / echo > / append).
 *
 * Sub-agents only emit (3) — they don't get parsed_cmd events — so without
 * a heuristic shell parser their writes never surface in the diff.
 */
function walkCodexRolloutForEdits(path: string, accs: Map<string, FileAccumulator>): void {
  let raw = '';
  try { raw = readFileSync(path, 'utf-8'); } catch { return; }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj: any; try { obj = JSON.parse(line); } catch { continue; }

    if (obj?.type === 'response_item' && obj.payload?.type === 'function_call') {
      const name = obj.payload.name;
      let args: any = obj.payload.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep raw */ } }

      // (1) apply_patch as a typed function call
      if (name === 'apply_patch' && typeof args?.input === 'string') {
        for (const sec of parseCodexPatch(args.input)) {
          const acc = accs.get(sec.file) || { file: sec.file, events: [], before: null, after: null, succeeded: 0, failed: 0 };
          acc.events.push({ ts: 0, toolName: sec.kind === 'add' ? 'Write' : 'Edit', toolUseId: '', line: 0, succeeded: true });
          acc.succeeded++;
          if (sec.kind === 'add') { acc.before = ''; acc.after = sec.added.join('\n'); }
          else {
            (acc as any)._linesAdded = ((acc as any)._linesAdded || 0) + sec.added.length;
            (acc as any)._linesRemoved = ((acc as any)._linesRemoved || 0) + sec.removed.length;
          }
          accs.set(sec.file, acc);
        }
      }

      // (3) exec_command (sub-agents) — parse the cmd string for writes.
      if (name === 'exec_command' && typeof args?.cmd === 'string') {
        for (const w of parseShellWrites(args.cmd)) {
          const acc = accs.get(w.file) || { file: w.file, events: [], before: null, after: null, succeeded: 0, failed: 0 };
          acc.events.push({ ts: 0, toolName: w.kind === 'write' ? 'Write' : 'Edit', toolUseId: '', line: 0, succeeded: true });
          acc.succeeded++;
          if (w.content !== null) {
            // Heredoc with full content — we have the whole "after" image.
            // For an Add, before = ''. For an Edit/append, leave before null
            // (we don't know the prior state) but keep the after for a
            // partial-image diff.
            if (w.kind === 'write' && acc.before === null) acc.before = '';
            acc.after = w.content;
          }
          accs.set(w.file, acc);
        }
      }
    }

    // (2) event_msg/exec_command_end carries Codex's own classification
    // of the shell command — used by parent rollouts.
    if (obj?.type === 'event_msg' && obj.payload?.type === 'exec_command_end') {
      const parsed = Array.isArray(obj.payload.parsed_cmd) ? obj.payload.parsed_cmd : [];
      for (const c of parsed) {
        const t = String(c?.type || '');
        const file = String(c?.path || c?.file || '');
        if (!file || (t !== 'write' && t !== 'edit')) continue;
        const acc = accs.get(file) || { file, events: [], before: null, after: null, succeeded: 0, failed: 0 };
        acc.events.push({ ts: 0, toolName: t === 'write' ? 'Write' : 'Edit', toolUseId: '', line: 0, succeeded: true });
        acc.succeeded++;
        accs.set(file, acc);
      }
    }
  }
}

/**
 * Heuristic shell-command parser that extracts file writes Codex
 * sub-agents emit. Recognized patterns:
 *   sed -i [-e] '…' /path/file        → edit
 *   cat   > /path/file [<<'EOF' …EOF] → write (heredoc captures content)
 *   cat  >> /path/file [<<'EOF' …EOF] → edit
 *   tee  [-a] /path/file [<<'EOF']    → write/edit
 *   printf …  >  /path/file           → write
 *   printf … >> /path/file            → edit
 *   echo   …  >  /path/file           → write
 *   echo   … >> /path/file            → edit
 *   apply_patch '<<EOF…EOF'           → patch payload (parsed via parseCodexPatch)
 * False positives are filtered out: lines that are clearly grep/awk/etc.
 */
function parseShellWrites(cmd: string): Array<{ file: string; kind: 'write' | 'edit'; content: string | null }> {
  const out: Array<{ file: string; kind: 'write' | 'edit'; content: string | null }> = [];

  // Only inspect the first physical line of the command — anything past the
  // first newline is the heredoc body / multi-line script and should not be
  // parsed for redirects (that's what produced spurious files like 'PATCH'
  // or `{` from script bodies).
  const firstLine = cmd.split('\n', 1)[0].trim();
  if (!firstLine) return out;

  // Heredoc body, captured for content recovery on writes.
  const heredocMatch = cmd.match(/<<\s*-?['"]?([A-Za-z_][\w]*)['"]?\s*\n([\s\S]*?)\n\1\s*$/m);

  // Strip a single matching pair of surrounding quotes (heredoc filenames
  // in shell often look like `> "file.txt"` or `> 'file.txt'`).
  const stripQuotes = (s: string): string => {
    const m = s.match(/^(['"`])(.*)\1$/);
    return m ? m[2] : s;
  };

  // Path validity: must contain a slash OR be a relative path with a known
  // file extension. Reject brace-bits, redirect operators, devices.
  const looksLikeFile = (raw: string): boolean => {
    const s = stripQuotes(raw);
    if (!s || s.length < 2) return false;
    if (/^[{}()[\]<>|&;]/.test(s)) return false;
    if (s === '/dev/null' || s === '/dev/stdout' || s === '/dev/stderr') return false;
    return s.includes('/') || /\.\w{1,8}$/.test(s);
  };

  // 0) apply_patch heredoc — capture and parse the patch payload.
  if (/^apply_patch\b/.test(firstLine) && heredocMatch) {
    for (const sec of parseCodexPatch(heredocMatch[2])) {
      out.push({
        file: sec.file,
        kind: sec.kind === 'add' ? 'write' : 'edit',
        content: sec.kind === 'add' ? sec.added.join('\n') : null,
      });
    }
    return out;
  }

  // 1) sed -i [-e '…']* /path/file
  //    Captures the last argument; tolerates double-quoted scripts too.
  const sedMatch = firstLine.match(/^sed\s+-i\S*\s+(?:-e\s+(?:'[^']*'|"[^"]*")\s+)*(?:'[^']*'|"[^"]*"|\S+)\s+(\S+)\s*$/);
  if (sedMatch && looksLikeFile(sedMatch[1])) {
    out.push({ file: stripQuotes(sedMatch[1]), kind: 'edit', content: null });
    return out;
  }

  // 2) Redirection on the first line: `cmd > file`, `cmd >> file`. Only the
  //    last redirect on the line is interesting.
  const redirMatches = [...firstLine.matchAll(/(>{1,2})\s+(\S+)/g)];
  const lastRedir = redirMatches[redirMatches.length - 1];
  if (lastRedir && looksLikeFile(lastRedir[2])) {
    const file = stripQuotes(lastRedir[2]);
    const kind: 'write' | 'edit' = lastRedir[1] === '>>' ? 'edit' : 'write';
    const content = heredocMatch ? heredocMatch[2] : null;
    out.push({ file, kind, content });
  }

  // 3) `tee [-a] file` (with or without piping in). No `>` arrow.
  const teeMatch = firstLine.match(/(?:^|\|\s*)tee\s+(?:(-a)\s+)?(\S+)/);
  const teeFile = teeMatch ? stripQuotes(teeMatch[2]) : '';
  if (teeMatch && looksLikeFile(teeMatch[2]) && !out.find(w => w.file === teeFile)) {
    const kind: 'write' | 'edit' = teeMatch[1] ? 'edit' : 'write';
    const content = heredocMatch ? heredocMatch[2] : null;
    out.push({ file: teeFile, kind, content });
  }

  return out;
}

/**
 * Codex apply_patch payload format (truncated):
 *   *** Begin Patch
 *   *** Update File: path/to/file.ts
 *   @@ context @@
 *    keep
 *   -remove
 *   +add
 *   *** End Patch
 *
 * We can't reconstruct the original file from the patch alone, but we can
 * count added/removed lines exactly — and for `*** Add File:` we know the
 * full new content.
 */
function replayCodexSession(sessionId: string): SessionDiffResult {
  const parentUuid = sessionId.replace(/^codex_/, '');
  const located = findCodexSessionFile(parentUuid);
  if (!located) return { sessionId, found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };

  const accs = new Map<string, FileAccumulator>();
  const projectPath = located.projectPath;

  // Walk the parent rollout first.
  walkCodexRolloutForEdits(located.path, accs);

  // Then fan out to every sub-agent rollout that targets this parent.
  // Codex stores them as siblings in the same YYYY/MM/DD directory; the
  // session_meta payload's source.subagent.thread_spawn.parent_thread_id
  // is the link. The actual file edits happen in the sub-agents — the
  // parent only orchestrates via spawn_agent / wait_agent — so without
  // this fan-out the Diff/Files tabs read empty for orchestrator parents.
  const dayDir = located.path.substring(0, located.path.lastIndexOf('/'));
  let entries: string[] = [];
  try {
    entries = readdirSync(dayDir);
  } catch { /* dir gone */ }

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl') || !entry.startsWith('rollout-')) continue;
    const path = `${dayDir}/${entry}`;
    if (path === located.path) continue;
    let firstLine = '';
    try { firstLine = readFileSync(path, 'utf-8').split('\n', 1)[0] || ''; } catch { continue; }
    if (!firstLine) continue;
    let meta: any;
    try { meta = JSON.parse(firstLine); } catch { continue; }
    const spawn = meta?.payload?.source?.subagent?.thread_spawn;
    if (!spawn || spawn.parent_thread_id !== parentUuid) continue;
    walkCodexRolloutForEdits(path, accs);
  }

  const files: FileReplayResult[] = [];
  let totalAdded = 0, totalRemoved = 0;
  for (const acc of accs.values()) {
    let result = makeFileResult(acc);
    // Fold deferred counts in if we don't already have a real diff.
    const deferAdd = (acc as any)._linesAdded || 0;
    const deferRem = (acc as any)._linesRemoved || 0;
    if (!result.diff && (deferAdd || deferRem)) {
      result = { ...result, linesAdded: deferAdd, linesRemoved: deferRem };
    }
    files.push(result);
    totalAdded += result.linesAdded;
    totalRemoved += result.linesRemoved;
  }

  return { sessionId, found: true, projectPath, files, totalLinesAdded: totalAdded, totalLinesRemoved: totalRemoved };
}

/**
 * Parse a Codex apply_patch payload into per-file sections with
 * exact added/removed line counts. We deliberately don't try to
 * reconstruct full file content — patch bodies don't carry it.
 */
function parseCodexPatch(input: string): Array<{ file: string; kind: 'add' | 'update' | 'delete'; added: string[]; removed: string[] }> {
  const sections: Array<{ file: string; kind: 'add' | 'update' | 'delete'; added: string[]; removed: string[] }> = [];
  let current: { file: string; kind: 'add' | 'update' | 'delete'; added: string[]; removed: string[] } | null = null;

  for (const line of input.split('\n')) {
    const m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (m) {
      if (current) sections.push(current);
      current = {
        file: m[2].trim(),
        kind: m[1].toLowerCase() as 'add' | 'update' | 'delete',
        added: [], removed: [],
      };
      continue;
    }
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch') || line.startsWith('*** End of File') || line.startsWith('@@')) continue;
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) current.added.push(line.slice(1));
    else if (line.startsWith('-') && !line.startsWith('---')) current.removed.push(line.slice(1));
  }
  if (current) sections.push(current);
  return sections;
}

function replayGeminiSession(sessionId: string): SessionDiffResult {
  const id = sessionId.replace(/^gemini_/, '');
  const tmpRoot = join(homedir(), '.gemini', 'tmp');
  if (!existsSync(tmpRoot)) return { sessionId, found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };

  // Locate the file the same way extractGeminiTurns does.
let filePath = '';
  let projectPath = '';
  outer: for (const proj of readdirSync(tmpRoot, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const chats = join(tmpRoot, proj.name, 'chats');
    if (!existsSync(chats)) continue;
    for (const f of readdirSync(chats)) {
      if (!f.startsWith('session-') || !f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(readFileSync(join(chats, f), 'utf-8'));
        const fb = f.replace(/\.json$/, '');
        if (fb === id || j.sessionId === id) {
          filePath = join(chats, f);
          // Best-effort project path resolution from gemini's projects.json.
          const projectsJson = join(homedir(), '.gemini', 'projects.json');
          if (existsSync(projectsJson)) {
            try {
              const pmap = JSON.parse(readFileSync(projectsJson, 'utf-8'));
              for (const p of Object.keys(pmap.projects || {})) {
                if (createHash('sha256').update(p).digest('hex') === proj.name) { projectPath = p; break; }
              }
            } catch { /* skip */ }
          }
          break outer;
        }
      } catch { /* skip */ }
    }
  }
  if (!filePath) return { sessionId, found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };

  let json: any;
  try { json = JSON.parse(readFileSync(filePath, 'utf-8')); }
  catch { return { sessionId, found: false, projectPath, files: [], totalLinesAdded: 0, totalLinesRemoved: 0 }; }

  const accs = new Map<string, FileAccumulator>();

  for (const m of (Array.isArray(json.messages) ? json.messages : [])) {
    const tcs = Array.isArray(m?.toolCalls) ? m.toolCalls : [];
    for (const tc of tcs) {
      const name = String(tc?.name || '');
      const args = tc?.args || {};
      const file = String(args.file_path || args.absolute_path || args.path || '');
      if (!file) continue;
      const acc = accs.get(file) || { file, events: [], before: null, after: null, succeeded: 0, failed: 0 };

      // Only mutating tools (replace, write_file) belong in the diff —
      // read_file/list_directory etc. would otherwise add empty entries.
      if (name === 'replace') {
        const oldS = String(args.old_string ?? args.oldString ?? '');
        const newS = String(args.new_string ?? args.newString ?? '');
        if (acc.before === null) acc.before = oldS;
        acc.after = newS;
        acc.succeeded++;
        acc.events.push({ ts: 0, toolName: 'Edit', toolUseId: '', line: 0, succeeded: true });
        accs.set(file, acc);
      } else if (name === 'write_file') {
        if (acc.before === null) acc.before = '';
        acc.after = String(args.content ?? '');
        acc.succeeded++;
        acc.events.push({ ts: 0, toolName: 'Write', toolUseId: '', line: 0, succeeded: true });
        accs.set(file, acc);
      }
    }
  }

  const files: FileReplayResult[] = [];
  let totalAdded = 0, totalRemoved = 0;
  for (const acc of accs.values()) {
    const result = makeFileResult(acc);
    files.push(result);
    totalAdded += result.linesAdded;
    totalRemoved += result.linesRemoved;
  }
  return { sessionId, found: true, projectPath, files, totalLinesAdded: totalAdded, totalLinesRemoved: totalRemoved };
}

function replayOpenCodeSession(sessionId: string): SessionDiffResult {
  const ocId = sessionId.replace(/^opencode_/, '');
  const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return { sessionId, found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };

  let db: Database.Database;
  try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); }
  catch { return { sessionId, found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 }; }

  try {
    const sess = db.prepare(`
      SELECT s.id, s.directory, p.worktree as project_path
      FROM session s LEFT JOIN project p ON s.project_id = p.id
      WHERE s.id = ?
    `).get(ocId) as { id: string; directory: string | null; project_path: string | null } | undefined;
    if (!sess) return { sessionId, found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };
    const projectPath = sess.project_path || sess.directory || '';

    // OpenCode's `task` tool spawns child sessions (session.parent_id = us).
    // The actual edits happen in those children, so we union their parts
    // with our own — same pattern as Codex sub-agents and Claude subagents.
    const childIds = (db.prepare('SELECT id FROM session WHERE parent_id = ?').all(ocId) as Array<{ id: string }>).map(r => r.id);
    const allIds = [ocId, ...childIds];

    const placeholders = allIds.map(() => '?').join(',');
    const parts = db.prepare(`
      SELECT data FROM part
      WHERE session_id IN (${placeholders}) AND data LIKE '%"type":"tool"%'
      ORDER BY time_created ASC
    `).all(...allIds) as Array<{ data: string }>;

    const accs = new Map<string, FileAccumulator>();

    for (const p of parts) {
      let d: any; try { d = JSON.parse(p.data); } catch { continue; }
      if (d?.type !== 'tool') continue;
      const name = String(d.tool || '');
      const input = d?.state?.input || {};
      const file = String(input.filePath || input.file_path || input.path || '');
      if (!file) continue;
      const acc = accs.get(file) || { file, events: [], before: null, after: null, succeeded: 0, failed: 0 };

      if (name === 'edit') {
        const oldS = String(input.oldString ?? input.old_string ?? '');
        const newS = String(input.newString ?? input.new_string ?? '');
        if (acc.before === null) acc.before = oldS;
        acc.after = newS;
        acc.succeeded++;
        acc.events.push({ ts: 0, toolName: 'Edit', toolUseId: '', line: 0, succeeded: true });
        accs.set(file, acc);
      } else if (name === 'write') {
        if (acc.before === null) acc.before = '';
        acc.after = String(input.content ?? '');
        acc.succeeded++;
        acc.events.push({ ts: 0, toolName: 'Write', toolUseId: '', line: 0, succeeded: true });
        accs.set(file, acc);
      }
      // read/grep/etc. don't enter the map — they don't affect the diff.
    }

    const files: FileReplayResult[] = [];
    let totalAdded = 0, totalRemoved = 0;
    for (const acc of accs.values()) {
      const result = makeFileResult(acc);
      files.push(result);
      totalAdded += result.linesAdded;
      totalRemoved += result.linesRemoved;
    }
    return { sessionId, found: true, projectPath, files, totalLinesAdded: totalAdded, totalLinesRemoved: totalRemoved };
  } finally {
    db.close();
  }
}

// ── Universal commits ──────────────────────────────────────────────

/**
 * Use the per-tool replay's file list + turn time window to feed the
 * existing `getSessionCommits` (git log + matching). The git side is
 * tool-agnostic — it just needs absolute file paths and timestamps.
 */
export function getSessionCommitsAny(sessionId: string): SessionCommitsResult {
  const replay = replaySessionAny(sessionId);
  const turns = extractTurnsAny(sessionId);
  const startMs = turns.startMs || Date.now() - 86400_000;
  const endMs = turns.endMs || Date.now();
  return getSessionCommits(sessionId, replay.files.map(f => f.file), startMs, endMs);
}

// ── Universal outcome ──────────────────────────────────────────────

/**
 * Outcome composed from per-tool turns + diff + commits + sentiment
 * markers. Mirrors the shape `computeOutcome` produces for Claude so
 * the existing OutcomePanel renders unchanged.
 */
export function computeOutcomeAny(sessionId: string): SessionOutcome {
  const tool = detectTool(sessionId);
  if (tool === 'claude') return computeOutcome(sessionId);

  const turnsRes = extractTurnsAny(sessionId, { assistantMax: 2000 });
  if (!turnsRes.found) {
    return {
      sessionId, found: false, status: 'unknown', reason: 'session not found',
      startMs: 0, endMs: 0,
      decisions: [], blockers: [], claimReaction: {},
      prompts: [],
      promptMarkers: { total: 0, interrupt: 0, frustrated: 0, correction: 0, approval: 0, question: 0, directive: 0, clarification_request: 0, peakIntensity: 0 },
      commits: { sessionId, startMs: 0, endMs: 0, repos: [], totalCommits: 0 },
      fileCount: 0, filesChanged: [], totalLinesAdded: 0, totalLinesRemoved: 0,
    };
  }

  // Blockers = tool errors + interrupted prompts.
  const blockers: SessionBlocker[] = [];
  for (const t of turnsRes.turns) {
    if (t.kind === 'tool_result' && t.resultIsError) {
      blockers.push({
        kind: 'tool_error',
        text: t.resultSummary?.slice(0, 240) || 'tool error',
        ts: t.ts, tsIso: t.tsIso, line: t.line,
      });
    }
  }

  const prompts: MarkedPrompt[] = [];
  for (const t of turnsRes.turns) {
    if (t.kind === 'user' && t.text) prompts.push(markPrompt(t.text));
  }
  for (const p of prompts) {
    if (p.markers.includes('interrupt')) {
      blockers.push({ kind: 'interrupt', text: p.text.slice(0, 200), ts: 0, line: 0 });
    }
  }
  const promptMarkers = summarizeMarkers(prompts);

  // Decisions — keep simple: derive from assistant text by heuristic.
  const decisions: SessionDecision[] = [];
  for (const t of turnsRes.turns) {
    if (t.kind !== 'assistant_text' || !t.text) continue;
    const m = t.text.match(/(?:I'll|let me|going to|will)\s+([^.\n]{8,180})/i);
    if (m) decisions.push({ text: m[1].trim(), ts: t.ts, tsIso: t.tsIso, line: t.line });
    if (decisions.length >= 30) break;
  }

  // For OpenCode, prefer the native pre-computed summary_* columns over
  // a full part-replay. The OpenCode SQLite store maintains
  // summary_files / summary_additions / summary_deletions per session
  // already — we'd just be re-deriving the same numbers by walking every
  // tool-part row. We DO still need the file list (for git matching),
  // which we extract via a lighter query on the part table when needed.
  let filesChanged: string[];
  let totalLinesAdded: number;
  let totalLinesRemoved: number;
  if (tool === 'opencode') {
    const native = readOpenCodeSessionSummary(sessionId);
    if (native) {
      filesChanged = native.filesChanged;
      totalLinesAdded = native.totalLinesAdded;
      totalLinesRemoved = native.totalLinesRemoved;
    } else {
      const replay = replaySessionAny(sessionId);
      filesChanged = replay.files.map(f => f.file);
      totalLinesAdded = replay.totalLinesAdded;
      totalLinesRemoved = replay.totalLinesRemoved;
    }
  } else {
    const replay = replaySessionAny(sessionId);
    filesChanged = replay.files.map(f => f.file);
    totalLinesAdded = replay.totalLinesAdded;
    totalLinesRemoved = replay.totalLinesRemoved;
  }

  const commits = getSessionCommits(
    sessionId, filesChanged, turnsRes.startMs, turnsRes.endMs,
  );

  let status: SessionOutcome['status'] = 'unknown';
  let reason = '';
  if (commits.totalCommits > 0) { status = 'shipped'; reason = `${commits.totalCommits} commit(s) landed in window`; }
  else if (blockers.some(b => b.kind === 'interrupt')) { status = 'interrupted'; reason = 'user interrupted'; }
  else if (blockers.length > 5) { status = 'in_progress'; reason = `${blockers.length} tool errors`; }
  else if (filesChanged.length > 0) { status = 'in_progress'; reason = `${filesChanged.length} file(s) edited, no commits`; }
  else { status = 'unknown'; reason = 'no file edits or commits'; }

  return {
    sessionId, found: true, status, reason,
    startMs: turnsRes.startMs, endMs: turnsRes.endMs,
    decisions: decisions.slice(0, 30), blockers: blockers.slice(0, 30),
    claimReaction: {},
    prompts, promptMarkers, commits,
    fileCount: filesChanged.length, filesChanged,
    totalLinesAdded,
    totalLinesRemoved,
  };
}

/**
 * Read OpenCode's native pre-computed session summary
 * (summary_files / summary_additions / summary_deletions) plus the
 * distinct file paths touched, without replaying every part row.
 *
 * Why: OpenCode already counts file/line changes during normal
 * operation and persists them on the session row. We were re-deriving
 * the same numbers by parsing every JSON `part` row — wasteful when the
 * source has them ready. We still query the part table for the file
 * paths (needed for `getSessionCommits` git matching), but that's a
 * single SELECT DISTINCT instead of a full N-row JSON parse loop.
 *
 * Returns null when the row is absent (sessionId not in the OpenCode DB)
 * or when the OpenCode store itself is missing.
 */
function readOpenCodeSessionSummary(sessionId: string): {
  filesChanged: string[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
} | null {
  const ocId = sessionId.replace(/^opencode_/, '');
  const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return null;

  let db: Database.Database;
  try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); }
  catch { return null; }

  try {
    // Sum the summary across the parent + any child sessions (task tool
    // spawns sub-sessions whose edits belong to the parent's outcome).
    const childIds = (db.prepare('SELECT id FROM session WHERE parent_id = ?').all(ocId) as Array<{ id: string }>).map(r => r.id);
    const allIds = [ocId, ...childIds];
    const placeholders = allIds.map(() => '?').join(',');

    const sums = db.prepare(`
      SELECT
        COALESCE(SUM(summary_additions), 0) as add_sum,
        COALESCE(SUM(summary_deletions), 0) as del_sum
      FROM session
      WHERE id IN (${placeholders})
    `).get(...allIds) as { add_sum: number; del_sum: number };

    // Distinct file paths from the part rows. Cheaper than the full JSON
    // walk — we only need the path strings, not the diff bodies.
    const partRows = db.prepare(`
      SELECT DISTINCT data FROM part
      WHERE session_id IN (${placeholders}) AND data LIKE '%"type":"tool"%'
    `).all(...allIds) as Array<{ data: string }>;

    const files = new Set<string>();
    for (const p of partRows) {
      try {
        const d = JSON.parse(p.data);
        if (d?.type !== 'tool') continue;
        const name = String(d.tool || '').toLowerCase();
        if (name !== 'edit' && name !== 'write') continue;
        const input = d?.state?.input || {};
        const file = String(input.filePath || input.file_path || input.path || '');
        if (file) files.add(file);
      } catch { /* skip malformed */ }
    }

    return {
      filesChanged: Array.from(files),
      totalLinesAdded: sums.add_sum || 0,
      totalLinesRemoved: sums.del_sum || 0,
    };
  } finally {
    db.close();
  }
}
