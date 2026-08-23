/**
 * Cursor IDE (desktop) reader — `~/.config/Cursor/User/`.
 *
 * Note the capital C. `~/.config/cursor` (lowercase) is the CLI's auth
 * directory and holds no chats. Both exist on Linux.
 *
 * ── Layout, verified against a live Cursor 3.17.8 install ──────────
 *   User/globalStorage/state.vscdb                   <- content lives here
 *   User/workspaceStorage/<workspaceId>/state.vscdb  <- per-workspace state
 *   User/workspaceStorage/<workspaceId>/workspace.json
 *
 * Both databases carry the same three tables:
 *   CREATE TABLE ItemTable      (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)
 *   CREATE TABLE cursorDiskKV   (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)
 *   CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY, workspaceId TEXT,
 *                                createdAt INTEGER, lastUpdatedAt INTEGER,
 *                                isArchived INTEGER, isSubagent INTEGER,
 *                                recency INTEGER, checkpointAt INTEGER, value TEXT)
 *
 * ── Four schema eras, all still in the wild ────────────────────────
 * Cursor has moved this data three times, and an install upgraded in place
 * keeps the older rows. So the index is resolved in precedence order:
 *
 *   1. `composerHeaders` TABLE          — current (seen on 3.15.6+)
 *   2. ItemTable `composer.composerHeaders` in the GLOBAL db  — Cursor 3.0
 *   3. ItemTable `composer.composerData` in each WORKSPACE db — ~0.45 to 2.x
 *   4. ItemTable `workbench.panel.aichat.view.aichat.chatdata`
 *      and `workbench.panel.chat.view.chat.chatdata`          — pre-0.45
 *
 * Eras 1 to 3 all store message CONTENT the same way: `composerData:<id>` and
 * `bubbleId:<composerId>:<bubbleId>` rows in the global `cursorDiskKV`. Only
 * the index moved. Era 4 is self-contained and shares no code path — its
 * bubble `type` is the STRING 'user'/'ai', where a composer bubble's `type` is
 * the NUMBER 1/2.
 *
 * ── Two safety rules, both learned from user-reported data loss ────
 * 1. Never open these read-write. Cursor keeps a live WAL while it runs, and
 *    the forums carry cases of histories destroyed by outside writers.
 * 2. Bound every read. One reported `state.vscdb` reached 30 GB of `bubbleId`
 *    and `agentKv` rows; an unbounded scan is an OOM.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openSqliteReadonly } from '../sqlite-reader.js';
import type { CanonicalEvent } from '../tool-backend.js';

/** Hard ceiling on bubbles read for one conversation. */
const MAX_BUBBLES = 5000;
/** Hard ceiling on conversations enumerated from one database. */
const MAX_COMPOSERS = 20_000;

/** One IDE conversation, located but not yet read. */
export interface CursorIdeComposer {
  composerId: string;
  /** Absolute path of the global `state.vscdb` holding this conversation. */
  globalDbPath: string;
  /** `workspaceStorage` directory name, when the index records one. */
  workspaceId: string;
  projectPath: string;
  createdAtMs: number;
  updatedAtMs: number;
  name: string;
  isSubagent: boolean;
}

function jsonOf(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  try {
    const text = typeof value === 'string'
      ? value
      : Buffer.from(value as Uint8Array).toString('utf8');
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  try {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
    return !!row;
  } catch {
    return false;
  }
}

// ── project attribution ────────────────────────────────────────────

/** `file:///a/b` and `vscode-remote://ssh-remote%2Bhost/a/b` → `/a/b`. */
function pathFromUri(uri: string): string {
  if (!uri) return '';
  if (uri.startsWith('file://')) {
    try { return decodeURIComponent(uri.slice('file://'.length)) || ''; } catch { return ''; }
  }
  if (uri.startsWith('vscode-remote://')) {
    const rest = uri.slice('vscode-remote://'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return '';
    try { return decodeURIComponent(rest.slice(slash)); } catch { return ''; }
  }
  return uri.startsWith('/') ? uri : '';
}

/**
 * Project folder for a workspaceStorage directory.
 *
 * `workspace` comes before `folder`: a multi-root workspace records the
 * `.code-workspace` file under `workspace`, and only single-folder windows
 * write `folder`.
 *
 * The directory name is NOT a hash of the path — VSCode generates it — so
 * `workspace.json` is the only way back. (The CLI store is the opposite: there
 * the directory name IS md5(cwd).)
 */
export function projectPathForWorkspace(workspaceDir: string): string {
  const meta = jsonOf(safeRead(join(workspaceDir, 'workspace.json')));
  if (!meta) return '';
  const uri = (typeof meta.workspace === 'string' && meta.workspace)
    || (typeof meta.folder === 'string' && meta.folder)
    || '';
  return pathFromUri(uri);
}

function safeRead(path: string): string | null {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

/** workspaceId → project path, for every workspaceStorage root given. */
function workspaceIndex(workspaceRoots: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const root of workspaceRoots) {
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }
    for (const id of entries) {
      const dir = join(root, id);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      const p = projectPathForWorkspace(dir);
      if (p && !map.has(id)) map.set(id, p);
    }
  }
  return map;
}

/** The project path a header row stamps on itself, if any. */
function projectFromHeaderValue(value: Record<string, unknown> | null): { id: string; path: string } {
  if (!value) return { id: '', path: '' };
  const wi = value.workspaceIdentifier as Record<string, unknown> | undefined;
  const uri = wi?.uri as Record<string, unknown> | undefined;
  const fsPath = typeof uri?.fsPath === 'string' ? uri.fsPath : '';
  const uriPath = typeof uri?.path === 'string' ? uri.path : '';
  const external = typeof uri?.external === 'string' ? pathFromUri(uri.external) : '';
  const flat = typeof value.workspaceUri === 'string' ? pathFromUri(value.workspaceUri) : '';
  return {
    id: typeof wi?.id === 'string' ? wi.id : '',
    path: fsPath || uriPath || external || flat || '',
  };
}

// ── conversation index ─────────────────────────────────────────────

/**
 * Every conversation recorded in one global database.
 *
 * Eras are merged by composerId, most authoritative first, so an install that
 * upgraded in place lists each conversation once.
 */
export function listComposers(globalDbPath: string, workspaceRoots: string[]): CursorIdeComposer[] {
  const db = openSqliteReadonly(globalDbPath);
  if (!db) return [];

  const byId = new Map<string, CursorIdeComposer>();
  const wsIndex = workspaceIndex(workspaceRoots);

  const record = (
    composerId: string,
    workspaceId: string,
    projectPath: string,
    createdAtMs: number,
    updatedAtMs: number,
    name: string,
    isSubagent: boolean,
  ) => {
    if (!composerId || byId.has(composerId)) return;
    if (byId.size >= MAX_COMPOSERS) return;
    byId.set(composerId, {
      composerId,
      globalDbPath,
      workspaceId,
      projectPath: projectPath || (workspaceId ? wsIndex.get(workspaceId) || '' : ''),
      createdAtMs,
      updatedAtMs: updatedAtMs || createdAtMs,
      name,
      isSubagent,
    });
  };

  try {
    // Era 1 — the dedicated table.
    if (tableExists(db, 'composerHeaders')) {
      try {
        const rows = db.prepare(
          'SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isSubagent, value ' +
          'FROM composerHeaders LIMIT ?',
        ).all(MAX_COMPOSERS) as Array<Record<string, unknown>>;
        for (const r of rows) {
          const value = jsonOf(r.value);
          const stamped = projectFromHeaderValue(value);
          record(
            String(r.composerId ?? ''),
            String(r.workspaceId ?? '') || stamped.id,
            stamped.path,
            Number(r.createdAt ?? 0),
            Number(r.lastUpdatedAt ?? 0),
            typeof value?.name === 'string' ? value.name : '',
            Number(r.isSubagent ?? 0) === 1,
          );
        }
      } catch { /* table present but unreadable — later eras still apply */ }
    }

    // Era 2 — the global ItemTable index.
    const headersRow = db.prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get('composer.composerHeaders') as { value?: unknown } | undefined;
    const headers = headersRow?.value ? jsonOf(headersRow.value) : null;
    const headerList = Array.isArray(headers) ? headers as unknown[] : asArray(headersRow?.value);
    for (const h of headerList) {
      if (!h || typeof h !== 'object') continue;
      const v = h as Record<string, unknown>;
      const stamped = projectFromHeaderValue(v);
      record(
        typeof v.composerId === 'string' ? v.composerId : '',
        stamped.id,
        stamped.path,
        Number(v.createdAt ?? 0),
        Number(v.lastUpdatedAt ?? 0),
        typeof v.name === 'string' ? v.name : '',
        v.isSubagent === true,
      );
    }
  } catch { /* fall through to the workspace era */ }
  finally {
    try { db.close(); } catch { /* already closed */ }
  }

  // Era 3 — each workspace's own index. Only reached for conversations the
  // newer indexes do not already list.
  for (const root of workspaceRoots) {
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }
    for (const workspaceId of entries) {
      const wsDb = join(root, workspaceId, 'state.vscdb');
      if (!existsSync(wsDb)) continue;
      const projectPath = wsIndex.get(workspaceId) || '';
      const w = openSqliteReadonly(wsDb);
      if (!w) continue;
      try {
        const row = w.prepare('SELECT value FROM ItemTable WHERE key = ?')
          .get('composer.composerData') as { value?: unknown } | undefined;
        const data = jsonOf(row?.value);
        const all = Array.isArray(data?.allComposers) ? data!.allComposers as unknown[] : [];
        for (const c of all) {
          if (!c || typeof c !== 'object') continue;
          const v = c as Record<string, unknown>;
          record(
            typeof v.composerId === 'string' ? v.composerId : '',
            workspaceId,
            projectPath,
            Number(v.createdAt ?? 0),
            Number(v.lastUpdatedAt ?? 0),
            typeof v.name === 'string' ? v.name : '',
            v.isSubagent === true,
          );
        }
      } catch { /* skip this workspace */ }
      finally {
        try { w.close(); } catch { /* already closed */ }
      }
    }
  }

  const out = [...byId.values()];
  out.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return out;
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  try {
    const text = typeof value === 'string' ? value : Buffer.from(value as Uint8Array).toString('utf8');
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Locate one conversation by id across every global database. */
export function findComposer(
  globalDbPaths: string[],
  workspaceRoots: string[],
  composerId: string,
): CursorIdeComposer | null {
  for (const dbPath of globalDbPaths) {
    const db = openSqliteReadonly(dbPath);
    if (!db) continue;
    let present = false;
    try {
      const row = db.prepare('SELECT 1 FROM cursorDiskKV WHERE key = ?')
        .get(`composerData:${composerId}`);
      present = !!row;
    } catch { /* table missing */ }
    finally {
      try { db.close(); } catch { /* already closed */ }
    }
    if (!present) continue;
    const found = listComposers(dbPath, workspaceRoots).find((c) => c.composerId === composerId);
    if (found) return found;
    // Content exists but no index row — a conversation orphaned by a migration.
    return {
      composerId, globalDbPath: dbPath, workspaceId: '', projectPath: '',
      createdAtMs: 0, updatedAtMs: 0, name: '', isSubagent: false,
    };
  }
  return null;
}

// ── bubbles → canonical events ─────────────────────────────────────

interface ToolFormerData {
  name?: string;
  params?: string;
  rawArgs?: string;
  result?: string;
  status?: string;
  toolCallId?: string;
  additionalData?: { status?: string; userDecision?: string };
}

/** `params` and `rawArgs` are JSON encoded INSIDE the JSON. Parse twice. */
function toolArgs(t: ToolFormerData): Record<string, unknown> {
  for (const raw of [t.params, t.rawArgs]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch { /* try the next one */ }
  }
  return {};
}

/**
 * Normalise the tool's file argument onto `file_path`.
 *
 * The generic engine's `extractFilePaths` reads only `paths`, `file_path`,
 * `absolute_path`, `path` and `filePath`. Cursor's IDE tools use six other
 * spellings, so without this rewrite every IDE edit is invisible — the same
 * trap the Antigravity backend hit.
 */
const FILE_ARG_KEYS = [
  'target_file', 'targetFile', 'relative_workspace_path', 'relativeWorkspacePath',
  'file', 'filePath', 'file_path', 'path', 'target_directory', 'targetDirectory',
];

function normaliseArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  if (typeof out.file_path !== 'string' && !Array.isArray(out.paths)) {
    for (const k of FILE_ARG_KEYS) {
      const v = out[k];
      if (typeof v === 'string' && v) { out.file_path = v; break; }
    }
  }
  return out;
}

function toolFailed(t: ToolFormerData): boolean {
  const status = t.additionalData?.status ?? t.status;
  return status === 'error';
}

/** Assistant prose for a bubble: its own text, then any code blocks it emitted. */
function assistantText(b: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
  const blocks = Array.isArray(b.codeBlocks) ? b.codeBlocks : [];
  for (const cb of blocks) {
    if (!cb || typeof cb !== 'object') continue;
    const c = cb as Record<string, unknown>;
    if (typeof c.content === 'string' && c.content.trim()) {
      const lang = typeof c.languageId === 'string' ? c.languageId : '';
      parts.push('```' + lang + '\n' + c.content + '\n```');
    }
  }
  return parts.join('\n\n');
}

/**
 * Canonical events for one IDE conversation.
 *
 * Order comes from `fullConversationHeadersOnly`, never from rowid — the
 * bubble rows are a key/value table with no insertion order. Headers that have
 * no bubble row are skipped; Cursor prunes bubbles independently of headers.
 */
export function readComposerEvents(composer: CursorIdeComposer): CanonicalEvent[] {
  const db = openSqliteReadonly(composer.globalDbPath);
  if (!db) return [];

  try {
    const dataRow = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      .get(`composerData:${composer.composerId}`) as { value?: unknown } | undefined;
    const data = jsonOf(dataRow?.value);
    if (!data) return [];

    const headers = Array.isArray(data.fullConversationHeadersOnly)
      ? data.fullConversationHeadersOnly as Array<Record<string, unknown>>
      : [];

    // Era 2 kept content inline in conversationMap; era 3 empties it.
    const inline = (data.conversationMap && typeof data.conversationMap === 'object')
      ? data.conversationMap as Record<string, unknown>
      : {};

    const getBubble = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
    const events: CanonicalEvent[] = [];
    let clock = composer.createdAtMs || composer.updatedAtMs || 0;
    let count = 0;

    for (const h of headers) {
      if (count++ >= MAX_BUBBLES) break;
      const bubbleId = typeof h?.bubbleId === 'string' ? h.bubbleId : '';
      if (!bubbleId) continue;

      let bubble = inline[bubbleId] as Record<string, unknown> | undefined;
      if (!bubble) {
        const row = getBubble.get(`bubbleId:${composer.composerId}:${bubbleId}`) as
          { value?: unknown } | undefined;
        bubble = jsonOf(row?.value) ?? undefined;
      }
      if (!bubble) continue;

      const ts = Number(bubble.createdAt ?? 0);
      if (ts > 0) clock = ts;

      // 1 = user, 2 = assistant. Header type wins; the bubble repeats it.
      const type = Number(bubble.type ?? h.type ?? 0);

      if (type === 1) {
        const text = typeof bubble.text === 'string' && bubble.text.trim()
          ? bubble.text
          : (typeof bubble.rawText === 'string' ? bubble.rawText : '');
        if (text.trim()) events.push({ kind: 'user', ts: clock, line: 0, text });
        continue;
      }

      const thinking = bubble.thinking as Record<string, unknown> | undefined;
      if (typeof thinking?.text === 'string' && thinking.text.trim()) {
        events.push({ kind: 'assistant_text', ts: clock, line: 0, text: thinking.text });
      }

      const prose = assistantText(bubble);
      if (prose.trim()) events.push({ kind: 'assistant_text', ts: clock, line: 0, text: prose });

      const tfd = bubble.toolFormerData as ToolFormerData | undefined;
      if (tfd && typeof tfd === 'object' && typeof tfd.name === 'string' && tfd.name) {
        const callId = tfd.toolCallId || `cursor_ide_${composer.composerId}_${bubbleId}`;
        const args = normaliseArgs(toolArgs(tfd));
        events.push({
          kind: 'tool_use',
          ts: clock,
          line: 0,
          toolName: tfd.name,
          toolUseId: callId,
          toolInput: args,
          command: typeof args.command === 'string' ? args.command : undefined,
        });
        if (typeof tfd.result === 'string' && tfd.result) {
          events.push({
            kind: 'tool_result',
            ts: clock,
            line: 0,
            toolUseId: callId,
            resultBody: tfd.result,
            resultIsError: toolFailed(tfd),
            resultBytes: Buffer.byteLength(tfd.result, 'utf8'),
          });
        }
      }
    }

    return events;
  } catch {
    return [];
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** First user prompt and message count, without decoding the whole thread. */
export function composerPreview(composer: CursorIdeComposer): { firstPrompt: string; messageCount: number } {
  const db = openSqliteReadonly(composer.globalDbPath);
  if (!db) return { firstPrompt: '', messageCount: 0 };
  try {
    const dataRow = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      .get(`composerData:${composer.composerId}`) as { value?: unknown } | undefined;
    const data = jsonOf(dataRow?.value);
    if (!data) return { firstPrompt: '', messageCount: 0 };

    const headers = Array.isArray(data.fullConversationHeadersOnly)
      ? data.fullConversationHeadersOnly as Array<Record<string, unknown>>
      : [];

    const getBubble = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
    let firstPrompt = '';
    for (const h of headers.slice(0, 50)) {
      const bubbleId = typeof h?.bubbleId === 'string' ? h.bubbleId : '';
      if (!bubbleId) continue;
      const row = getBubble.get(`bubbleId:${composer.composerId}:${bubbleId}`) as
        { value?: unknown } | undefined;
      const bubble = jsonOf(row?.value);
      if (!bubble || Number(bubble.type ?? 0) !== 1) continue;
      const text = typeof bubble.text === 'string' ? bubble.text : '';
      if (text.trim()) { firstPrompt = text.trim().slice(0, 200); break; }
    }
    return { firstPrompt, messageCount: headers.length };
  } catch {
    return { firstPrompt: '', messageCount: 0 };
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** Directory of a global db, for callers that need the sibling workspace root. */
export function workspaceRootFor(globalDbPath: string): string {
  return join(dirname(dirname(globalDbPath)), 'workspaceStorage');
}

