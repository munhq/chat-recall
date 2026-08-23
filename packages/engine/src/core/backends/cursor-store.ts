/**
 * Cursor Agent CLI store reader — `~/.cursor/chats/<md5(cwd)>/<chatId>/`.
 *
 * Cursor writes every CLI chat TWICE, and the two copies are not equivalent:
 *
 *   1. `store.db`   — a content-addressed blob store. The complete record:
 *                     tool results, error flags, call ids, reasoning, model.
 *   2. `<chatId>.jsonl` under `~/.cursor/projects/<slug(cwd)>/agent-transcripts/`
 *                   — a flattened view that drops every tool RESULT and every
 *                     tool-call id.
 *
 * We read (1) and fall back to (2), because `store.db`'s own metadata carries a
 * `blobEncryptionKey` field. Blobs are plaintext in the builds measured here
 * (CLI 2026.08.11), but a build that starts honouring that key would take the
 * whole tool offline; the JSONL is plain text either way, so a degraded session
 * beats a missing one.
 *
 * ── store.db layout ────────────────────────────────────────────────
 *   CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)   -- keyed by sha256
 *   CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT)
 *
 * `meta` holds ONE row, key '0', whose value is hex-encoded JSON:
 *   { agentId, latestRootBlobId, name, mode, createdAt, blobEncryptionKey }
 *
 * Blob ids are content hashes, so they carry no order. The ordering lives in
 * the blob named by `latestRootBlobId`: a protobuf frame whose repeated field 1
 * is the message list, in order, as 32-byte child hashes. Reading it needs no
 * schema — walk the top-level tags and keep the field-1 entries. Older root
 * snapshots are still in the table (it is a Merkle history), so follow
 * `latestRootBlobId` and never guess by size.
 *
 * Message blobs are plaintext UTF-8 JSON in the Vercel AI SDK shape.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { openSqliteReadonly } from '../sqlite-reader.js';
import type { CanonicalEvent } from '../tool-backend.js';

/** One CLI chat on disk, as described by its `meta.json`. */
export interface CursorChat {
  chatId: string;
  /** `~/.cursor/chats/<md5>/<chatId>` */
  dir: string;
  /** `<dir>/store.db` */
  dbPath: string;
  /** The 32-hex md5(cwd) directory that groups a workspace's chats. */
  workspaceHash: string;
  /** Absolute project cwd, straight from meta.json — no path sniffing needed. */
  projectPath: string;
  createdAtMs: number;
  updatedAtMs: number;
}

interface ChatMeta {
  schemaVersion?: number;
  createdAtMs?: number;
  updatedAtMs?: number;
  hasConversation?: boolean;
  cwd?: string;
}

/**
 * Cursor's project-directory slug, transcribed from the CLI bundle
 * (`utils/dist/workspace-paths.js`). Lossy — every run of non-alphanumerics
 * collapses to one `-` — so it maps cwd → dir and NEVER the reverse.
 */
export function cursorProjectSlug(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

/** Every chat under one `chats/` root, newest first. */
export function listChatsIn(chatsRoot: string): CursorChat[] {
  const out: CursorChat[] = [];
  let hashDirs: string[];
  try {
    hashDirs = readdirSync(chatsRoot);
  } catch {
    return out;
  }

  for (const workspaceHash of hashDirs) {
    const hashPath = join(chatsRoot, workspaceHash);
    let chatIds: string[];
    try {
      if (!statSync(hashPath).isDirectory()) continue;
      chatIds = readdirSync(hashPath);
    } catch {
      continue;
    }

    for (const chatId of chatIds) {
      const dir = join(hashPath, chatId);
      const dbPath = join(dir, 'store.db');
      if (!existsSync(dbPath)) continue;

      let meta: ChatMeta = {};
      try {
        meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8')) as ChatMeta;
      } catch { /* a chat mid-creation has no meta yet — fall back to stat below */ }

      // `hasConversation:false` is a chat that was created and never used
      // (`cursor-agent create-chat`). Indexing it adds an empty session.
      if (meta.hasConversation === false) continue;

      let mtime = meta.updatedAtMs ?? 0;
      let created = meta.createdAtMs ?? 0;
      if (!mtime || !created) {
        try {
          const st = statSync(dbPath);
          mtime = mtime || st.mtimeMs;
          created = created || st.birthtimeMs || st.mtimeMs;
        } catch { continue; }
      }

      out.push({
        chatId,
        dir,
        dbPath,
        workspaceHash,
        projectPath: meta.cwd || '',
        createdAtMs: created,
        updatedAtMs: mtime,
      });
    }
  }

  out.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return out;
}

/** Locate one chat by id across several `chats/` roots, primary first. */
export function findChat(chatsRoots: string[], chatId: string): CursorChat | null {
  for (const root of chatsRoots) {
    let hashDirs: string[];
    try { hashDirs = readdirSync(root); } catch { continue; }
    for (const workspaceHash of hashDirs) {
      const dir = join(root, workspaceHash, chatId);
      const dbPath = join(dir, 'store.db');
      if (!existsSync(dbPath)) continue;

      let meta: ChatMeta = {};
      try {
        meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8')) as ChatMeta;
      } catch { /* keep going — the db is what matters */ }

      let mtime = meta.updatedAtMs ?? 0;
      let created = meta.createdAtMs ?? 0;
      if (!mtime || !created) {
        try {
          const st = statSync(dbPath);
          mtime = mtime || st.mtimeMs;
          created = created || st.birthtimeMs || st.mtimeMs;
        } catch { /* leave zeroed */ }
      }

      return {
        chatId, dir, dbPath, workspaceHash,
        projectPath: meta.cwd || '',
        createdAtMs: created,
        updatedAtMs: mtime,
      };
    }
  }
  return null;
}

// ── protobuf-lite ──────────────────────────────────────────────────

function readVarint(b: Uint8Array, i: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (i < b.length) {
    const byte = b[i++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7;
    // A varint longer than 10 bytes is corrupt, not merely large.
    if (shift > 70) break;
  }
  throw new Error('truncated varint');
}

/**
 * The ordered child hashes in a root blob: every length-delimited field 1 that
 * is exactly 32 bytes.
 *
 * Other top-level fields carry unrelated bookkeeping and are skipped by tag, so
 * a new field in a future build changes nothing here.
 */
function rootBlobRefs(root: Uint8Array): string[] {
  const refs: string[] = [];
  let i = 0;
  while (i < root.length) {
    let tag: number;
    [tag, i] = readVarint(root, i);
    const fieldNo = tag >> 3;
    const wireType = tag & 7;

    if (wireType === 2) {
      let len: number;
      [len, i] = readVarint(root, i);
      if (len < 0 || i + len > root.length) throw new Error('truncated length-delimited field');
      if (fieldNo === 1 && len === 32) refs.push(Buffer.from(root.subarray(i, i + len)).toString('hex'));
      i += len;
    } else if (wireType === 0) {
      [, i] = readVarint(root, i);
    } else if (wireType === 5) {
      i += 4;
    } else if (wireType === 1) {
      i += 8;
    } else {
      // Groups (3/4) and anything unknown — we cannot skip safely, so stop.
      // Refs collected so far are still in order and still usable.
      break;
    }
  }
  return refs;
}

// ── message decoding ───────────────────────────────────────────────

/**
 * Cursor prefixes every user turn with a timestamp and wraps the prompt.
 * Both are injected by the CLI, not typed by the user.
 */
const USER_WRAPPER = /^\s*<timestamp>([^<]*)<\/timestamp>\s*<user_query>([\s\S]*?)<\/user_query>\s*$/;

function unwrapUserText(text: string): { text: string; ts: number | null } {
  const m = text.match(USER_WRAPPER);
  if (!m) return { text, ts: null };
  const parsed = Date.parse(m[1].replace(/\s*\(UTC[^)]*\)\s*$/, '').trim());
  return { text: m[2].trim(), ts: Number.isNaN(parsed) ? null : parsed };
}

/**
 * The first user message is a `<user_info>` block the CLI injects (OS, shell,
 * cwd, workspace layout). It is not a prompt and is 30 KB+ in practice.
 */
function isInjectedUserInfo(text: string): boolean {
  return text.startsWith('<user_info>');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') {
      const t = (c as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('');
}

/** `result` is usually a string, but tools that return structure send an object. */
function resultBodyOf(part: Record<string, unknown>): string {
  const r = part.result;
  if (typeof r === 'string') return r;
  if (r !== undefined && r !== null) {
    try { return JSON.stringify(r); } catch { /* fall through */ }
  }
  const exp = part.experimental_content;
  if (Array.isArray(exp)) {
    return exp
      .filter((e) => e && typeof e === 'object' && (e as { type?: string }).type === 'text')
      .map((e) => String((e as { text?: unknown }).text ?? ''))
      .join('');
  }
  return '';
}

function isErrorOf(msg: Record<string, unknown>): boolean | undefined {
  const po = msg.providerOptions as Record<string, unknown> | undefined;
  const cur = po?.cursor as Record<string, unknown> | undefined;
  const hl = cur?.highLevelToolCallResult as Record<string, unknown> | undefined;
  const v = hl?.isError;
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Turn ordered message blobs into canonical events.
 *
 * Timestamps: Cursor stamps only the user turns, to the minute, inside the
 * prompt wrapper. Everything after a user turn inherits that turn's time, and
 * anything before the first one falls back to `createdAtMs` — which keeps
 * turns monotonic without inventing precision the source does not have.
 */
function messagesToEvents(
  messages: Array<Record<string, unknown>>,
  createdAtMs: number,
  updatedAtMs: number,
): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  let clock = createdAtMs || updatedAtMs || 0;
  let seenUser = false;

  for (const msg of messages) {
    const role = msg.role;

    if (role === 'system') continue;

    if (role === 'user') {
      const raw = textOf(msg.content);
      if (!raw || isInjectedUserInfo(raw)) continue;
      const { text, ts } = unwrapUserText(raw);
      if (ts) clock = ts;
      if (!text) continue;
      seenUser = true;
      events.push({ kind: 'user', ts: clock, line: 0, text });
      continue;
    }

    if (role === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;
        if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
          events.push({ kind: 'assistant_text', ts: clock, line: 0, text: p.text });
        } else if (p.type === 'tool-call') {
          const toolName = typeof p.toolName === 'string' ? p.toolName : '';
          if (!toolName) continue;
          const args = (p.args ?? {}) as Record<string, unknown>;
          events.push({
            kind: 'tool_use',
            ts: clock,
            line: 0,
            toolName,
            toolUseId: typeof p.toolCallId === 'string' ? p.toolCallId : undefined,
            toolInput: args,
            command: toolName === 'Shell' && typeof args.command === 'string' ? args.command : undefined,
          });
        }
      }
      continue;
    }

    if (role === 'tool') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const isError = isErrorOf(msg);
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;
        if (p.type !== 'tool-result') continue;
        const body = resultBodyOf(p);
        events.push({
          kind: 'tool_result',
          ts: clock,
          line: 0,
          toolUseId: typeof p.toolCallId === 'string' ? p.toolCallId : undefined,
          resultBody: body,
          resultIsError: isError,
          resultBytes: Buffer.byteLength(body, 'utf8'),
        });
      }
    }
  }

  // A chat whose only user turn was the injected `<user_info>` block is a
  // no-op run, not a session.
  return seenUser || events.length > 0 ? events : [];
}

/** Ordered message blobs from a `store.db`, or null if it cannot be decoded. */
export function readStoreMessages(dbPath: string): Array<Record<string, unknown>> | null {
  const db = openSqliteReadonly(dbPath);
  if (!db) return null;
  try {
    const metaRow = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as
      { value?: string } | undefined;
    if (!metaRow?.value) return null;

    let rootId: string;
    try {
      const decoded = JSON.parse(Buffer.from(metaRow.value, 'hex').toString('utf8')) as
        { latestRootBlobId?: string };
      if (!decoded.latestRootBlobId) return null;
      rootId = decoded.latestRootBlobId;
    } catch {
      return null;
    }

    const getBlob = db.prepare('SELECT data FROM blobs WHERE id = ?');
    const rootRow = getBlob.get(rootId) as { data?: Uint8Array } | undefined;
    if (!rootRow?.data) return null;

    let refs: string[];
    try {
      refs = rootBlobRefs(rootRow.data);
    } catch {
      return null;
    }
    if (refs.length === 0) return null;

    const messages: Array<Record<string, unknown>> = [];
    for (const ref of refs) {
      const row = getBlob.get(ref) as { data?: Uint8Array } | undefined;
      if (!row?.data) continue;
      // Non-JSON blobs are file bodies and protobuf frames referenced from the
      // same list; they are not messages. This is also the encryption tripwire:
      // if EVERY blob fails to parse we return null and the JSONL takes over.
      const buf = Buffer.from(row.data);
      if (buf[0] !== 0x7b /* { */) continue;
      try {
        messages.push(JSON.parse(buf.toString('utf8')) as Record<string, unknown>);
      } catch { /* not a message blob */ }
    }
    return messages.length > 0 ? messages : null;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** Canonical events for one chat, via `store.db`. Empty when undecodable. */
export function readStoreEvents(chat: CursorChat): CanonicalEvent[] {
  const messages = readStoreMessages(chat.dbPath);
  if (!messages) return [];
  return messagesToEvents(messages, chat.createdAtMs, chat.updatedAtMs);
}

// ── JSONL fallback ─────────────────────────────────────────────────

/**
 * Path of the flattened transcript for a chat.
 *
 * The slug is lossy, so two different cwds can land in one directory. The
 * chatId subdirectory disambiguates, which is why we join by chatId rather
 * than trusting the slug alone.
 */
export function transcriptPath(cursorHome: string, projectPath: string, chatId: string): string | null {
  if (!projectPath) return null;
  const p = join(
    cursorHome, 'projects', cursorProjectSlug(projectPath),
    'agent-transcripts', chatId, `${chatId}.jsonl`,
  );
  return existsSync(p) ? p : null;
}

/**
 * Parse the flattened transcript.
 *
 * Measured limits, all of them consequences of how the CLI writes this file:
 *   - No tool RESULTS at all, so no `resultIsError` and no replay verification.
 *   - No tool-call ids, so we synthesise sequential ones; results would have
 *     nothing to pair with anyway.
 *   - Thinking is often the literal string `[REDACTED]`.
 *   - The file is REWRITTEN on every resume, not appended. That is why the
 *     backend never advertises `isAppendOnly`.
 */
export function readTranscriptEvents(rawText: string, mtimeFallback = 0): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  let lineNum = 0;
  let clock = mtimeFallback;
  let counter = 0;

  for (const line of rawText.split('\n')) {
    lineNum++;
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    // `{"type":"turn_ended","status":"success"|"error"|"aborted"}` — carries no
    // message, so it produces no event; outcome reads it separately.
    if (!obj.role) continue;

    const message = obj.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message!.content : [];

    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;

      if (p.type === 'text' && typeof p.text === 'string') {
        if (obj.role === 'user') {
          const { text, ts } = unwrapUserText(p.text);
          if (ts) clock = ts;
          if (text) events.push({ kind: 'user', ts: clock, line: lineNum, text });
        } else if (p.text.trim()) {
          events.push({ kind: 'assistant_text', ts: clock, line: lineNum, text: p.text });
        }
      } else if (p.type === 'tool_use' && typeof p.name === 'string') {
        const input = (p.input ?? {}) as Record<string, unknown>;
        events.push({
          kind: 'tool_use',
          ts: clock,
          line: lineNum,
          toolName: p.name,
          toolUseId: `cursor_jsonl_${++counter}`,
          toolInput: input,
          command: p.name === 'Shell' && typeof input.command === 'string' ? input.command : undefined,
        });
      }
    }
  }

  return events;
}

/** The last `turn_ended` status in a transcript, if the file has one. */
export function readTranscriptStatus(rawText: string): string | null {
  let status: string | null = null;
  for (const line of rawText.split('\n')) {
    if (!line.includes('"turn_ended"')) continue;
    try {
      const obj = JSON.parse(line) as { type?: string; status?: string };
      if (obj.type === 'turn_ended' && typeof obj.status === 'string') status = obj.status;
    } catch { /* skip */ }
  }
  return status;
}
