/**
 * Live-scan helpers for active or unindexed Claude Code sessions.
 *
 * The indexer only updates extra_json (filesModified, toolsUsed, etc.) when a
 * session is re-indexed. For the *active* session — the one currently running
 * — those fields lag behind reality. These helpers walk the transcript on
 * disk and pull file activity straight from `tool_use` blocks so callers can
 * answer "what did this session just touch?" without waiting for a re-index.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';
import { hasSubagentsDir } from '../parsers/session.js';

export type EditOp = 'edit' | 'write' | 'multi_edit' | 'notebook_edit' | 'read';

export interface SessionEdit {
  ts: number;          // epoch ms — falls back to file mtime when entry has no timestamp
  tsIso?: string;      // original ISO timestamp from the entry, if present
  sessionId: string;
  projectPath: string;
  file: string;
  op: EditOp;
  toolName: string;    // raw tool name (Edit, Write, MultiEdit, NotebookEdit, Read)
  line: number;        // line number in the transcript
}

const FILE_TOOLS: Record<string, EditOp> = {
  Edit: 'edit',
  Write: 'write',
  MultiEdit: 'multi_edit',
  NotebookEdit: 'notebook_edit',
  Read: 'read',
};

/**
 * Locate the .jsonl file for a session id by scanning ~/.claude/projects/.
 * Returns null when the session can't be found on disk.
 */
export function findSessionFile(sessionId: string): {
  path: string;
  projectDir: string;
  projectPath: string;
} | null {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return null;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      return {
        path: candidate,
        projectDir: entry.name,
        // Project path is encoded by replacing slashes with dashes.
        projectPath: entry.name.replace(/-/g, '/').replace(/^\//, '/'),
      };
    }
  }
  return null;
}

/**
 * Resolve the actual content paths for a session — handles both the legacy
 * single-file format and the new subagents/ split format.
 */
export function resolveSessionContentPaths(sessionFile: string): string[] {
  if (!hasSubagentsDir(sessionFile)) return [sessionFile];
  const subDir = join(sessionFile.slice(0, -6), 'subagents');
  if (!existsSync(subDir)) return [sessionFile];
  const subPaths = readdirSync(subDir)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .map(f => join(subDir, f));
  return subPaths.length > 0 ? subPaths : [sessionFile];
}

function extractFilePathFromInput(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const inp = input as Record<string, unknown>;
  // Common field names across Claude file tools
  const candidates = [
    inp.file_path,
    inp.path,
    inp.notebook_path,
    inp.target_file,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  void toolName;
  return null;
}

/**
 * Walk a session's transcript(s) and yield every file-touching tool_use.
 *
 * This is the same logic the indexer would record once a session is closed —
 * but run on demand so it works for the live session.
 */
export function liveScanSessionEdits(sessionId: string): {
  found: boolean;
  projectPath: string;
  projectDir: string;
  edits: SessionEdit[];
  fileMtime: number;
} {
  const located = findSessionFile(sessionId);
  if (!located) {
    return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0 };
  }

  const paths = resolveSessionContentPaths(located.path);
  let fileMtime = 0;
  try { fileMtime = statSync(located.path).mtimeMs; } catch { /* ignore */ }

  const edits: SessionEdit[] = [];

  for (const filePath of paths) {
    let raw: string;
    try { raw = readFileSync(filePath, 'utf-8'); } catch { continue; }

    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line); } catch { continue; }

      if (obj.type !== 'assistant') continue;
      const msg = obj.message as Record<string, unknown> | undefined;
      if (!msg || typeof msg !== 'object') continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      const tsIso = typeof obj.timestamp === 'string' ? (obj.timestamp as string) : undefined;
      const ts = tsIso ? Date.parse(tsIso) || fileMtime : fileMtime;

      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const it = item as Record<string, unknown>;
        if (it.type !== 'tool_use') continue;
        const toolName = it.name as string;
        if (!toolName || !(toolName in FILE_TOOLS)) continue;
        const file = extractFilePathFromInput(toolName, it.input);
        if (!file) continue;

        edits.push({
          ts,
          tsIso,
          sessionId,
          projectPath: located.projectPath,
          file,
          op: FILE_TOOLS[toolName],
          toolName,
          line: i + 1,
        });
      }
    }
  }

  return {
    found: true,
    projectPath: located.projectPath,
    projectDir: located.projectDir,
    edits,
    fileMtime,
  };
}

/**
 * Convenience wrapper — returns just the deduped list of files modified
 * (write/edit/multi_edit/notebook_edit). Mirrors the shape the indexer's
 * `extra_json.filesModified` would produce.
 */
export function liveScanModifiedFiles(sessionId: string): {
  found: boolean;
  files: string[];
  reads: string[];
  edits: SessionEdit[];
  projectPath: string;
} {
  const scan = liveScanSessionEdits(sessionId);
  const writeOps = new Set<EditOp>(['edit', 'write', 'multi_edit', 'notebook_edit']);
  const files = new Set<string>();
  const reads = new Set<string>();
  for (const e of scan.edits) {
    if (writeOps.has(e.op)) files.add(e.file);
    else if (e.op === 'read') reads.add(e.file);
  }
  return {
    found: scan.found,
    files: [...files],
    reads: [...reads],
    edits: scan.edits,
    projectPath: scan.projectPath,
  };
}

/**
 * Live-scan every session whose transcript was modified since `sinceMs`.
 *
 * Used by recall_edits_timeline. Heavy when called with a wide window — we
 * scan jsonl files top-to-bottom — but for the typical "last 24h" window it's
 * a handful of files.
 */
export function liveScanRecentEdits(opts: {
  sinceMs: number;
  pattern?: string;
  projectFilter?: string;
  limitSessions?: number;
}): SessionEdit[] {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return [];

  const candidates: { sessionId: string; projectDir: string; mtime: number }[] = [];

  for (const projEntry of readdirSync(root, { withFileTypes: true })) {
    if (!projEntry.isDirectory()) continue;
    const projDir = projEntry.name;
    if (opts.projectFilter && !projDir.toLowerCase().includes(opts.projectFilter.toLowerCase())) continue;

    const projPath = join(root, projDir);
    let files: string[];
    try { files = readdirSync(projPath); } catch { continue; }

    for (const f of files) {
      if (!f.endsWith('.jsonl') || f === 'sessions-index.json') continue;
      const fp = join(projPath, f);
      try {
        const st = statSync(fp);
        // Subagent-format sessions write into a sibling directory — pick the
        // newest mtime across the stub + subagents so the time-window check
        // doesn't drop active multi-agent sessions.
        let mtime = st.mtimeMs;
        const subDir = join(projPath, f.slice(0, -6), 'subagents');
        if (existsSync(subDir)) {
          for (const sub of readdirSync(subDir)) {
            try {
              const subSt = statSync(join(subDir, sub));
              if (subSt.mtimeMs > mtime) mtime = subSt.mtimeMs;
            } catch { /* ignore */ }
          }
        }
        if (mtime < opts.sinceMs) continue;
        candidates.push({ sessionId: basename(f, '.jsonl'), projectDir: projDir, mtime });
      } catch { /* skip unreadable */ }
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  const limited = opts.limitSessions ? candidates.slice(0, opts.limitSessions) : candidates;

  const allEdits: SessionEdit[] = [];
  const needle = opts.pattern?.toLowerCase();

  for (const c of limited) {
    const scan = liveScanSessionEdits(c.sessionId);
    for (const e of scan.edits) {
      if (e.ts < opts.sinceMs) continue;
      if (needle && !e.file.toLowerCase().includes(needle)) continue;
      allEdits.push(e);
    }
  }

  allEdits.sort((a, b) => b.ts - a.ts);
  return allEdits;
}
