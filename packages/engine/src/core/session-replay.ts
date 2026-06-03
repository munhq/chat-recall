/**
 * Session-replay shapes + the `findRepoRoot` helper.
 *
 * Per-file diff reconstruction now lives in `generic-engine.ts`
 * (`replayFromEvents`), driven by each backend's `readEvents()` +
 * `extractEditDelta()`. Codex `apply_patch` (multi-file unified diffs in
 * a single tool input) keeps a dedicated replay in `session-multi-tool.ts`.
 */

import { existsSync } from 'fs';
import { dirname, resolve as pathResolve } from 'path';

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
