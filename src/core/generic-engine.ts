/**
 * Tool-agnostic engine.
 *
 * Each AI tool's storage format differs (Claude jsonl, Gemini json/jsonl,
 * OpenCode SQLite parts, Codex jsonl rollouts), but the downstream
 * operations — turn extraction, edit scanning, file replay — only need
 * the canonical event shape every backend's `readEvents()` produces.
 * This module owns those operations once for all four backends.
 *
 * Adding a fifth AI tool means writing one new ToolBackend with its
 * `readEvents` adapter and `fileToolMap` — no edits here.
 */

import { basename } from 'path';
import { createPatch } from 'diff';

import type {
  AiTool,
  CanonicalEvent,
  EditDelta,
  LiveScanEditsResult,
} from './tool-backend.js';
import { isMultiFileDelta } from './tool-backend.js';
import type { EditOp, SessionEdit } from './live-session-scan.js';
import type { ExtractedTurns, SessionTurn } from './session-turns.js';
import type {
  FileEditEvent,
  FileReplayResult,
  SessionDiffResult,
} from './session-replay.js';

// ── Tunables (mirror the per-tool defaults that lived in session-multi-tool) ─
const SHORT_TEXT = 600;
const DEFAULT_USER_MAX = 1200;
const DEFAULT_ASSISTANT_MAX = 1500;
const DEFAULT_TOOL_RESULT_MAX = 800;
const DEFAULT_MAX_TURNS = 5000;

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

// ── extractTurns ───────────────────────────────────────────────────────

/**
 * Convert canonical events into the SessionTurn shape the UI consumes.
 * Applies size limits and assistant-text truncation. Pure function over
 * events — backends call this with the result of `readEvents()`.
 */
export function extractTurnsFromEvents(
  sessionId: string,
  events: CanonicalEvent[],
  opts: { maxTurns?: number; assistantMax?: number } = {},
): ExtractedTurns {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const assistantMax = opts.assistantMax ?? DEFAULT_ASSISTANT_MAX;

  const turns: SessionTurn[] = [];
  let startMs = 0, endMs = 0;
  let found = false;

  for (const e of events) {
    found = true;
    if (e.ts) {
      if (!startMs || e.ts < startMs) startMs = e.ts;
      if (e.ts > endMs) endMs = e.ts;
    }

    if (e.kind === 'user' && e.text) {
      turns.push({
        kind: 'user', ts: e.ts, tsIso: e.tsIso, line: e.line,
        text: shorten(e.text, DEFAULT_USER_MAX),
      });
    } else if (e.kind === 'assistant_text' && e.text) {
      turns.push({
        kind: 'assistant_text', ts: e.ts, tsIso: e.tsIso, line: e.line,
        text: shorten(e.text, assistantMax),
      });
    } else if (e.kind === 'tool_use') {
      turns.push({
        kind: 'tool_use', ts: e.ts, tsIso: e.tsIso, line: e.line,
        toolName: e.toolName,
        toolUseId: e.toolUseId,
        toolInputSummary: summarizeToolInput(e.toolName, e.toolInput),
        command: e.command,
      });
    } else if (e.kind === 'tool_result') {
      turns.push({
        kind: 'tool_result', ts: e.ts, tsIso: e.tsIso, line: e.line,
        toolUseId: e.toolUseId,
        toolName: e.toolName,
        resultSummary: e.resultBody ? shorten(e.resultBody, DEFAULT_TOOL_RESULT_MAX) : undefined,
        resultIsError: e.resultIsError,
        resultExitCode: e.resultExitCode,
        resultBytes: e.resultBytes,
      });
    }

    if (turns.length >= maxTurns) break;
  }

  return { sessionId, found, turns, startMs, endMs };
}

function summarizeToolInput(toolName: string | undefined, input: unknown): string {
  if (!toolName) return '';
  if (input == null || typeof input !== 'object') return toolName;
  const inp = input as Record<string, unknown>;
  // Surface a file path when the tool carries one — it's the most
  // useful single field for skimming a turn list.
  const file = inp.file_path || inp.absolute_path || inp.path || inp.filePath;
  if (typeof file === 'string' && file) return `${toolName}(${basename(file)})`;
  const keys = Object.keys(inp).slice(0, 3);
  return keys.length ? `${toolName}(${keys.join(', ')})` : toolName;
}

// ── liveScanEdits ──────────────────────────────────────────────────────

/**
 * Extract every file-touching tool_use into the SessionEdit shape the
 * indexer + activity timeline use. Backends pass their `fileToolMap`
 * (tool-name → EditOp) so we know which tools mutate files.
 */
export function liveScanEditsFromEvents(
  events: CanonicalEvent[],
  fileToolMap: Record<string, EditOp>,
  ctx: {
    sessionId: string;
    tool: AiTool;
    projectPath: string;
    projectDir: string;
    fileMtime: number;
    found: boolean;
  },
  extractEditDelta?: (toolName: string, input: unknown) => EditDelta | null,
): LiveScanEditsResult {
  const edits: SessionEdit[] = [];

  for (const e of events) {
    if (e.kind !== 'tool_use' || !e.toolName) continue;
    const op = fileToolMap[e.toolName];
    if (!op) continue;

    // Multi-file path: the tool_use carries a single patch covering many
    // files (Codex apply_patch). The file list comes from the delta, not
    // from inspecting toolInput for a path field.
    const delta = extractEditDelta?.(e.toolName, e.toolInput) ?? null;
    if (isMultiFileDelta(delta)) {
      for (const pf of delta.perFile) {
        if (!pf.file) continue;
        edits.push({
          ts: e.ts || ctx.fileMtime,
          tsIso: e.tsIso,
          sessionId: ctx.sessionId,
          projectPath: ctx.projectPath,
          file: pf.file,
          op,
          toolName: e.toolName,
          tool: ctx.tool,
          line: e.line,
        });
      }
      continue;
    }

    // Single-file path — the file path comes from the tool input itself.
    for (const filePath of extractFilePaths(e.toolInput)) {
      edits.push({
        ts: e.ts || ctx.fileMtime,
        tsIso: e.tsIso,
        sessionId: ctx.sessionId,
        projectPath: ctx.projectPath,
        file: filePath,
        op,
        toolName: e.toolName,
        tool: ctx.tool,
        line: e.line,
      });
    }
  }

  return {
    found: ctx.found,
    projectPath: ctx.projectPath,
    projectDir: ctx.projectDir,
    edits,
    fileMtime: ctx.fileMtime,
    tool: ctx.tool,
  };
}

/**
 * Pull every file path out of a tool input. Handles single-path tools
 * (file_path/absolute_path/path/filePath) and multi-path tools
 * (paths: string[], used by Gemini's read_many_files).
 */
function extractFilePaths(input: unknown): string[] {
  if (input == null || typeof input !== 'object') return [];
  const inp = input as Record<string, unknown>;
  const single = inp.file_path || inp.absolute_path || inp.path || inp.filePath;
  if (Array.isArray(inp.paths)) {
    return inp.paths.filter((p): p is string => typeof p === 'string' && !!p.trim());
  }
  if (typeof single === 'string' && single.trim()) return [single];
  return [];
}

// ── replay ────────────────────────────────────────────────────────────

/**
 * Reconstruct file edits from the event stream. For tools whose mutating
 * tool_use carries the diff inline (Claude Edit/Write, Gemini
 * replace/write_file), `extractEditDelta` returns the before/after pair
 * and we accumulate them per file. Tools without an inline-diff delta
 * (Codex apply_patch — diff lives in a separate payload) just count
 * events; their dedicated replay still lives in their backend.
 */
export function replayFromEvents(
  sessionId: string,
  events: CanonicalEvent[],
  fileToolMap: Record<string, EditOp>,
  extractEditDelta: ((toolName: string, input: unknown) => EditDelta | null) | undefined,
  ctx: { projectPath: string; found: boolean },
): SessionDiffResult {
  const accs = new Map<string, FileAccumulator>();

  const succeededOf = (e: CanonicalEvent) => e.resultIsError !== true;

  /** Push a single before/after entry to the accumulator for `filePath`. */
  const accumulate = (
    filePath: string,
    before: string | null,
    after: string | null,
    op: EditOp,
    e: CanonicalEvent,
  ) => {
    const acc = accs.get(filePath) || makeAcc(filePath);
    const succeeded = succeededOf(e);
    const evt: FileEditEvent = {
      ts: e.ts,
      tsIso: e.tsIso,
      toolName: editToolNameFor(op),
      toolUseId: e.toolUseId || '',
      line: e.line,
      succeeded,
      ...(e.resultIsError ? { toolError: e.resultBody?.slice(0, 200) } : {}),
    };
    acc.events.push(evt);
    if (succeeded) acc.succeeded++;
    else acc.failed++;
    if (acc.before === null && before !== null) acc.before = before;
    if (after !== null) acc.after = after;
    // Write-style ops replace content wholesale. The delta represents
    // what landed; before is unknown for the repo state but treated as
    // empty for the purposes of line-counting if not provided.
    if (op === 'write' && acc.before === null) acc.before = '';
    accs.set(filePath, acc);
  };

  for (const e of events) {
    if (e.kind !== 'tool_use' || !e.toolName) continue;
    const op = fileToolMap[e.toolName];
    if (!op) continue;
    // Reads aren't mutations.
    if (op === 'read') continue;

    const delta = extractEditDelta?.(e.toolName, e.toolInput) ?? null;

    // Multi-file: one tool_use, many file deltas (Codex apply_patch).
    if (isMultiFileDelta(delta)) {
      for (const pf of delta.perFile) {
        if (!pf.file) continue;
        accumulate(pf.file, pf.before, pf.after, op, e);
      }
      continue;
    }

    // Single-file: paths come from the tool input.
    const filePaths = extractFilePaths(e.toolInput);
    const single = delta; // narrowed: SingleFileEditDelta | null
    for (const filePath of filePaths) {
      accumulate(filePath, single?.before ?? null, single?.after ?? null, op, e);
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

  return {
    sessionId,
    found: ctx.found,
    projectPath: ctx.projectPath,
    files,
    totalLinesAdded: totalAdded,
    totalLinesRemoved: totalRemoved,
  };
}

/**
 * Internal accumulator for a single file across the event stream.
 */
interface FileAccumulator {
  file: string;
  events: FileEditEvent[];
  before: string | null;
  after: string | null;
  succeeded: number;
  failed: number;
}

function makeAcc(file: string): FileAccumulator {
  return { file, events: [], before: null, after: null, succeeded: 0, failed: 0 };
}

function editToolNameFor(op: EditOp): import('./session-replay.js').EditToolName {
  // The replay/UI layer wants Claude-style names. Map normalized op back.
  switch (op) {
    case 'edit':           return 'Edit';
    case 'multi_edit':     return 'MultiEdit';
    case 'notebook_edit':  return 'NotebookEdit';
    case 'write':          return 'Write';
    case 'read':           return 'Edit'; // never emitted (filtered above)
  }
}

function makeFileResult(acc: FileAccumulator): FileReplayResult {
  let diff = '';
  let linesAdded = 0;
  let linesRemoved = 0;
  let initialKnown = acc.before !== null;
  let reverted = false;

  if (acc.before !== null && acc.after !== null) {
    if (acc.before === acc.after) {
      reverted = true;
    } else {
      diff = createPatch(acc.file, acc.before, acc.after);
      // Count added/removed from the patch body.
      for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
        else if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
      }
    }
  }

  return {
    file: acc.file,
    initialContent: acc.before,
    initialKnown,
    finalContent: acc.after,
    diff,
    linesAdded,
    linesRemoved,
    events: acc.events,
    succeededEvents: acc.succeeded,
    failedEvents: acc.failed,
    reverted,
  };
}
