/**
 * Session replay — reconstruct per-file diffs from a session's tool calls.
 *
 * Walks the JSONL transcript and replays Edit / Write / MultiEdit / NotebookEdit
 * tool_use payloads against an initial content (recovered from prior Read tool
 * results when available) to produce a unified diff per file. This is the
 * "what did this session actually change?" view that the bare edit timeline
 * couldn't answer — the timeline only said edits happened, not what they were.
 *
 * Reverts are detected by comparing reconstructed final content against the
 * known initial content. A file edited then deleted, or whose final state
 * matches its initial state, is reported with `reverted: true`.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, resolve as pathResolve } from 'path';
import { createPatch } from 'diff';
import { findSessionFile, resolveSessionContentPaths, detectTool } from './live-session-scan.js';

export type EditToolName = 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit';

export interface FileEditEvent {
  ts: number;
  tsIso?: string;
  toolName: EditToolName;
  toolUseId: string;
  line: number;
  succeeded: boolean;     // did the apply land cleanly (matched the file or was a Write)?
  toolError?: string;     // tool_result.content if is_error was set
  applyError?: string;    // our replay couldn't find old_string, etc.
  // Inputs (one of):
  edits?: Array<{ oldString: string; newString: string; replaceAll: boolean }>;
  content?: string;
  notebookCell?: { cellId?: string; cellType?: string; newSource?: string; editMode?: string };
}

export interface FileReplayResult {
  file: string;
  events: FileEditEvent[];
  initialContent: string | null;     // recovered from earliest Read or null
  initialKnown: boolean;             // whether initialContent is a real recovery or null
  finalContent: string | null;
  diff: string;                      // unified diff initial→final, '' when content identical or unknown
  linesAdded: number;
  linesRemoved: number;
  reverted: boolean;                 // final == initial after non-zero edits
  succeededEvents: number;
  failedEvents: number;
}

export interface SessionDiffResult {
  sessionId: string;
  found: boolean;
  projectPath: string;
  files: FileReplayResult[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
}

interface ToolUseRecord {
  toolName: string;
  input: Record<string, unknown>;
  line: number;
  ts: number;
  tsIso?: string;
}

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * `cat -n` style: "    7\tthe content". Read tool results emit this prefix on
 * every line so the model sees line numbers. To recover the original file we
 * have to strip the prefix; if the prefix shape isn't present we treat the
 * line as already raw (which happens for the optional system-reminder tail
 * that lives below the file dump).
 */
function stripCatNPrefix(line: string): string {
  const m = line.match(/^\s*\d+\t(.*)$/);
  return m ? m[1] : line;
}

/**
 * Read tool results are formatted as either:
 *   "     1\tline one\n     2\tline two\n..."
 * or are wrapped with a system reminder header. Recover the underlying content.
 */
function recoverFileFromReadResult(raw: string): string | null {
  if (!raw) return null;
  // Strip <system-reminder>...</system-reminder> blocks
  let body = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  // Drop the heading line "Truncated; total ..." if present
  body = body.replace(/^File contents truncated[^\n]*\n/i, '');
  const lines = body.split('\n');
  // Heuristic: at least half the non-empty lines should match the cat -n prefix
  let prefixed = 0;
  let nonEmpty = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    nonEmpty++;
    if (/^\s*\d+\t/.test(l)) prefixed++;
  }
  if (nonEmpty === 0) return '';
  if (prefixed / nonEmpty < 0.4) {
    // Not a cat -n style result — likely image, binary, or already raw.
    return null;
  }
  return lines.map(stripCatNPrefix).join('\n');
}

function applyEdit(current: string, oldString: string, newString: string, replaceAll: boolean): { ok: boolean; result: string; reason?: string } {
  if (oldString === '' && newString !== '' && current === '') {
    // Edit-with-empty-old creates the file (rare path Claude takes).
    return { ok: true, result: newString };
  }
  if (oldString === current && replaceAll) {
    return { ok: true, result: newString };
  }
  const idx = current.indexOf(oldString);
  if (idx === -1) {
    return { ok: false, result: current, reason: `old_string not found (${oldString.length} chars)` };
  }
  if (replaceAll) {
    return { ok: true, result: current.split(oldString).join(newString) };
  }
  return { ok: true, result: current.slice(0, idx) + newString + current.slice(idx + oldString.length) };
}

function safeJSONParse(line: string): Record<string, unknown> | null {
  try { return JSON.parse(line) as Record<string, unknown>; }
  catch { return null; }
}

/**
 * Build a flat, time-ordered timeline of relevant entries: tool_use with file
 * payloads and tool_result keyed by tool_use_id. We need both passes so the
 * replayer can attach is_error / error message to each event without a second
 * walk per file.
 */
function buildTimeline(paths: string[]): {
  uses: Array<{ id: string; toolName: string; input: Record<string, unknown>; line: number; ts: number; tsIso?: string }>;
  results: Map<string, { content: string; isError: boolean; ts: number; line: number }>;
  fileMtime: number;
} {
  const uses: Array<{ id: string; toolName: string; input: Record<string, unknown>; line: number; ts: number; tsIso?: string }> = [];
  const results = new Map<string, { content: string; isError: boolean; ts: number; line: number }>();
  let fileMtime = 0;

  let lineNum = 0;
  for (const path of paths) {
    try { fileMtime = Math.max(fileMtime, statSync(path).mtimeMs); } catch { /* */ }
    let raw = '';
    try { raw = readFileSync(path, 'utf-8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      lineNum++;
      if (!line.trim()) continue;
      const obj = safeJSONParse(line);
      if (!obj) continue;
      const tsIso = typeof obj.timestamp === 'string' ? obj.timestamp as string : undefined;
      const ts = tsIso ? Date.parse(tsIso) || fileMtime : fileMtime;

      if (obj.type === 'assistant') {
        const msg = obj.message as Record<string, unknown> | undefined;
        const content = msg?.content;
        if (!Array.isArray(content)) continue;
        for (const item of content) {
          if (!item || typeof item !== 'object') continue;
          const it = item as Record<string, unknown>;
          if (it.type !== 'tool_use') continue;
          const id = it.id as string;
          const toolName = it.name as string;
          const input = (it.input as Record<string, unknown>) || {};
          if (!id || !toolName) continue;
          uses.push({ id, toolName, input, line: lineNum, ts, tsIso });
        }
      } else if (obj.type === 'user') {
        const msg = obj.message as Record<string, unknown> | undefined;
        const content = msg?.content;
        if (!Array.isArray(content)) continue;
        for (const item of content) {
          if (!item || typeof item !== 'object') continue;
          const it = item as Record<string, unknown>;
          if (it.type !== 'tool_result') continue;
          const id = it.tool_use_id as string;
          if (!id) continue;
          let body = '';
          const c = it.content;
          if (typeof c === 'string') body = c;
          else if (Array.isArray(c)) {
            const parts: string[] = [];
            for (const sub of c) {
              if (sub && typeof sub === 'object' && (sub as Record<string, unknown>).type === 'text') {
                const t = (sub as Record<string, unknown>).text;
                if (typeof t === 'string') parts.push(t);
              }
            }
            body = parts.join('\n');
          }
          const isError = it.is_error === true;
          results.set(id, { content: body, isError, ts, line: lineNum });
        }
      }
    }
  }
  return { uses, results, fileMtime };
}

function pathFromInput(toolName: string, input: Record<string, unknown>): string | null {
  const cands = [input.file_path, input.path, input.notebook_path, input.target_file];
  for (const c of cands) if (typeof c === 'string' && c.trim()) return c.trim();
  void toolName;
  return null;
}

function diffStats(patch: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

export function replaySession(sessionId: string): SessionDiffResult {
  const tool = detectTool(sessionId);
  // Replay is only meaningful for Claude transcripts today — Gemini/OpenCode/Codex
  // tool semantics differ and would need parallel implementations.
  if (tool !== 'claude') {
    return { sessionId, found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };
  }

  const located = findSessionFile(sessionId);
  if (!located) {
    return { sessionId, found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };
  }

  const paths = resolveSessionContentPaths(located.path);
  const { uses, results } = buildTimeline(paths);

  type FileState = {
    file: string;
    initial: string | null;
    initialKnown: boolean;
    current: string | null;
    events: FileEditEvent[];
    succeeded: number;
    failed: number;
    everEdited: boolean;
  };
  const states = new Map<string, FileState>();

  // First pass — capture initial content from earliest Read tool_result per file.
  // Walk uses in order; the first Read for a file before any Edit gives us a
  // ground-truth starting point we can reconstruct edits against.
  for (const use of uses) {
    if (use.toolName !== 'Read') continue;
    const file = pathFromInput(use.toolName, use.input);
    if (!file) continue;
    if (states.has(file)) continue;
    const r = results.get(use.id);
    if (!r || r.isError) continue;
    const recovered = recoverFileFromReadResult(r.content);
    if (recovered === null) continue;
    states.set(file, {
      file,
      initial: recovered,
      initialKnown: true,
      current: recovered,
      events: [],
      succeeded: 0,
      failed: 0,
      everEdited: false,
    });
  }

  // Second pass — replay edit events.
  for (const use of uses) {
    if (!EDIT_TOOLS.has(use.toolName)) continue;
    const file = pathFromInput(use.toolName, use.input);
    if (!file) continue;

    let state = states.get(file);
    if (!state) {
      // No prior Read — initial content is unknown unless the very first event
      // is a Write, in which case we know the final content but not what was
      // there before.
      state = { file, initial: null, initialKnown: false, current: null, events: [], succeeded: 0, failed: 0, everEdited: false };
      states.set(file, state);
    }

    const r = results.get(use.id);
    const isToolError = !!(r && r.isError);
    const event: FileEditEvent = {
      ts: use.ts,
      tsIso: use.tsIso,
      toolName: use.toolName as EditToolName,
      toolUseId: use.id,
      line: use.line,
      succeeded: false,
      toolError: isToolError ? (r?.content || 'tool reported error') : undefined,
    };

    if (use.toolName === 'Write') {
      const content = typeof use.input.content === 'string' ? (use.input.content as string) : '';
      event.content = content;
      if (!isToolError) {
        // If we never observed initial content but Write replaces everything,
        // initial stays unknown — only `current` and the diff against an empty
        // baseline are meaningful.
        state.current = content;
        state.succeeded++;
        event.succeeded = true;
        state.everEdited = true;
      } else {
        state.failed++;
      }
    } else if (use.toolName === 'Edit') {
      const oldString = typeof use.input.old_string === 'string' ? (use.input.old_string as string) : '';
      const newString = typeof use.input.new_string === 'string' ? (use.input.new_string as string) : '';
      const replaceAll = use.input.replace_all === true;
      event.edits = [{ oldString, newString, replaceAll }];

      if (state.current === null && !state.initialKnown) {
        // We never saw the file before this Edit; assume the old_string IS the
        // initial value (a common pattern when Claude edits a file it hasn't
        // explicitly Read because the user pasted/showed it). This lets the
        // diff be meaningful instead of empty.
        state.initial = oldString;
        state.initialKnown = true;
        state.current = oldString;
      }
      if (state.current !== null) {
        const out = applyEdit(state.current, oldString, newString, replaceAll);
        if (out.ok && !isToolError) {
          state.current = out.result;
          state.succeeded++;
          event.succeeded = true;
          state.everEdited = true;
        } else {
          if (!out.ok) event.applyError = out.reason;
          state.failed++;
        }
      } else {
        state.failed++;
        event.applyError = 'no current content to apply edit against';
      }
    } else if (use.toolName === 'MultiEdit') {
      const editsRaw = use.input.edits;
      const edits: Array<{ oldString: string; newString: string; replaceAll: boolean }> = [];
      if (Array.isArray(editsRaw)) {
        for (const e of editsRaw) {
          if (!e || typeof e !== 'object') continue;
          const ee = e as Record<string, unknown>;
          edits.push({
            oldString: typeof ee.old_string === 'string' ? ee.old_string as string : '',
            newString: typeof ee.new_string === 'string' ? ee.new_string as string : '',
            replaceAll: ee.replace_all === true,
          });
        }
      }
      event.edits = edits;
      if (state.current === null && !state.initialKnown && edits.length > 0) {
        state.initial = edits[0].oldString;
        state.initialKnown = true;
        state.current = edits[0].oldString;
      }
      if (state.current !== null) {
        let cur = state.current;
        let allOk = !isToolError;
        for (const e of edits) {
          const out = applyEdit(cur, e.oldString, e.newString, e.replaceAll);
          if (!out.ok) {
            allOk = false;
            event.applyError = out.reason;
            break;
          }
          cur = out.result;
        }
        if (allOk) {
          state.current = cur;
          state.succeeded++;
          event.succeeded = true;
          state.everEdited = true;
        } else {
          state.failed++;
        }
      } else {
        state.failed++;
        event.applyError = 'no current content to apply MultiEdit against';
      }
    } else if (use.toolName === 'NotebookEdit') {
      // Notebook edits operate on cells, not on raw file text. We record the
      // event payload but don't replay against `current` (cells are JSON inside
      // .ipynb; reconstruction would require a real notebook walker).
      event.notebookCell = {
        cellId: typeof use.input.cell_id === 'string' ? use.input.cell_id as string : undefined,
        cellType: typeof use.input.cell_type === 'string' ? use.input.cell_type as string : undefined,
        newSource: typeof use.input.new_source === 'string' ? use.input.new_source as string : undefined,
        editMode: typeof use.input.edit_mode === 'string' ? use.input.edit_mode as string : undefined,
      };
      if (!isToolError) {
        state.succeeded++;
        event.succeeded = true;
        state.everEdited = true;
      } else {
        state.failed++;
      }
    }

    state.events.push(event);
  }

  // Build per-file results.
  const out: FileReplayResult[] = [];
  let totalAdded = 0, totalRemoved = 0;

  for (const state of states.values()) {
    if (state.events.length === 0) continue;
    const initial = state.initial ?? '';
    const finalText = state.current ?? '';
    let patch = '';
    let added = 0, removed = 0;
    let reverted = false;

    if (state.initialKnown && state.current !== null) {
      if (initial === finalText && state.everEdited) {
        reverted = true;
      } else if (initial !== finalText) {
        patch = createPatch(state.file, initial, finalText, '', '', { context: 3 });
        const stats = diffStats(patch);
        added = stats.added; removed = stats.removed;
      }
    } else if (state.current !== null) {
      // Initial unknown but we have a final — show the final as additions only,
      // diffed against an empty baseline. Useful when Write is the first op.
      patch = createPatch(state.file, '', finalText, '(unknown)', '', { context: 3 });
      const stats = diffStats(patch);
      added = stats.added; removed = stats.removed;
    }

    totalAdded += added; totalRemoved += removed;
    out.push({
      file: state.file,
      events: state.events,
      initialContent: state.initial,
      initialKnown: state.initialKnown,
      finalContent: state.current,
      diff: patch,
      linesAdded: added,
      linesRemoved: removed,
      reverted,
      succeededEvents: state.succeeded,
      failedEvents: state.failed,
    });
  }

  // Sort files by lines-changed desc so the loudest signal is first.
  out.sort((a, b) => (b.linesAdded + b.linesRemoved) - (a.linesAdded + a.linesRemoved));

  return {
    sessionId,
    found: true,
    projectPath: located.projectPath,
    files: out,
    totalLinesAdded: totalAdded,
    totalLinesRemoved: totalRemoved,
  };
}

/**
 * Walk up from a path to find the closest .git directory. Used by callers
 * (commits, repo-grouping) so they don't each reimplement repo detection.
 */
export function findRepoRoot(filePath: string): string | null {
  if (!filePath) return null;
  let dir = pathResolve(dirname(filePath));
  // Don't loop forever — stop at filesystem root.
  for (let i = 0; i < 64; i++) {
    if (existsSync(`${dir}/.git`)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
