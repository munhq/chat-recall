/**
 * Hermes Agent backend. Owns `<hermes home>/state.db` and the `state.db` of
 * each named profile under `<hermes home>/profiles/`.
 *
 * Hermes keeps a session in SQLite: one row in `sessions`, and one row in
 * `messages` per chat message in the OpenAI shape — `role`, `content`,
 * `tool_calls` (a JSON array of function calls) on an assistant row, and
 * `tool_call_id` on the `tool` row that answers it. There is no file per
 * session, so SessionLocation.path is the database.
 *
 * IDs are prefixed: 'hermes_<session-id>'.
 */

import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'fs';
import { openSqliteReadonly } from '../sqlite-reader.js';
import { hermesDbPaths, hermesHomeDir } from '../tool-paths.js';

import type {
  ToolBackend,
  SessionLocation,
  SessionRef,
  ListSessionsOpts,
  ExtractTurnsOpts,
  LiveScanEditsResult,
  CanonicalEvent,
  EditDelta,
  RawSessionExport,
  CollectRecentEditsOpts,
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

const PREFIX = 'hermes_';

/** The columns of a `messages` row this backend reads. */
interface HermesMessageRow {
  id: number;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  timestamp: number;
  display_kind: string | null;
  active: number;
  _compressed_summary: number;
}

const MESSAGE_COLUMNS =
  'id, role, content, tool_calls, tool_call_id, tool_name, timestamp, display_kind, active, _compressed_summary';

/** The session columns the archive keeps. The system prompt is left out: it
 *  is the same for every session and holds the operator's own instructions. */
const ARCHIVED_SESSION_COLUMNS = [
  'id', 'source', 'title', 'model', 'cwd', 'git_branch', 'git_repo_root',
  'parent_session_id', 'started_at', 'ended_at', 'end_reason',
  'message_count', 'tool_call_count', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens',
  'estimated_cost_usd', 'actual_cost_usd',
];

/** Newest activity of a session, in epoch seconds. A one-shot session has no
 *  last_activity_at, and a live one has no ended_at, so the newest message
 *  decides as well. */
const SESSION_MTIME_SQL = `MAX(
  s.started_at,
  COALESCE(s.ended_at, 0),
  COALESCE(s.last_activity_at, 0),
  COALESCE((SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id), 0)
)`;

export class HermesBackend implements ToolBackend {
  readonly id = 'hermes' as const;
  readonly idPrefix = PREFIX;
  readonly displayName = 'Hermes';

  homeDir(): string { return hermesHomeDir(); }

  /** Every Hermes database on this machine, the root profile first. */
  dbPaths(): string[] { return hermesDbPaths(); }

  isAvailable(): boolean {
    return this.dbPaths().some((p) => existsSync(p));
  }

  /** The database that holds this session. A session id is unique within a
   *  database, and each named profile has its own. */
  dbPathFor(rawId: string): string | null {
    const cached = this._dbForSession.get(rawId);
    if (cached) return cached;
    for (const path of this.dbPaths()) {
      const db = openSqliteReadonly(path);
      if (!db) continue;
      try {
        if (db.prepare('SELECT 1 AS ok FROM sessions WHERE id = ?').get(rawId)) {
          this._dbForSession.set(rawId, path);
          return path;
        }
      } catch { /* not a Hermes schema — try the next database */ }
      finally { db.close(); }
    }
    return null;
  }

  private readonly _dbForSession = new Map<string, string>();

  /** Tests, and anything that adds a profile mid-process. */
  _clearDbRouting(): void { this._dbForSession.clear(); }

  // ── ID handling ────────────────────────────────────────────────
  matchesId(id: string): boolean { return id.startsWith(PREFIX); }
  toRawId(id: string): string { return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id; }
  toPrefixedId(rawId: string): string { return rawId.startsWith(PREFIX) ? rawId : PREFIX + rawId; }

  // ── Location ───────────────────────────────────────────────────
  findSession(id: string): SessionLocation | null {
    const rawId = this.toRawId(id);
    const path = this.dbPathFor(rawId);
    if (!path) return null;
    const db = openSqliteReadonly(path);
    if (!db) return null;
    try {
      const row = db.prepare(`
        SELECT s.cwd, s.git_repo_root, ${SESSION_MTIME_SQL} AS mtime
        FROM sessions s WHERE s.id = ?
      `).get(rawId) as { cwd: string | null; git_repo_root: string | null; mtime: number } | undefined;
      if (!row) return null;
      return {
        path,
        format: 'sqlite',
        projectDir: '',
        projectPath: row.git_repo_root || row.cwd || '',
        mtime: Math.round((row.mtime || 0) * 1000),
      };
    } catch { return null; } finally { db.close(); }
  }

  listSessions(opts: ListSessionsOpts = {}): SessionRef[] {
    const byId = new Map<string, SessionRef>();
    for (const dbPath of this.dbPaths()) {
      if (!existsSync(dbPath)) continue;
      for (const ref of this.listSessionsInDb(dbPath, opts)) {
        const prior = byId.get(ref.rawId);
        if (!prior || ref.mtime > prior.mtime) byId.set(ref.rawId, ref);
      }
    }
    const all = [...byId.values()].sort((a, b) => b.mtime - a.mtime);
    return opts.limit ? all.slice(0, opts.limit) : all;
  }

  private listSessionsInDb(dbPath: string, opts: ListSessionsOpts): SessionRef[] {
    const cutoffSec = (opts.sinceMs ?? 0) / 1000;
    const filter = opts.projectFilter?.toLowerCase();
    const db = openSqliteReadonly(dbPath);
    if (!db) return [];
    try {
      const rows = db.prepare(`
        SELECT * FROM (
          SELECT s.id, s.cwd, s.git_repo_root, s.started_at, s.message_count,
                 ${SESSION_MTIME_SQL} AS mtime
          FROM sessions s
        ) WHERE mtime >= ? ORDER BY mtime DESC
      `).all(cutoffSec) as Array<{
        id: string; cwd: string | null; git_repo_root: string | null;
        started_at: number; message_count: number | null; mtime: number;
      }>;
      const out: SessionRef[] = [];
      for (const row of rows) {
        const projectPath = row.git_repo_root || row.cwd || '';
        if (filter && !projectPath.toLowerCase().includes(filter)) continue;
        const mtime = Math.round(row.mtime * 1000);
        this._dbForSession.set(row.id, dbPath);
        out.push({
          toolId: 'hermes',
          rawId: row.id,
          prefixedId: this.toPrefixedId(row.id),
          projectPath,
          projectDir: '',
          fullPath: dbPath,
          created: new Date(Math.round(row.started_at * 1000)).toISOString(),
          modified: new Date(mtime).toISOString(),
          mtime,
          firstPrompt: opts.previews === false ? '' : firstUserPrompt(db, row.id),
          messageCount: opts.previews === false ? 0 : row.message_count ?? 0,
        });
        if (opts.limit && out.length >= opts.limit) break;
      }
      return out;
    } catch { return []; } finally { db.close(); }
  }

  /** Hermes writes a title for each session (a model-written one, or the
   *  first prompt for a one-shot run). */
  getNativeTitle(rawId: string): string | null {
    const path = this.dbPathFor(this.toRawId(rawId));
    if (!path) return null;
    const db = openSqliteReadonly(path);
    if (!db) return null;
    try {
      const row = db.prepare('SELECT title FROM sessions WHERE id = ?').get(this.toRawId(rawId)) as { title: string | null } | undefined;
      const t = row?.title?.trim();
      return t ? t.slice(0, 200) : null;
    } catch { return null; } finally { db.close(); }
  }

  // ── Generic-engine inputs ───────────────────────────────────────

  readonly fileToolMap: Record<string, EditOp> = {
    write_file: 'write',
    patch:      'edit',
    read_file:  'read',
  };

  /**
   * `write_file` carries `{ path, content }`. `patch` carries
   * `{ mode: 'replace', path, old_string, new_string }`; its other mode,
   * `patch`, is a multi-file V4A patch with no single before and after.
   */
  extractEditDelta(toolName: string, input: unknown): EditDelta | null {
    if (input == null || typeof input !== 'object') return null;
    const inp = input as Record<string, unknown>;
    if (toolName === 'write_file') {
      return { before: '', after: typeof inp.content === 'string' ? inp.content : null };
    }
    if (toolName === 'patch' && (inp.mode === undefined || inp.mode === 'replace')) {
      const before = typeof inp.old_string === 'string' ? inp.old_string : null;
      const after = typeof inp.new_string === 'string' ? inp.new_string : null;
      if (before === null && after === null) return null;
      return { before, after };
    }
    return null;
  }

  readEvents(rawId: string): CanonicalEvent[] {
    const id = this.toRawId(rawId);
    const path = this.dbPathFor(id);
    if (!path) return [];
    const db = openSqliteReadonly(path);
    if (!db) return [];
    try {
      const rows = db.prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE session_id = ? ORDER BY id`,
      ).all(id) as unknown as HermesMessageRow[];
      return messageRowsToEvents(rows);
    } catch { return []; } finally { db.close(); }
  }

  /**
   * Events from the dump `exportRawSession` writes, for a session rebuilt from
   * the server's archive. The archive joins the lines of every dump it got, so
   * a row that changed (a rewind sets `active` to 0) is there more than once.
   * The last copy of each row id is the newest.
   */
  readEventsFromText(text: string): CanonicalEvent[] {
    const rows = new Map<number, HermesMessageRow>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { kind?: string; row?: HermesMessageRow };
        if (rec.kind === 'message' && rec.row) {
          rows.delete(rec.row.id);
          rows.set(rec.row.id, rec.row);
        }
      } catch { /* a torn line */ }
    }
    return messageRowsToEvents([...rows.values()].sort((a, b) => a.id - b.id));
  }

  // ── Per-session operations — all delegate to the generic engine ─

  extractTurns(id: string, opts: ExtractTurnsOpts = {}): ExtractedTurns {
    return extractTurnsFromEvents(this.toPrefixedId(id), this.readEvents(id), opts);
  }

  liveScanEdits(id: string): LiveScanEditsResult {
    const located = this.findSession(id);
    if (!located) {
      return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool: 'hermes' };
    }
    return liveScanEditsFromEvents(this.readEvents(id), this.fileToolMap, {
      sessionId: this.toPrefixedId(id),
      tool: 'hermes',
      projectPath: located.projectPath,
      projectDir: located.projectDir,
      fileMtime: located.mtime,
      found: true,
    });
  }

  replay(id: string): SessionDiffResult {
    const located = this.findSession(id);
    if (!located) {
      return { sessionId: this.toPrefixedId(id), found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };
    }
    return replayFromEvents(this.toPrefixedId(id), this.readEvents(id), this.fileToolMap, this.extractEditDelta.bind(this), {
      projectPath: located.projectPath,
      found: true,
    });
  }

  computeOutcome(id: string, opts?: { commitBufferMinutes?: number }): SessionOutcome {
    return computeOutcome(this.toPrefixedId(id), opts);
  }

  /** File edits since `sinceMs` across the sessions active since then. */
  collectRecentEdits(opts: CollectRecentEditsOpts): SessionEdit[] {
    const refs = this.listSessions({ sinceMs: opts.sinceMs, projectFilter: opts.projectFilter, previews: false });
    const edits: SessionEdit[] = [];
    for (const ref of opts.limitSessions ? refs.slice(0, opts.limitSessions) : refs) {
      for (const e of this.liveScanEdits(ref.rawId).edits) {
        if (e.ts >= opts.sinceMs) edits.push(e);
      }
    }
    return edits.sort((a, b) => b.ts - a.ts);
  }

  getCommits(id: string, files: string[], startMs: number, endMs: number, bufferMinutes?: number): SessionCommitsResult {
    return getSessionCommits(this.toPrefixedId(id), files, startMs, endMs, bufferMinutes);
  }

  /**
   * The session row and its messages as JSONL, one row per line in id order.
   * Hermes rewrites and compacts its database, so the archive keeps the rows
   * as they were synced.
   */
  exportRawSession(id: string): RawSessionExport | null {
    const rawId = this.toRawId(id);
    const path = this.dbPathFor(rawId);
    if (!path) return null;
    const db = openSqliteReadonly(path);
    if (!db) return null;
    try {
      // Only the columns this Hermes version has: the schema grows between
      // releases, and one missing column would fail the whole export.
      const have = new Set((db.prepare(`SELECT name FROM pragma_table_info('sessions')`).all() as Array<{ name: string }>)
        .map((c) => c.name));
      const cols = ARCHIVED_SESSION_COLUMNS.filter((c) => have.has(c)).map((c) => `s.${c}`);
      const session = db.prepare(`
        SELECT ${[...cols, `${SESSION_MTIME_SQL} AS mtime`].join(', ')}
        FROM sessions s WHERE s.id = ?
      `).get(rawId) as Record<string, unknown> | undefined;
      if (!session) return null;
      const rows = db.prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE session_id = ? ORDER BY id`,
      ).all(rawId);
      const lines = [JSON.stringify({ kind: 'session', row: session })];
      for (const r of rows) lines.push(JSON.stringify({ kind: 'message', row: r }));
      return {
        tool: 'hermes',
        mtime: Math.round(Number(session.mtime || 0) * 1000),
        files: [{ name: `${rawId}.dump.jsonl`, bytes: Buffer.from(lines.join('\n') + '\n', 'utf-8') }],
      };
    } catch { return null; } finally { db.close(); }
  }
}

export const hermesBackend = new HermesBackend();

// ── Local helpers ────────────────────────────────────────────────────

/** The first prompt the person typed. A background-process notice is a user
 *  row that Hermes wrote, so it is not one. */
function firstUserPrompt(db: DatabaseSync, sessionId: string): string {
  try {
    const row = db.prepare(`
      SELECT substr(content, 1, 400) AS text FROM messages
      WHERE session_id = ? AND role = 'user' AND active = 1 AND _compressed_summary = 0
        AND (display_kind IS NULL OR display_kind = 'steer')
        AND length(trim(content)) > 0
      ORDER BY id LIMIT 1
    `).get(sessionId) as { text: string | null } | undefined;
    return row?.text ? flatString(row.text.slice(0, 200)) : '';
  } catch {
    return '';   // a preview must never fail a listing
  }
}

/** A tool call in an assistant row's `tool_calls`. */
interface HermesToolCall {
  id?: string;
  call_id?: string;
  function?: { name?: string; arguments?: unknown };
}

/**
 * Hermes message rows → canonical events. `line` is the row's position in the
 * session, from 1.
 *
 * Skipped: rows a rewind made inactive, a turn the provider refused
 * (`failed_turn`), and an assistant row Hermes keeps out of the chat
 * (`hidden`). A `process_complete` user row is the notice Hermes writes when a
 * background process ends, so it carries an origin.
 */
function messageRowsToEvents(rows: HermesMessageRow[]): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  let line = 0;
  for (const r of rows) {
    line++;
    if (r.active === 0) continue;
    if (r.display_kind === 'failed_turn' || r.display_kind === 'hidden') continue;
    const ts = Math.round((r.timestamp || 0) * 1000);
    const tsIso = ts ? new Date(ts).toISOString() : undefined;
    const text = (r.content ?? '').trim();

    if (r._compressed_summary === 1) {
      if (text) events.push({ kind: 'summary', ts, tsIso, line, text });
      continue;
    }
    if (r.role === 'user') {
      if (!text) continue;
      events.push({
        kind: 'user', ts, tsIso, line, text,
        ...(r.display_kind === 'process_complete' ? { origin: 'task-notification' } : {}),
      });
      continue;
    }
    if (r.role === 'assistant') {
      if (text) events.push({ kind: 'assistant_text', ts, tsIso, line, text });
      for (const call of parseToolCalls(r.tool_calls)) {
        const toolName = call.function?.name ?? '';
        const toolInput = parseArguments(call.function?.arguments);
        const command = toolName === 'terminal' && typeof (toolInput as { command?: unknown })?.command === 'string'
          ? (toolInput as { command: string }).command : undefined;
        events.push({
          kind: 'tool_use', ts, tsIso, line,
          toolName, toolUseId: call.id || call.call_id || `${r.id}:${toolName}`,
          toolInput, ...(command ? { command } : {}),
        });
      }
      continue;
    }
    if (r.role === 'tool') {
      const body = r.content ?? '';
      const { exitCode, isError } = toolResultStatus(body);
      events.push({
        kind: 'tool_result', ts, tsIso, line,
        toolUseId: r.tool_call_id ?? undefined,
        toolName: r.tool_name ?? undefined,
        resultBody: body,
        resultIsError: isError,
        ...(exitCode !== undefined ? { resultExitCode: exitCode } : {}),
        resultBytes: Buffer.byteLength(body),
      });
    }
  }
  return events;
}

function parseToolCalls(json: string | null): HermesToolCall[] {
  if (!json) return [];
  try {
    const calls = JSON.parse(json);
    return Array.isArray(calls) ? calls as HermesToolCall[] : [];
  } catch { return []; }
}

/** Arguments are a JSON string in the OpenAI shape; a provider can send an
 *  object, or text that is not JSON. */
function parseArguments(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? {};
  try { return JSON.parse(args); } catch { return { raw: args }; }
}

/** A terminal result is `{"output", "exit_code", "error"}`. Other tools return
 *  free text or their own JSON, which counts as success. */
function toolResultStatus(body: string): { exitCode?: number; isError: boolean } {
  if (!body.startsWith('{')) return { isError: false };
  try {
    const r = JSON.parse(body) as { exit_code?: unknown; error?: unknown };
    const exitCode = typeof r.exit_code === 'number' ? r.exit_code : undefined;
    const hasError = r.error !== undefined && r.error !== null && r.error !== '';
    return { exitCode, isError: hasError || (exitCode !== undefined && exitCode !== 0) };
  } catch { return { isError: false }; }
}
