/**
 * OpenCode backend. Owns ~/.local/share/opencode/opencode.db
 * (overridable via CHAT_RECALL_OPENCODE_DB).
 *
 * OpenCode stores everything in SQLite — sessions in `session`, messages in
 * `message`, parts (text + tool calls) in `part`. There is no per-session
 * file on disk, so SessionLocation.path points at the DB and every backend
 * read goes through queries scoped by session_id.
 *
 * IDs are prefixed: 'opencode_<session-id>'.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { opencodeDbPath } from '../tool-paths.js';

const require = createRequire(import.meta.url);

// Lazy + optional: OpenCode keeps its sessions in its own SQLite DB, so
// reading them needs better-sqlite3. The thin collector ships without it by
// default (optionalDependency); load on first use and degrade gracefully
// (skip OpenCode) if it isn't installed, instead of crashing on boot.
//
// better-sqlite3 uses `export =` (CommonJS), so the module value is the
// constructor itself — `typeof import(...)` is that callable type. The
// instance type is the nested `.Database` interface.
type BetterSqlite3Ctor = typeof import('better-sqlite3');
type BetterSqlite3Db = import('better-sqlite3').Database;
let _Database: BetterSqlite3Ctor | null | undefined;
function loadBetterSqlite3(): BetterSqlite3Ctor | null {
  // `undefined` = never tried; `null` = tried and absent. Cache both so the
  // require() (and its potential failure) happens at most once per process.
  if (_Database === undefined) {
    try { _Database = require('better-sqlite3') as BetterSqlite3Ctor; }
    catch {
      _Database = null;
      process.stderr.write(
        '[chat-recall] better-sqlite3 not installed — OpenCode sessions will be skipped.\n',
      );
    }
  }
  return _Database;
}

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

const PREFIX = 'opencode_';

export class OpencodeBackend implements ToolBackend {
  readonly id = 'opencode' as const;
  readonly idPrefix = PREFIX;
  readonly displayName = 'OpenCode';

  /**
   * Path to the SQLite db. Env override is the *full path*, not a directory,
   * so users can point at a fixture without juggling subpath conventions.
   */
  dbPath(): string { return opencodeDbPath(); }

  homeDir(): string {
    // The "home" is the directory that contains the db, plus its sibling
    // assets (plans/, etc.).
    return dirname(this.dbPath());
  }

  // ── Subpath helpers ────────────────────────────────────────────
  plansDir(): string { return join(this.homeDir(), 'plans'); }
  /**
   * Canonical OpenCode skills location. OpenCode also reads skills from
   * `~/.opencode/skill[s]/` for backwards compat — both are surfaced by
   * `SkillsSource` — but config-dir is the conventional install target
   * for "promote skill to OpenCode" actions.
   */
  skillsDir(): string {
    return join(process.env.HOME || homedir(), '.config', 'opencode', 'skill');
  }

  // Available only when both the DB exists AND better-sqlite3 can be loaded —
  // without the driver we cannot read it, so OpenCode is effectively absent.
  isAvailable(): boolean { return existsSync(this.dbPath()) && loadBetterSqlite3() !== null; }

  // ── ID handling ────────────────────────────────────────────────
  matchesId(id: string): boolean { return id.startsWith(PREFIX); }
  toRawId(id: string): string { return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id; }
  toPrefixedId(rawId: string): string { return rawId.startsWith(PREFIX) ? rawId : PREFIX + rawId; }

  // ── Location ───────────────────────────────────────────────────
  findSession(id: string): SessionLocation | null {
    if (!this.isAvailable()) return null;
    const rawId = this.toRawId(id);
    const db = openReadonly(this.dbPath());
    if (!db) return null;
    try {
      const row = db.prepare(`
        SELECT s.id, s.directory, s.time_updated, p.worktree as project_path
        FROM session s LEFT JOIN project p ON s.project_id = p.id
        WHERE s.id = ?
      `).get(rawId) as { directory: string | null; time_updated: number; project_path: string | null } | undefined;
      if (!row) return null;
      return {
        path: this.dbPath(),
        format: 'sqlite',
        projectDir: '',
        projectPath: row.project_path || row.directory || '',
        mtime: row.time_updated || 0,
      };
    } finally { db.close(); }
  }

  listSessions(opts: ListSessionsOpts = {}): SessionRef[] {
    if (!this.isAvailable()) return [];
    const cutoff = opts.sinceMs ?? 0;
    const filter = opts.projectFilter?.toLowerCase();
    const db = openReadonly(this.dbPath());
    if (!db) return [];

    try {
      const rows = db.prepare(`
        SELECT s.id, s.directory, s.time_created, s.time_updated,
               p.worktree as project_path
        FROM session s
        LEFT JOIN project p ON s.project_id = p.id
        WHERE s.time_updated >= ?
        ORDER BY s.time_updated DESC
      `).all(cutoff) as Array<{
        id: string;
        directory: string | null;
        time_created: number;
        time_updated: number;
        project_path: string | null;
      }>;

      const out: SessionRef[] = [];
      for (const row of rows) {
        const projectPath = row.project_path || row.directory || '';
        if (filter && !projectPath.toLowerCase().includes(filter)) continue;

        // First user prompt — cheap subquery
        const firstUser = db.prepare(`
          SELECT p.data
          FROM part p JOIN message m ON m.id = p.message_id
          WHERE p.session_id = ?
            AND p.data LIKE '%"type":"text"%'
            AND m.data LIKE '%"role":"user"%'
          ORDER BY p.time_created ASC LIMIT 1
        `).get(row.id) as { data: string } | undefined;
        let firstPrompt = '';
        if (firstUser) {
          try {
            const parsed = JSON.parse(firstUser.data);
            firstPrompt = String(parsed?.text || '').slice(0, 200);
          } catch { /* ignore */ }
        }

        const messageCount = (db.prepare('SELECT COUNT(*) as c FROM message WHERE session_id = ?').get(row.id) as { c: number } | undefined)?.c ?? 0;

        const created = new Date(row.time_created || row.time_updated).toISOString();
        const modified = new Date(row.time_updated).toISOString();
        out.push({
          toolId: 'opencode',
          rawId: row.id,
          prefixedId: this.toPrefixedId(row.id),
          projectPath,
          projectDir: '',
          fullPath: this.dbPath(),
          created,
          modified,
          mtime: row.time_updated,
          firstPrompt,
          messageCount,
        });

        if (opts.limit && out.length >= opts.limit) break;
      }
      return out;
    } finally { db.close(); }
  }

  // ── Generic-engine inputs ───────────────────────────────────────

  readonly fileToolMap: Record<string, EditOp> = {
    edit:  'edit',
    write: 'write',
    read:  'read',
  };

  /**
   * OpenCode's edit/write parts carry the diff inline:
   *   - edit:  { state.input: { filePath, oldString, newString } }
   *   - write: { state.input: { filePath, content } }
   *
   * Note: readEvents already extracts state.input as toolInput, so the
   * input shape here matches exactly.
   */
  extractEditDelta(toolName: string, input: unknown): EditDelta | null {
    if (input == null || typeof input !== 'object') return null;
    const inp = input as Record<string, unknown>;
    if (toolName === 'edit') {
      const before = typeof inp.oldString === 'string' ? inp.oldString
                  : typeof inp.old_string === 'string' ? inp.old_string : null;
      const after  = typeof inp.newString === 'string' ? inp.newString
                  : typeof inp.new_string === 'string' ? inp.new_string : null;
      if (before === null && after === null) return null;
      return { before, after };
    }
    if (toolName === 'write') {
      const after = typeof inp.content === 'string' ? inp.content : null;
      return { before: '', after };
    }
    return null;
  }

  /**
   * Read every part for the session and emit canonical events. OpenCode
   * stores parts in SQLite — `data` is JSON with `{type:'text'|'tool', ...}`,
   * and the `message.role` lives in a sibling table.
   */
  readEvents(rawId: string): CanonicalEvent[] {
    if (!this.isAvailable()) return [];
    const ocId = this.toRawId(rawId);
    const db = openReadonly(this.dbPath());
    if (!db) return [];

    try {
      const sessRow = db.prepare('SELECT id FROM session WHERE id = ?').get(ocId);
      if (!sessRow) return [];

      const parts = db.prepare(`
        SELECT p.id, p.message_id, p.time_created, p.data, m.data AS msg_data
        FROM part p JOIN message m ON m.id = p.message_id
        WHERE p.session_id = ? ORDER BY p.time_created ASC
      `).all(ocId) as Array<{
        id: string; message_id: string; time_created: number; data: string; msg_data: string;
      }>;

      const events: CanonicalEvent[] = [];
      let lineNum = 0;

      for (const p of parts) {
        lineNum++;
        const ts = p.time_created;
        const tsIso = ts ? new Date(ts).toISOString() : undefined;
        let d: any; try { d = JSON.parse(p.data); } catch { continue; }
        let role = '';
        try { role = String(JSON.parse(p.msg_data || '{}').role || ''); } catch { /* leave blank */ }

        if (d?.type === 'text') {
          const text = String(d.text || '').trim();
          if (!text) continue;
          events.push({
            kind: role === 'user' ? 'user' : 'assistant_text',
            ts, tsIso, line: lineNum, text,
          });
        } else if (d?.type === 'tool') {
          const toolName = String(d.tool || '');
          const callId = String(d.callID || d.id || p.id);
          const input = d?.state?.input || {};
          const command = toolName === 'bash' && typeof input.command === 'string'
            ? (input.command as string) : undefined;
          events.push({
            kind: 'tool_use', ts, tsIso, line: lineNum,
            toolName, toolUseId: callId, toolInput: input, command,
          });
          const out = d?.state?.output;
          if (out !== undefined && out !== null) {
            const body = typeof out === 'string' ? out : JSON.stringify(out);
            events.push({
              kind: 'tool_result', ts, tsIso, line: lineNum,
              toolUseId: callId, toolName, resultBody: body,
              resultIsError: d?.state?.status === 'error',
              resultBytes: body.length,
            });
          }
        }
      }
      return events;
    } finally { db.close(); }
  }

  // ── Per-session operations — all delegate to the generic engine ─

  extractTurns(id: string, opts: ExtractTurnsOpts = {}): ExtractedTurns {
    const events = this.readEvents(this.toRawId(id));
    return extractTurnsFromEvents(this.toPrefixedId(id), events, opts);
  }

  liveScanEdits(id: string): LiveScanEditsResult {
    const located = this.findSession(this.toRawId(id));
    if (!located) {
      return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool: 'opencode' };
    }
    const events = this.readEvents(this.toRawId(id));
    return liveScanEditsFromEvents(events, this.fileToolMap, {
      sessionId: this.toPrefixedId(id),
      tool: 'opencode',
      projectPath: located.projectPath,
      projectDir: located.projectDir,
      fileMtime: located.mtime,
      found: true,
    });
  }

  replay(id: string): SessionDiffResult {
    const located = this.findSession(this.toRawId(id));
    if (!located) {
      return { sessionId: this.toPrefixedId(id), found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 };
    }
    const events = this.readEvents(this.toRawId(id));
    return replayFromEvents(this.toPrefixedId(id), events, this.fileToolMap, this.extractEditDelta.bind(this), {
      projectPath: located.projectPath,
      found: true,
    });
  }

  computeOutcome(id: string, opts?: { commitBufferMinutes?: number }): SessionOutcome {
    return computeOutcome(this.toPrefixedId(id), opts);
  }

  /**
   * Native fast-path for `computeOutcome` — OpenCode stores
   * `summary_files` / `summary_additions` / `summary_deletions` directly
   * on the session row. Reading those + a SELECT DISTINCT for file paths
   * is far cheaper than replaying every part. Returns null when the row
   * is missing or the totals are zero (in which case the composer falls
   * through to the generic replay).
   */
  preComputedOutcomeStats(id: string): { filesChanged: string[]; totalLinesAdded: number; totalLinesRemoved: number } | null {
    if (!this.isAvailable()) return null;
    const ocId = this.toRawId(id);
    const db = openReadonly(this.dbPath());
    if (!db) return null;
    try {
      const row = db.prepare(`
        SELECT summary_additions, summary_deletions
        FROM session WHERE id = ?
      `).get(ocId) as { summary_additions: number | null; summary_deletions: number | null } | undefined;
      if (!row) return null;
      const totalAdd = row.summary_additions || 0;
      const totalRem = row.summary_deletions || 0;
      // Pull the list of file paths touched by tool parts in this session.
      const fileRows = db.prepare(`
        SELECT DISTINCT data
        FROM part
        WHERE session_id = ?
          AND data LIKE '%"type":"tool"%'
          AND (data LIKE '%"tool":"edit"%' OR data LIKE '%"tool":"write"%')
      `).all(ocId) as Array<{ data: string }>;
      const files = new Set<string>();
      for (const r of fileRows) {
        try {
          const d = JSON.parse(r.data);
          const file = d?.state?.input?.filePath || d?.state?.input?.file_path || d?.state?.input?.path;
          if (typeof file === 'string' && file.trim()) files.add(file);
        } catch { /* skip */ }
      }
      return { filesChanged: [...files], totalLinesAdded: totalAdd, totalLinesRemoved: totalRem };
    } finally { db.close(); }
  }

  /**
   * Batched recent-edits collector — single SQL across all parts since
   * `sinceMs`, no per-session loop. Materially faster than calling
   * `liveScanEdits` per session for activity-timeline-style queries.
   */
  collectRecentEdits(opts: CollectRecentEditsOpts): SessionEdit[] {
    if (!this.isAvailable()) return [];
    const db = openReadonly(this.dbPath());
    if (!db) return [];

    try {
      const rows = db.prepare(`
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
      `).all(opts.sinceMs) as Array<{
        session_id: string;
        time_created: number;
        data: string;
        directory: string | null;
        project_path: string | null;
      }>;

      const edits: SessionEdit[] = [];
      for (const r of rows) {
        const projectPath = r.project_path || r.directory || '';
        if (opts.projectFilter && !projectPath.toLowerCase().includes(opts.projectFilter.toLowerCase())) continue;

        let d: any;
        try { d = JSON.parse(r.data); } catch { continue; }
        const name = d?.tool as string;
        if (!name || !(name in this.fileToolMap)) continue;
        const inp = d?.state?.input || {};
        const file = inp.filePath || inp.file_path || inp.path;
        if (typeof file !== 'string' || !file.trim()) continue;

        edits.push({
          ts: r.time_created,
          tsIso: new Date(r.time_created).toISOString(),
          sessionId: this.toPrefixedId(r.session_id),
          projectPath,
          file,
          op: this.fileToolMap[name],
          toolName: name,
          tool: 'opencode',
          line: 0,
        });
      }
      return edits;
    } finally { db.close(); }
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
  exportRawSession(id: string): RawSessionExport | null {
    // DB-based tool: a deterministic JSONL dump of this session's rows —
    // one line per row, stable ordering — so the archive is independent of
    // OpenCode's mutable SQLite file (vacuum/compaction/deletion).
    const dbPath = this.dbPath();
    if (!existsSync(dbPath)) return null;
    const DB = loadBetterSqlite3();
    if (!DB) return null;
    const realId = this.toRawId(id);
    const db = new DB(dbPath, { readonly: true });
    try {
      const session = db.prepare(`SELECT * FROM session WHERE id = ?`).get(realId);
      if (!session) return null;
      const rows = db.prepare(`
        SELECT m.id AS message_id, m.data AS message_data, p.id AS part_id, p.data AS part_data, p.time_created
        FROM part p JOIN message m ON p.message_id = m.id
        WHERE p.session_id = ?
        ORDER BY p.time_created ASC, p.id ASC
      `).all(realId);
      const lines: string[] = [JSON.stringify({ kind: 'session', row: session })];
      for (const r of rows) lines.push(JSON.stringify({ kind: 'part', row: r }));
      const mtime = (session as any).time_updated || (session as any).time_created || Date.now();
      return {
        tool: 'opencode',
        mtime: Number(mtime),
        files: [{ name: `${realId}.dump.jsonl`, bytes: Buffer.from(lines.join('\n') + '\n', 'utf-8') }],
      };
    } catch { return null; } finally { db.close(); }
  }
}

export const opencodeBackend = new OpencodeBackend();

// ── Local helpers ────────────────────────────────────────────────────

function openReadonly(path: string): BetterSqlite3Db | null {
  const DB = loadBetterSqlite3();
  if (!DB) return null;
  try { return new DB(path, { readonly: true, fileMustExist: true }); }
  catch { return null; }
}
