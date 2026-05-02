/**
 * Live-scan helpers for active or unindexed sessions across all four AI
 * tools — Claude Code, Gemini CLI, OpenCode, and Codex.
 *
 * The indexer only updates extra_json (filesModified, toolsUsed, etc.) when a
 * session is re-indexed. For the *active* session — the one currently running
 * — those fields lag behind reality. These helpers walk the transcripts on
 * disk and pull file activity straight from each tool's native tool-call
 * format so callers can answer "what did this session just touch?" without
 * waiting for a re-index.
 *
 * Per-tool sources:
 *   - claude:    ~/.claude/projects/<encoded>/<uuid>.jsonl (+ subagents/)
 *   - gemini:    ~/.gemini/tmp/<sha256>/chats/session-*.json
 *   - opencode:  ~/.local/share/opencode/opencode.db (SQLite, `part` table)
 */

import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { hasSubagentsDir } from '../parsers/session.js';

export type AiTool = 'claude' | 'gemini' | 'opencode' | 'codex';

export type EditOp = 'edit' | 'write' | 'multi_edit' | 'notebook_edit' | 'read';

export interface SessionEdit {
  ts: number;          // epoch ms — falls back to file mtime when entry has no timestamp
  tsIso?: string;      // original ISO timestamp from the entry, if present
  sessionId: string;
  projectPath: string;
  file: string;
  op: EditOp;
  toolName: string;    // raw tool name from the tool's own taxonomy
  tool: AiTool;        // which AI tool produced the edit
  line: number;        // line number in transcript (claude) or 0 for stores w/o lines
}

// ── Claude ─────────────────────────────────────────────────────────
const CLAUDE_FILE_TOOLS: Record<string, EditOp> = {
  Edit: 'edit',
  Write: 'write',
  MultiEdit: 'multi_edit',
  NotebookEdit: 'notebook_edit',
  Read: 'read',
};

// ── Gemini ─────────────────────────────────────────────────────────
const GEMINI_FILE_TOOLS: Record<string, EditOp> = {
  write_file: 'write',
  replace: 'edit',
  read_file: 'read',
  read_many_files: 'read',
};

// ── OpenCode ───────────────────────────────────────────────────────
const OPENCODE_FILE_TOOLS: Record<string, EditOp> = {
  edit: 'edit',
  write: 'write',
  read: 'read',
};

/**
 * Tool-of-origin for a session id. Mirrors the prefix scheme the indexer uses:
 *   - "claude":    bare uuid
 *   - "gemini":    "gemini_<id>"
 *   - "opencode":  "opencode_<id>"
 */
export function detectTool(sessionId: string): AiTool {
  if (sessionId.startsWith('opencode_')) return 'opencode';
  if (sessionId.startsWith('gemini_')) return 'gemini';
  if (sessionId.startsWith('codex_')) return 'codex';
  return 'claude';
}

/**
 * Locate a Claude session's .jsonl file. Returns null when not present.
 * Kept for callers that specifically want the on-disk path; tool-aware
 * callers should use detectTool() and dispatch to the per-tool scanner.
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
 * Walk a session's transcript and yield every file-touching tool call.
 * Dispatches to the right per-tool implementation based on the session id
 * prefix. This is the same logic the indexer would record once a session is
 * closed — but run on demand so it works for the live session.
 */
export function liveScanSessionEdits(sessionId: string): {
  found: boolean;
  projectPath: string;
  projectDir: string;
  edits: SessionEdit[];
  fileMtime: number;
  tool: AiTool;
} {
  const tool = detectTool(sessionId);
  const empty = { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool };
  switch (tool) {
    case 'claude':   return scanClaudeSession(sessionId);
    case 'gemini':   return scanGeminiSession(sessionId.replace(/^gemini_/, ''));
    case 'opencode': return scanOpenCodeSession(sessionId.replace(/^opencode_/, ''));
    case 'codex':    return scanCodexSession(sessionId);
    default:         return empty;
  }
}

function scanClaudeSession(sessionId: string) {
  const located = findSessionFile(sessionId);
  if (!located) {
    return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool: 'claude' as const };
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
        if (!toolName || !(toolName in CLAUDE_FILE_TOOLS)) continue;
        const file = extractFilePathFromInput(toolName, it.input);
        if (!file) continue;

        edits.push({
          ts, tsIso, sessionId,
          projectPath: located.projectPath,
          file,
          op: CLAUDE_FILE_TOOLS[toolName],
          toolName,
          tool: 'claude',
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
    tool: 'claude' as const,
  };
}

let geminiProjectMapCache: Map<string, string> | null = null;
function loadGeminiProjectMap(): Map<string, string> {
  if (geminiProjectMapCache) return geminiProjectMapCache;
  const map = new Map<string, string>();
  const projectsPath = join(homedir(), '.gemini', 'projects.json');
  if (existsSync(projectsPath)) {
    try {
      const data = JSON.parse(readFileSync(projectsPath, 'utf-8'));
      for (const path of Object.keys(data.projects || {})) {
        map.set(createHash('sha256').update(path).digest('hex'), path);
      }
    } catch { /* tolerate corrupt file */ }
  }
  geminiProjectMapCache = map;
  return map;
}

function findGeminiSessionFile(sessionIdOrFileBase: string): { path: string; projectDir: string; projectPath: string } | null {
  const tmpRoot = join(homedir(), '.gemini', 'tmp');
  if (!existsSync(tmpRoot)) return null;
  const projMap = loadGeminiProjectMap();

  for (const proj of readdirSync(tmpRoot, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const chats = join(tmpRoot, proj.name, 'chats');
    if (!existsSync(chats)) continue;
    let files: string[];
    try { files = readdirSync(chats); } catch { continue; }
    for (const f of files) {
      if (!f.startsWith('session-') || !f.endsWith('.json')) continue;
      const fileBase = f.replace(/\.json$/, '');
      // Match either by file basename (preferred) or by the sessionId stored
      // inside the JSON. We try basename first since it's free.
      if (fileBase === sessionIdOrFileBase) {
        return { path: join(chats, f), projectDir: proj.name, projectPath: projMap.get(proj.name) || '' };
      }
    }
  }

  // Fallback: open every file and check the inner sessionId. Slower but
  // necessary because indexer used `content.sessionId || basename(file)`.
  for (const proj of readdirSync(tmpRoot, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const chats = join(tmpRoot, proj.name, 'chats');
    if (!existsSync(chats)) continue;
    let files: string[];
    try { files = readdirSync(chats); } catch { continue; }
    for (const f of files) {
      if (!f.startsWith('session-') || !f.endsWith('.json')) continue;
      const path = join(chats, f);
      try {
        const json = JSON.parse(readFileSync(path, 'utf-8'));
        if (json.sessionId === sessionIdOrFileBase) {
          return { path, projectDir: proj.name, projectPath: projMap.get(proj.name) || '' };
        }
      } catch { /* skip */ }
    }
  }
  return null;
}

function scanGeminiSession(sessionId: string) {
  const located = findGeminiSessionFile(sessionId);
  if (!located) {
    return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool: 'gemini' as const };
  }
  let fileMtime = 0;
  try { fileMtime = statSync(located.path).mtimeMs; } catch { /* ignore */ }

  const edits: SessionEdit[] = [];
  let json: any;
  try { json = JSON.parse(readFileSync(located.path, 'utf-8')); }
  catch {
    return { found: true, projectPath: located.projectPath, projectDir: located.projectDir, edits, fileMtime, tool: 'gemini' as const };
  }

  const messages = Array.isArray(json.messages) ? json.messages : [];
  for (const m of messages) {
    if (m?.type !== 'gemini') continue;
    const tcs = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    const tsIso = typeof m.timestamp === 'string' ? m.timestamp : undefined;
    const ts = tsIso ? Date.parse(tsIso) || fileMtime : fileMtime;
    for (const tc of tcs) {
      const name = tc?.name as string;
      if (!name || !(name in GEMINI_FILE_TOOLS)) continue;
      const args = tc.args || {};
      const file = args.file_path || args.absolute_path || args.path;
      // read_many_files passes an array of paths — emit one edit per path.
      const files = Array.isArray(args.paths) ? args.paths : (typeof file === 'string' ? [file] : []);
      for (const f of files) {
        if (typeof f !== 'string' || !f.trim()) continue;
        edits.push({
          ts, tsIso,
          sessionId: `gemini_${json.sessionId || basename(located.path, '.json')}`,
          projectPath: located.projectPath,
          file: f,
          op: GEMINI_FILE_TOOLS[name],
          toolName: name,
          tool: 'gemini',
          line: 0,
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
    tool: 'gemini' as const,
  };
}

function openOpenCodeDb(): Database.Database | null {
  const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return null;
  try { return new Database(dbPath, { readonly: true, fileMustExist: true }); }
  catch { return null; }
}

function scanOpenCodeSession(sessionId: string) {
  const db = openOpenCodeDb();
  if (!db) {
    return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool: 'opencode' as const };
  }
  try {
    const sess = db.prepare(`
      SELECT s.id, s.directory, s.time_updated,
             p.worktree as project_path
      FROM session s LEFT JOIN project p ON s.project_id = p.id
      WHERE s.id = ?
    `).get(sessionId) as { id: string; directory: string | null; time_updated: number; project_path: string | null } | undefined;
    if (!sess) {
      return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool: 'opencode' as const };
    }
    const projectPath = sess.project_path || sess.directory || '';
    const parts = db.prepare(`
      SELECT time_created, data
      FROM part
      WHERE session_id = ? AND data LIKE '%"type":"tool"%'
      ORDER BY time_created ASC
    `).all(sessionId) as Array<{ time_created: number; data: string }>;

    const edits: SessionEdit[] = [];
    for (const p of parts) {
      let d: any;
      try { d = JSON.parse(p.data); } catch { continue; }
      const name = d?.tool as string;
      if (!name || !(name in OPENCODE_FILE_TOOLS)) continue;
      const inp = d?.state?.input || {};
      const file = inp.filePath || inp.file_path || inp.path;
      if (typeof file !== 'string' || !file.trim()) continue;
      edits.push({
        ts: p.time_created,
        tsIso: new Date(p.time_created).toISOString(),
        sessionId: `opencode_${sessionId}`,
        projectPath,
        file,
        op: OPENCODE_FILE_TOOLS[name],
        toolName: name,
        tool: 'opencode',
        line: 0,
      });
    }

    return {
      found: true,
      projectPath,
      projectDir: '',
      edits,
      fileMtime: sess.time_updated || 0,
      tool: 'opencode' as const,
    };
  } finally {
    db.close();
  }
}

// ── Codex ──────────────────────────────────────────────────────────

export function findCodexSessionFile(sessionId: string): { path: string; projectPath: string } | null {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return null;

  // Walk YYYY/MM/DD directories
  for (const year of readdirSync(root, { withFileTypes: true })) {
    if (!year.isDirectory()) continue;
    const yearPath = join(root, year.name);
    for (const month of readdirSync(yearPath, { withFileTypes: true })) {
      if (!month.isDirectory()) continue;
      const monthPath = join(yearPath, month.name);
      for (const day of readdirSync(monthPath, { withFileTypes: true })) {
        if (!day.isDirectory()) continue;
        const dayPath = join(monthPath, day.name);
        let files: string[];
        try { files = readdirSync(dayPath); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          // Filename ends with <uuid>.jsonl after the timestamp prefix
          if (f.includes(sessionId)) {
            return { path: join(dayPath, f), projectPath: '' };
          }
        }
      }
    }
  }

  // Fallback: brute-force recursive scan checking the first line id
  function scanDir(dir: string): { path: string; projectPath: string } | null {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const found = scanDir(join(dir, entry.name));
        if (found) return found;
      } else if (entry.name.endsWith('.jsonl')) {
        const p = join(dir, entry.name);
        try {
          const first = readFileSync(p, 'utf-8').split('\n')[0];
          if (!first) continue;
          const meta = JSON.parse(first);
          if (meta?.payload?.id === sessionId) {
            return { path: p, projectPath: meta?.payload?.cwd || '' };
          }
        } catch { /* skip */ }
      }
    }
    return null;
  }

  return scanDir(root);
}

function scanCodexSession(sessionId: string) {
  const id = sessionId.replace(/^codex_/, '');
  const located = findCodexSessionFile(id);
  if (!located) {
    return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool: 'codex' as const };
  }
  let fileMtime = 0;
  try { fileMtime = statSync(located.path).mtimeMs; } catch { /* ignore */ }

  const edits: SessionEdit[] = [];
  let raw: string;
  try { raw = readFileSync(located.path, 'utf-8'); } catch {
    return { found: true, projectPath: located.projectPath, projectDir: '', edits, fileMtime, tool: 'codex' as const };
  }

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line); } catch { continue; }

    const tsIso = typeof obj.timestamp === 'string' ? obj.timestamp : undefined;
    const ts = tsIso ? Date.parse(tsIso) || fileMtime : fileMtime;

    const type = obj.type;
    const payload = obj.payload as Record<string, unknown> | undefined;

    if (type === 'event_msg' && payload && typeof payload === 'object') {
      if (payload.type !== 'exec_command_end') continue;
      const parsedCmd = payload.parsed_cmd as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(parsedCmd)) continue;

      for (const cmd of parsedCmd) {
        const cmdType = (cmd.type as string) || '';
        let op: EditOp | null = null;
        if (cmdType.includes('read')) op = 'read';
        else if (cmdType.includes('write')) op = 'write';
        else if (cmdType.includes('edit')) op = 'edit';
        if (!op) continue;

        let file = (cmd.file as string) || (cmd.path as string) || (cmd.file_path as string) || '';
        if (!file) {
          const stdout = (payload.stdout as string) || (payload.aggregated_output as string) || '';
          const match = stdout.match(/(?:^|[\s\n])([~\/\.\w-]+\.[a-zA-Z0-9]+)/);
          if (match) file = match[1];
        }
        if (!file) continue;

        edits.push({
          ts, tsIso,
          sessionId: `codex_${id}`,
          projectPath: located.projectPath,
          file,
          op,
          toolName: cmdType,
          tool: 'codex',
          line: i + 1,
        });
      }
    }

    if (type === 'response_item' && payload && typeof payload === 'object') {
      if (payload.type !== 'function_call') continue;
      const name = (payload.name as string) || '';
      if (!name) continue;
      let op: EditOp | null = null;
      if (name.includes('read')) op = 'read';
      else if (name.includes('write')) op = 'write';
      else if (name.includes('edit')) op = 'edit';
      if (!op) continue;

      const args = payload.arguments as Record<string, unknown> || {};
      const file = (args.file as string) || (args.path as string) || (args.file_path as string) || (args.target_file as string) || '';
      if (!file) continue;

      edits.push({
        ts, tsIso,
        sessionId: `codex_${id}`,
        projectPath: located.projectPath,
        file,
        op,
        toolName: name,
        tool: 'codex',
        line: i + 1,
      });
    }
  }

  return {
    found: true,
    projectPath: located.projectPath,
    projectDir: '',
    edits,
    fileMtime,
    tool: 'codex' as const,
  };
}

/**
 * Convenience wrapper — returns just the deduped list of files modified
 * (write/edit/multi_edit/notebook_edit). Mirrors the shape the indexer's
 * `extra_json.filesModified` would produce. Tool-aware via session id prefix.
 */
export function liveScanModifiedFiles(sessionId: string): {
  found: boolean;
  files: string[];
  reads: string[];
  edits: SessionEdit[];
  projectPath: string;
  tool: AiTool;
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
    tool: scan.tool,
  };
}

/**
 * Live-scan every session whose transcript was modified since `sinceMs`,
 * across all three AI tools (Claude / Gemini / OpenCode).
 *
 * Used by recall_edits_timeline. Heavy when called with a wide window — we
 * scan transcripts top-to-bottom — but for the typical "last 24h" window
 * it's a handful of files.
 */
export function liveScanRecentEdits(opts: {
  sinceMs: number;
  pattern?: string;
  projectFilter?: string;
  limitSessions?: number;
  tools?: AiTool[]; // default: all four
}): SessionEdit[] {
  const enabled = new Set(opts.tools ?? ['claude', 'gemini', 'opencode', 'codex'] as AiTool[]);
  const allEdits: SessionEdit[] = [];
  const needle = opts.pattern?.toLowerCase();

  const accept = (e: SessionEdit) => {
    if (e.ts < opts.sinceMs) return false;
    if (needle && !e.file.toLowerCase().includes(needle)) return false;
    return true;
  };

  if (enabled.has('claude')) collectClaudeRecentEdits(opts, allEdits, accept);
  if (enabled.has('gemini')) collectGeminiRecentEdits(opts, allEdits, accept);
  if (enabled.has('opencode')) collectOpenCodeRecentEdits(opts, allEdits, accept);
  if (enabled.has('codex')) collectCodexRecentEdits(opts, allEdits, accept);

  allEdits.sort((a, b) => b.ts - a.ts);
  return allEdits;
}

function collectClaudeRecentEdits(
  opts: { sinceMs: number; projectFilter?: string; limitSessions?: number },
  out: SessionEdit[],
  accept: (e: SessionEdit) => boolean,
): void {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return;

  const candidates: { sessionId: string; mtime: number }[] = [];
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
        candidates.push({ sessionId: basename(f, '.jsonl'), mtime });
      } catch { /* skip */ }
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  const limited = opts.limitSessions ? candidates.slice(0, opts.limitSessions) : candidates;
  for (const c of limited) {
    const scan = scanClaudeSession(c.sessionId);
    for (const e of scan.edits) if (accept(e)) out.push(e);
  }
}

function collectGeminiRecentEdits(
  opts: { sinceMs: number; projectFilter?: string; limitSessions?: number },
  out: SessionEdit[],
  accept: (e: SessionEdit) => boolean,
): void {
  const tmpRoot = join(homedir(), '.gemini', 'tmp');
  if (!existsSync(tmpRoot)) return;
  const projMap = loadGeminiProjectMap();

  const candidates: { fileBase: string; projectDir: string; mtime: number }[] = [];
  for (const proj of readdirSync(tmpRoot, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const projectPath = projMap.get(proj.name) || '';
    if (opts.projectFilter) {
      // Match either against the encoded dir name or the resolved path.
      const haystack = (projectPath + ' ' + proj.name).toLowerCase();
      if (!haystack.includes(opts.projectFilter.toLowerCase())) continue;
    }
    const chats = join(tmpRoot, proj.name, 'chats');
    if (!existsSync(chats)) continue;
    let files: string[];
    try { files = readdirSync(chats); } catch { continue; }
    for (const f of files) {
      if (!f.startsWith('session-') || !f.endsWith('.json')) continue;
      try {
        const st = statSync(join(chats, f));
        if (st.mtimeMs < opts.sinceMs) continue;
        candidates.push({ fileBase: f.slice(0, -5), projectDir: proj.name, mtime: st.mtimeMs });
      } catch { /* skip */ }
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  const limited = opts.limitSessions ? candidates.slice(0, opts.limitSessions) : candidates;
  for (const c of limited) {
    const scan = scanGeminiSession(c.fileBase);
    for (const e of scan.edits) if (accept(e)) out.push(e);
  }
}

function collectOpenCodeRecentEdits(
  opts: { sinceMs: number; projectFilter?: string; limitSessions?: number },
  out: SessionEdit[],
  accept: (e: SessionEdit) => boolean,
): void {
  const db = openOpenCodeDb();
  if (!db) return;
  try {
    // One pass: pull every part newer than sinceMs whose data smells like a
    // file-touching tool call. Cheaper than scanning sessions one-by-one.
    const sql = `
      SELECT
        p.session_id,
        p.time_created,
        p.data,
        s.directory,
        pr.worktree AS project_path
      FROM part p
      JOIN session s ON s.id = p.session_id
      LEFT JOIN project pr ON pr.id = s.project_id
      WHERE p.time_created >= ?
        AND p.data LIKE '%"type":"tool"%'
        AND (p.data LIKE '%"tool":"edit"%' OR p.data LIKE '%"tool":"write"%' OR p.data LIKE '%"tool":"read"%')
      ORDER BY p.time_created DESC
    `;
    const rows = db.prepare(sql).all(opts.sinceMs) as Array<{
      session_id: string;
      time_created: number;
      data: string;
      directory: string | null;
      project_path: string | null;
    }>;

    for (const r of rows) {
      const projectPath = r.project_path || r.directory || '';
      if (opts.projectFilter && !projectPath.toLowerCase().includes(opts.projectFilter.toLowerCase())) continue;

      let d: any;
      try { d = JSON.parse(r.data); } catch { continue; }
      const name = d?.tool as string;
      if (!name || !(name in OPENCODE_FILE_TOOLS)) continue;
      const inp = d?.state?.input || {};
      const file = inp.filePath || inp.file_path || inp.path;
      if (typeof file !== 'string' || !file.trim()) continue;

      const e: SessionEdit = {
        ts: r.time_created,
        tsIso: new Date(r.time_created).toISOString(),
        sessionId: `opencode_${r.session_id}`,
        projectPath,
        file,
        op: OPENCODE_FILE_TOOLS[name],
        toolName: name,
        tool: 'opencode',
        line: 0,
      };
      if (accept(e)) out.push(e);
    }
  } finally {
    db.close();
  }
}
function collectCodexRecentEdits(
  opts: { sinceMs: number; projectFilter?: string; limitSessions?: number },
  out: SessionEdit[],
  accept: (e: SessionEdit) => boolean,
): void {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return;

  const candidates: {
    sessionId: string;
    mtime: number;
    projectPath: string;
    isSubagent: boolean;
    parentId: string | null;
  }[] = [];

  function scanDir(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scanDir(join(dir, entry.name));
      } else if (entry.name.endsWith('.jsonl')) {
        const p = join(dir, entry.name);
        try {
          const st = statSync(p);
          if (st.mtimeMs < opts.sinceMs) continue;
          // Extract UUID from filename: rollout-...-<uuid>.jsonl
          const uuidMatch = entry.name.match(/([a-f0-9-]{36})\.jsonl$/);
          const sessionId = uuidMatch ? uuidMatch[1] : '';
          if (!sessionId) continue;
          // Read first line for cwd (projectPath) + sub-agent detection.
          // Codex spawns one rollout per sub-agent dispatch — those carry
          // thread_spawn / agent_role and should not surface as separate
          // sessions in the activity timeline. Their edits get rolled into
          // the parent session below.
          let projectPath = '';
          let parentId: string | null = null;
          let isSubagent = false;
          try {
            const first = readFileSync(p, 'utf-8').split('\n')[0];
            if (first) {
              const meta = JSON.parse(first);
              const payload = meta?.payload || {};
              projectPath = payload.cwd || '';
              const spawn = payload.source?.subagent?.thread_spawn;
              if (spawn || payload.agent_role || payload.agent_nickname) {
                isSubagent = true;
                parentId = spawn?.parent_thread_id || null;
              }
            }
          } catch { /* ignore */ }
          if (opts.projectFilter && !projectPath.toLowerCase().includes(opts.projectFilter.toLowerCase())) continue;
          candidates.push({ sessionId, mtime: st.mtimeMs, projectPath, isSubagent, parentId });
        } catch { /* skip */ }
      }
    }
  }

  scanDir(root);

  candidates.sort((a, b) => b.mtime - a.mtime);
  const limited = opts.limitSessions ? candidates.slice(0, opts.limitSessions) : candidates;
  for (const c of limited) {
    const scan = scanCodexSession(c.sessionId);
    // Re-attribute sub-agent edits to their parent so the timeline groups
    // them under the user-facing conversation rather than fanning out.
    const reattribute = c.isSubagent && c.parentId ? `codex_${c.parentId}` : null;
    for (const e of scan.edits) {
      const edit = reattribute ? { ...e, sessionId: reattribute } : e;
      if (accept(edit)) out.push(edit);
    }
  }
}
