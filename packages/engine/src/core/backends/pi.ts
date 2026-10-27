/**
 * Pi coding agent backend. Owns `~/.pi/agent` (overridable via
 * `CHAT_RECALL_PI_HOME`; Pi's own `PI_CODING_AGENT_DIR` is honoured too).
 *
 * Pi keeps one JSONL file per session under
 * `<agent dir>/sessions/--<encoded-cwd>--/<timestamp>_<session-id>.jsonl`.
 * The first line is a `session` header with the id and the working directory.
 * Every later line is a tree entry with `type`, `id`, `parentId` and a timestamp.
 *
 * This backend reads the raw history: every `message` entry in file order, the
 * way Pi's own JSONL export presents it. The tree pairs calls by `toolCallId`.
 *
 * Content blocks are the provider-neutral shape in Pi's `docs/message-types.md`.
 * Assistant messages hold text, thinking and toolCall blocks. A toolResult row
 * answers a call by `toolCallId`. `bashExecution` holds a direct shell command.
 *
 * IDs are prefixed: 'pi_<session-id>~<project-hash>'.
 */

import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { createHash } from 'crypto';
import { basename, join } from 'path';
import { readTailFromOffset, type TailRead } from './tail-read.js';
import {
  piHomeDir, piSessionDirs, piSkillsDir, piPromptsDir, piMcpConfigPath,
} from '../tool-paths.js';

import type {
  ToolBackend,
  SessionLocation,
  SessionRef,
  ListSessionsOpts,
  ExtractTurnsOpts,
  LiveScanEditsResult,
  CanonicalEvent,
  EditDelta,
  CollectRecentEditsOpts,
  RawSessionExport,
} from '../tool-backend.js';
import type { ExtractedTurns } from '../session-turns.js';
import type { SessionDiffResult } from '../session-replay.js';
import type { SessionOutcome } from '../session-outcome.js';
import type { SessionCommitsResult } from '../session-git.js';
import type { EditOp, SessionEdit } from '../live-session-scan.js';

import { computeOutcome } from '../session-outcome.js';
import { getSessionCommits } from '../session-git.js';
import {
  extractTurnsFromEvents,
  liveScanEditsFromEvents,
  replayFromEvents,
} from '../generic-engine.js';
import { flatString } from '../flat-string.js';

const PREFIX = 'pi_';

/** Header line of a Pi session file. */
interface PiHeader {
  type: 'session';
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
}

/** One parsed session file. */
interface ParsedPiFile {
  header: PiHeader | null;
  entries: any[];
}

/**
 * Read the header and entries of one session file. A line that fails to parse
 * is dropped: Pi appends one line at a time, so a live session can end in a
 * torn line.
 */
function parsePiFile(path: string): ParsedPiFile {
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); } catch { return { header: null, entries: [] }; }
  const out: ParsedPiFile = { header: null, entries: [] };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type === 'session' && !out.header) { out.header = obj as PiHeader; continue; }
    out.entries.push(obj);
  }
  return out;
}

/**
 * The session id a filename carries: `<ISO-ish timestamp>_<session-id>.jsonl`.
 * Pi uses a UUID by default. The SDK and `--session-id` accept any string, so
 * the id is everything after the first `_`.
 */
function idFromFilename(file: string): string | null {
  if (!file.endsWith('.jsonl')) return null;
  const stem = file.slice(0, -'.jsonl'.length);
  const at = stem.indexOf('_');
  const id = at === -1 ? stem : stem.slice(at + 1);
  return id || null;
}

/** Walk one session root, yielding `<encoded-cwd>/<file>.jsonl`. */
function* walkSessionFiles(root: string, depth = 2): Generator<string> {
  if (depth < 0) return;
  let entries: import('fs').Dirent[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) { yield* walkSessionFiles(path, depth - 1); continue; }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}

/**
 * Read only the header line. Pi's header fits well inside 8 KB, and this is
 * what the listing path uses so that walking 5,000 sessions never reads
 * 5,000 transcripts.
 */
export function readPiHeader(path: string): PiHeader | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.toString('utf-8', 0, n).split('\n', 1)[0];
    if (!firstLine.trim()) return null;
    const obj = JSON.parse(firstLine);
    if (!obj || typeof obj !== 'object' || obj.type !== 'session') return null;
    return obj as PiHeader;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * A cheap fingerprint of a session root: its own mtime plus the mtime of each
 * project dir. A new session file bumps its project dir; a new project dir
 * bumps the root. Renames inside a dir bump the dir too — so the index is
 * rebuilt exactly when the set of files can have changed.
 */
function dirSignature(root: string): string {
  const parts: string[] = [];
  try { parts.push(String(statSync(root).mtimeMs)); } catch { return 'missing'; }
  let entries: import('fs').Dirent[] = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return parts.join(','); }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try { parts.push(`${entry.name}:${statSync(join(root, entry.name)).mtimeMs}`); }
    catch { /* vanished */ }
  }
  parts.sort();
  return parts.join(',');
}

/** One session file, before a global key is assigned. */
export interface PiSessionFile {
  id: string;
  /** Working directory from the header; names the conversation's project. */
  projectPath: string;
  /** Containing folder, for display and for the flat-sessionDir fallback. */
  projectDir: string;
  mtime: number;
  path: string;
}

/**
 * Assign a global key to each Pi session file.
 *
 * The key is the id Pi wrote plus a hash of the session's project. Pi writes
 * an id per project, so the hash keeps two projects apart. A custom sessionDir
 * writes one flat folder, and the header cwd still names the project. The key
 * depends on the file alone: an append or a new project changes no key.
 */
export function assignPiSessionKeys(files: PiSessionFile[]): Map<string, PiSessionFile> {
  const out = new Map<string, PiSessionFile>();
  for (const file of files) {
    const key = piSessionKey(file);
    const prior = out.get(key);
    // Two copies for one project are one session; the freshest wins.
    if (!prior || file.mtime > prior.mtime) out.set(key, file);
  }
  return out;
}

/** The global key of one Pi session file. */
export function piSessionKey(file: { id: string; projectPath: string; projectDir: string }): string {
  return `${file.id}~${projectSuffix(file.projectPath || file.projectDir)}`;
}

/** A stable short hash of a project dir, for the cross-project id collision. */
function projectSuffix(projectDir: string): string {
  return createHash('sha256').update(projectDir).digest('hex').slice(0, 8);
}
/** The file's current mtime, with the indexed value as a fallback. */
function mtimeOf(path: string, fallback: number): number {
  try { return statSync(path).mtimeMs; } catch { return fallback; }
}

/** Concatenate the text blocks of a Pi content value. */
function piText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/** Tool input of a Pi `toolCall` block, as a plain object. */
function piToolInput(args: unknown): Record<string, unknown> {
  // `path` is already the field the generic engine reads, so no rename is
  // needed. Copy it, so a caller cannot mutate the parsed entry.
  return args && typeof args === 'object' && !Array.isArray(args)
    ? { ...(args as Record<string, unknown>) }
    : {};
}

export class PiBackend implements ToolBackend {
  readonly id = 'pi' as const;
  readonly idPrefix = PREFIX;
  readonly displayName = 'Pi';

  homeDir(): string { return piHomeDir(); }

  /** Session root(s) — Pi has a single agent dir, so this is one entry. */
  sessionDirs(): string[] { return piSessionDirs(); }

  skillsDir(): string { return piSkillsDir(); }
  promptsDir(): string { return piPromptsDir(); }
  mcpConfigPath(): string { return piMcpConfigPath(); }

  isAvailable(): boolean { return this.sessionDirs().length > 0; }

  // ── ID handling ────────────────────────────────────────────────
  matchesId(id: string): boolean { return id.startsWith(PREFIX); }

  /**
   * A Pi id can itself start with `<prefix>` (`--session-id` allows `_`), so the
   * bare prefix does not identify a stored id. The index does.
   */
  toRawId(id: string): string {
    if (!id.startsWith(PREFIX)) return id;
    if (this.fileIndex().has(id)) return id;          // already a raw key
    return id.slice(PREFIX.length);
  }

  toPrefixedId(rawId: string): string {
    if (!rawId.startsWith(PREFIX)) return PREFIX + rawId;
    return this.fileIndex().has(rawId) ? PREFIX + rawId : rawId;
  }

  // ── Location ───────────────────────────────────────────────────
  /**
   * Session key → file path for every session on this machine.
   *
   * The entry list is cached on the project dirs. When two files carry one key
   * — a copy of a session — this stats them on every call, because an append to
   * the live file changes its mtime and not its folder.
   */
  private fileIndex(): Map<string, string> {
    const roots = this.sessionDirs();
    const signature = roots.map(dirSignature).join('|');
    if (this._index?.signature !== signature) {
      const entries: PiSessionFile[] = [];
      for (const root of roots) {
        for (const path of walkSessionFiles(root)) {
          let mtime = 0;
          try { mtime = statSync(path).mtimeMs; } catch { continue; }
          const header = readPiHeader(path);
          const id = header ? (header.id || idFromFilename(basename(path))) : '';
          entries.push({
            id: id || '',
            projectPath: header?.cwd || '',
            projectDir: basename(join(path, '..')),
            mtime,
            path,
          });
        }
      }
      this._index = { signature, entries };
    }

    const entries = this._index!.entries;
    const seen = new Map<string, PiSessionFile>();
    for (const entry of entries) {
      // A file whose header did not parse on the last walk is retried here, so a
      // finished write shows up without another directory change.
      if (!entry.id) {
        const header = readPiHeader(entry.path);
        if (!header) continue;
        entry.id = header.id || idFromFilename(basename(entry.path)) || '';
        entry.projectPath = header.cwd || '';
        if (!entry.id) continue;
      }
      const key = piSessionKey(entry);
      const prior = seen.get(key);
      if (!prior) { seen.set(key, entry); continue; }
      // One key, two files: keep the file that changed last.
      const priorMtime = mtimeOf(prior.path, prior.mtime);
      const entryMtime = mtimeOf(entry.path, entry.mtime);
      if (entryMtime > priorMtime) seen.set(key, entry);
    }

    const files = new Map<string, string>();
    for (const [key, file] of seen) files.set(key, file.path);
    return files;
  }

  private _index: { signature: string; entries: PiSessionFile[] } | null = null;

  findSession(id: string): SessionLocation | null {
    const rawId = this.toRawId(id);
    const path = this.fileIndex().get(rawId);
    if (!path) return null;
    const header = readPiHeader(path);
    if (!header) return null;
    let mtime = 0;
    try { mtime = statSync(path).mtimeMs; } catch { /* ignore */ }
    return {
      path,
      format: 'jsonl',
      projectDir: basename(join(path, '..')),
      projectPath: header.cwd || '',
      mtime,
    };
  }

  listSessions(opts: ListSessionsOpts = {}): SessionRef[] {
    const cutoff = opts.sinceMs ?? 0;
    const filter = opts.projectFilter?.toLowerCase();
    const out: SessionRef[] = [];

    for (const [rawId, path] of this.fileIndex()) {
      let stat;
      try { stat = statSync(path); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue;

      const header = readPiHeader(path);
      if (!header) continue;                        // not a Pi session file
      const projectPath = header.cwd || '';
      if (filter && !projectPath.toLowerCase().includes(filter)) continue;

      let firstPrompt = '';
      let messageCount = 0;
      if (opts.previews !== false) {
        const parsed = parsePiFile(path);
        for (const entry of parsed.entries) {
          if (entry.type !== 'message') continue;
          const role = entry.message?.role;
          if (role !== 'user' && role !== 'assistant') continue;
          messageCount++;
          if (!firstPrompt && role === 'user') {
            const text = piText(entry.message?.content).trim();
            if (text) firstPrompt = flatString(text.slice(0, 200));
          }
        }
      }

      out.push({
        toolId: 'pi',
        rawId,
        prefixedId: this.toPrefixedId(rawId),
        projectPath,
        projectDir: basename(join(path, '..')),
        fullPath: path,
        created: header.timestamp || stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        mtime: stat.mtimeMs,
        firstPrompt,
        messageCount,
      });
    }

    out.sort((a, b) => b.mtime - a.mtime);
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  // ── Generic-engine inputs ───────────────────────────────────────

  /**
   * The file tools and their EditOp. A shell command carries no path, so it
   * produces no file entry.
   */
  readonly fileToolMap: Record<string, EditOp> = {
    write: 'write',
    edit: 'edit',
    read: 'read',
  };

  /**
   * The inline diff of a file tool.
   *   - write: { path, content }.
   *   - edit:  { path, edits: [{ oldText, newText }] }.
   *
   * An edit holds several disjoint replacements. Join them into one pair.
   */
  extractEditDelta(toolName: string, input: unknown): EditDelta | null {
    if (input == null || typeof input !== 'object') return null;
    const inp = input as Record<string, unknown>;

    if (toolName === 'write') {
      const after = typeof inp.content === 'string' ? inp.content : null;
      if (after === null) return null;
      return { before: '', after };
    }

    if (toolName === 'edit') {
      const edits = Array.isArray(inp.edits) ? inp.edits : [];
      let before = '';
      let after = '';
      for (const raw of edits) {
        if (!raw || typeof raw !== 'object') continue;
        const e = raw as Record<string, unknown>;
        if (typeof e.oldText === 'string') before += (before ? '\n' : '') + e.oldText;
        if (typeof e.newText === 'string') after += (after ? '\n' : '') + e.newText;
      }
      if (!before && !after) return null;
      return { before: before || null, after: after || null };
    }

    return null;
  }

  readEvents(rawId: string): CanonicalEvent[] {
    const located = this.findSession(rawId);
    if (!located) return [];
    let rawText: string;
    try { rawText = readFileSync(located.path, 'utf-8'); } catch { return []; }
    return this.readEventsFromText(rawText, located.mtime);
  }

  /**
   * Parse Pi session text into canonical events. Split out from readEvents so
   * the same parser runs on archived/shadow container bytes.
   */
  readEventsFromText(rawText: string, mtimeFallback = 0): CanonicalEvent[] {
    const events: CanonicalEvent[] = [];
    let lineNum = 0;

    for (const line of rawText.split('\n')) {
      lineNum++;
      if (!line.trim()) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }

      // Entry timestamps are ISO strings; message stamps are epoch ms.
      const tsIso = typeof obj.timestamp === 'string' ? obj.timestamp : undefined;
      const msgTs = typeof obj.message?.timestamp === 'number' ? obj.message.timestamp : undefined;
      const ts = tsIso ? Date.parse(tsIso) || mtimeFallback : (msgTs ?? mtimeFallback);

      if (obj.type === 'message') {
        const msg = obj.message || {};
        const role = msg.role;

        if (role === 'user') {
          const text = piText(msg.content).trim();
          if (text) events.push({ kind: 'user', ts, tsIso, line: lineNum, text });
          continue;
        }

        if (role === 'assistant') {
          const text = piText(msg.content).trim();
          if (text) events.push({ kind: 'assistant_text', ts, tsIso, line: lineNum, text });
          const blocks = Array.isArray(msg.content) ? msg.content : [];
          for (const block of blocks) {
            if (!block || typeof block !== 'object' || block.type !== 'toolCall') continue;
            const toolName = String(block.name || '');
            if (!toolName) continue;
            const input = piToolInput(block.arguments);
            const command = (toolName === 'bash' || toolName === 'powershell')
              ? (typeof input.command === 'string' ? input.command : undefined)
              : undefined;
            events.push({
              kind: 'tool_use', ts, tsIso, line: lineNum,
              toolName,
              toolUseId: typeof block.id === 'string' ? block.id : '',
              toolInput: input,
              command,
            });
          }
          continue;
        }

        if (role === 'toolResult') {
          const body = piText(msg.content);
          events.push({
            kind: 'tool_result', ts, tsIso, line: lineNum,
            toolName: typeof msg.toolName === 'string' ? msg.toolName : undefined,
            toolUseId: typeof msg.toolCallId === 'string' ? msg.toolCallId : '',
            resultBody: body,
            resultIsError: msg.isError === true,
            resultBytes: body.length,
          });
          continue;
        }

        // A shell command the user ran through Pi's `!` escape. It belongs in
        // the command timeline as a use + result pair.
        if (role === 'bashExecution') {
          const command = typeof msg.command === 'string' ? msg.command : '';
          const output = typeof msg.output === 'string' ? msg.output : '';
          const toolUseId = `pi_bash_${lineNum}`;
          events.push({
            kind: 'tool_use', ts, tsIso, line: lineNum,
            toolName: 'bash', toolUseId,
            toolInput: { command }, command,
          });
          events.push({
            kind: 'tool_result', ts, tsIso, line: lineNum,
            toolUseId, toolName: 'bash',
            resultBody: output,
            resultIsError: typeof msg.exitCode === 'number' && msg.exitCode !== 0,
            resultExitCode: typeof msg.exitCode === 'number' ? msg.exitCode : undefined,
            resultBytes: output.length,
          });
          continue;
        }

        // `system`, `custom` and `branchSummary` messages are prompt/context
        // material, not conversation turns.
        continue;
      }

      // Compaction and branch summaries are the session's own summaries of
      // work that left the context window. Keep them as summary events so a
      // compacted session still says what happened before the fold.
      if (obj.type === 'compaction' && typeof obj.summary === 'string' && obj.summary.trim()) {
        events.push({ kind: 'summary', ts, tsIso, line: lineNum, text: obj.summary.trim() });
        continue;
      }
      if (obj.type === 'branch_summary' && typeof obj.summary === 'string' && obj.summary.trim()) {
        events.push({ kind: 'summary', ts, tsIso, line: lineNum, text: obj.summary.trim() });
      }
    }

    return events;
  }

  // ── Per-session operations — all delegate to the generic engine ─
  extractTurns(id: string, opts: ExtractTurnsOpts = {}): ExtractedTurns {
    const events = this.readEvents(this.toRawId(id));
    return extractTurnsFromEvents(this.toPrefixedId(id), events, opts);
  }

  liveScanEdits(id: string): LiveScanEditsResult {
    const located = this.findSession(this.toRawId(id));
    if (!located) {
      return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool: 'pi' };
    }
    const events = this.readEvents(this.toRawId(id));
    return liveScanEditsFromEvents(events, this.fileToolMap, {
      sessionId: this.toPrefixedId(id),
      tool: 'pi',
      projectPath: located.projectPath,
      projectDir: located.projectDir,
      fileMtime: located.mtime,
      found: true,
    }, this.extractEditDelta.bind(this));
  }

  replay(id: string): SessionDiffResult {
    const located = this.findSession(this.toRawId(id));
    if (!located) {
      return { sessionId: this.toPrefixedId(id), found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };
    }
    const events = this.readEvents(this.toRawId(id));
    return replayFromEvents(
      this.toPrefixedId(id), events, this.fileToolMap, this.extractEditDelta.bind(this),
      { projectPath: located.projectPath, found: true },
    );
  }

  computeOutcome(id: string, opts?: { commitBufferMinutes?: number }): SessionOutcome {
    return computeOutcome(this.toPrefixedId(id), opts);
  }

  collectRecentEdits(opts: CollectRecentEditsOpts): SessionEdit[] {
    const candidates: Array<{ rawId: string; mtime: number }> = [];
    for (const [rawId, path] of this.fileIndex()) {
      let stat;
      try { stat = statSync(path); } catch { continue; }
      if (stat.mtimeMs < opts.sinceMs) continue;
      if (opts.projectFilter) {
        const header = readPiHeader(path);
        const projectPath = header?.cwd || '';
        if (!projectPath.toLowerCase().includes(opts.projectFilter.toLowerCase())) continue;
      }
      candidates.push({ rawId, mtime: stat.mtimeMs });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const limited = opts.limitSessions ? candidates.slice(0, opts.limitSessions) : candidates;

    const edits: SessionEdit[] = [];
    for (const c of limited) edits.push(...this.liveScanEdits(c.rawId).edits);
    return edits;
  }

  getCommits(
    id: string,
    files: string[],
    startMs: number,
    endMs: number,
    bufferMinutes?: number,
  ): SessionCommitsResult {
    return getSessionCommits(this.toPrefixedId(id), files, startMs, endMs, bufferMinutes);
  }

  /**
   * Pi's user-assigned session name (`/name`, `--name`), from the newest
   * `session_info` entry. Null when the session was never named.
   */
  getNativeTitle(rawId: string): string | null {
    const located = this.findSession(rawId);
    if (!located) return null;
    const parsed = parsePiFile(located.path);
    for (let i = parsed.entries.length - 1; i >= 0; i--) {
      const entry = parsed.entries[i];
      if (entry.type !== 'session_info') continue;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (name) return name;
    }
    return null;
  }

  exportRawSession(id: string): RawSessionExport | null {
    const located = this.findSession(id);
    if (!located) return null;
    try {
      const st = statSync(located.path);
      return {
        tool: 'pi',
        mtime: st.mtimeMs,
        files: [{ name: basename(located.path), bytes: readFileSync(located.path) }],
      };
    } catch {
      return null;
    }
  }

  isAppendOnly(): boolean { return true; }

  fileSize(prefixedId: string): number {
    const located = this.findSession(prefixedId);
    if (!located) return 0;
    try { return statSync(located.path).size; } catch { return 0; }
  }

  async readFromOffset(prefixedId: string, offset: number, maxBytes?: number): Promise<TailRead> {
    const located = this.findSession(prefixedId);
    if (!located) return { text: '', newOffset: offset };
    return readTailFromOffset(located.path, offset, maxBytes);
  }
}

export const piBackend = new PiBackend();
