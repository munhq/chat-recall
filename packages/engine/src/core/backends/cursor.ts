/**
 * Cursor backend. Covers BOTH Cursor surfaces under one tool id:
 *
 *   - the `cursor-agent` CLI  → ~/.cursor/chats/<md5(cwd)>/<chatId>/store.db
 *     (overridable via CHAT_RECALL_CURSOR_HOME)
 *   - the Cursor IDE          → ~/.config/Cursor/User/globalStorage/state.vscdb
 *     (overridable via CHAT_RECALL_CURSOR_IDE_HOME)
 *
 * They are the same product to the user, so they are one source in the sidebar
 * and one `AiTool`. Both emit `cursor_<uuid>` ids: the CLI's `agentId` and the
 * IDE's `composerId` are both UUIDs, so a single namespace is safe.
 *
 * Reading is delegated — `cursor-store.ts` for the CLI, `cursor-ide.ts` for the
 * IDE — because the two formats share nothing but the vendor. Each of those
 * files documents its own layout.
 *
 * NOT append-only. The CLI REWRITES its transcript on every resume (measured:
 * a 5-line file became a 9-line file, with the original terminator gone), and
 * the IDE keeps its data in SQLite. So `isAppendOnly` / `fileSize` /
 * `readFromOffset` are deliberately absent and sync always ships FULL.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { basename, join } from 'path';
import {
  cursorHomeDir,
  cursorChatDirs,
  cursorIdeGlobalDbs,
  cursorIdeWorkspaceDirs,
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

import {
  type CursorChat,
  findChat,
  listChatsIn,
  readStoreEvents,
  readStoreMessages,
  readTranscriptEvents,
  transcriptPath,
} from './cursor-store.js';

import {
  type CursorIdeComposer,
  composerPreview,
  findComposer,
  listComposers,
  readComposerEvents,
} from './cursor-ide.js';

const PREFIX = 'cursor_';

/** Where a resolved id lives — the two surfaces need different readers. */
type Resolved =
  | { surface: 'cli'; chat: CursorChat }
  | { surface: 'ide'; composer: CursorIdeComposer };

export class CursorBackend implements ToolBackend {
  readonly id = 'cursor' as const;
  readonly idPrefix = PREFIX;
  readonly displayName = 'Cursor';

  homeDir(): string { return cursorHomeDir(); }

  isAvailable(): boolean {
    return cursorChatDirs().length > 0 || cursorIdeGlobalDbs().length > 0;
  }

  // ── ID handling ────────────────────────────────────────────────
  matchesId(id: string): boolean { return id.startsWith(PREFIX); }
  toRawId(id: string): string { return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id; }
  toPrefixedId(rawId: string): string { return rawId.startsWith(PREFIX) ? rawId : PREFIX + rawId; }

  // ── Location ───────────────────────────────────────────────────

  /** CLI first: it is the cheaper lookup and the more common surface. */
  private resolve(id: string): Resolved | null {
    const rawId = this.toRawId(id);

    const chat = findChat(cursorChatDirs(), rawId);
    if (chat) return { surface: 'cli', chat };

    const composer = findComposer(cursorIdeGlobalDbs(), cursorIdeWorkspaceDirs(), rawId);
    if (composer) return { surface: 'ide', composer };

    return null;
  }

  findSession(id: string): SessionLocation | null {
    const r = this.resolve(id);
    if (!r) return null;

    if (r.surface === 'cli') {
      let mtime = r.chat.updatedAtMs;
      try { mtime = statSync(r.chat.dbPath).mtimeMs || mtime; } catch { /* keep meta's */ }
      return {
        path: r.chat.dbPath,
        format: 'sqlite',
        projectDir: r.chat.workspaceHash,
        projectPath: r.chat.projectPath,
        mtime,
      };
    }

    let mtime = r.composer.updatedAtMs;
    try { mtime = statSync(r.composer.globalDbPath).mtimeMs || mtime; } catch { /* keep index's */ }
    return {
      path: r.composer.globalDbPath,
      format: 'sqlite',
      projectDir: r.composer.workspaceId,
      projectPath: r.composer.projectPath,
      mtime,
    };
  }

  listSessions(opts: ListSessionsOpts = {}): SessionRef[] {
    const cutoff = opts.sinceMs ?? 0;
    const filter = opts.projectFilter?.toLowerCase();
    const out: SessionRef[] = [];
    const seen = new Set<string>();

    const keep = (projectPath: string, mtime: number): boolean => {
      if (mtime < cutoff) return false;
      if (filter && !projectPath.toLowerCase().includes(filter)) return false;
      return true;
    };

    // ── CLI chats ──
    for (const chatsRoot of cursorChatDirs()) {
      for (const chat of listChatsIn(chatsRoot)) {
        if (seen.has(chat.chatId)) continue;
        if (!keep(chat.projectPath, chat.updatedAtMs)) continue;

        const preview = this.cliPreview(chat);
        // A chat with no user turn is an empty shell, not a session.
        if (preview.messageCount === 0) continue;
        seen.add(chat.chatId);

        out.push({
          toolId: 'cursor',
          rawId: chat.chatId,
          prefixedId: this.toPrefixedId(chat.chatId),
          projectPath: chat.projectPath,
          projectDir: chat.workspaceHash,
          fullPath: chat.dbPath,
          created: new Date(chat.createdAtMs).toISOString(),
          modified: new Date(chat.updatedAtMs).toISOString(),
          mtime: chat.updatedAtMs,
          firstPrompt: preview.firstPrompt,
          messageCount: preview.messageCount,
        });
      }
    }

    // ── IDE composers ──
    const wsRoots = cursorIdeWorkspaceDirs();
    for (const dbPath of cursorIdeGlobalDbs()) {
      for (const composer of listComposers(dbPath, wsRoots)) {
        if (seen.has(composer.composerId)) continue;
        // Sub-agent threads are rolled into their parent's transcript already.
        if (composer.isSubagent) continue;
        if (!keep(composer.projectPath, composer.updatedAtMs)) continue;

        const preview = composerPreview(composer);
        if (preview.messageCount === 0) continue;
        seen.add(composer.composerId);

        out.push({
          toolId: 'cursor',
          rawId: composer.composerId,
          prefixedId: this.toPrefixedId(composer.composerId),
          projectPath: composer.projectPath,
          projectDir: composer.workspaceId,
          fullPath: composer.globalDbPath,
          created: new Date(composer.createdAtMs).toISOString(),
          modified: new Date(composer.updatedAtMs).toISOString(),
          mtime: composer.updatedAtMs,
          firstPrompt: flatString(preview.firstPrompt),
          messageCount: preview.messageCount,
        });
      }
    }

    out.sort((a, b) => b.mtime - a.mtime);
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  /** First prompt + turn count for a CLI chat, from whichever source decodes. */
  private cliPreview(chat: CursorChat): { firstPrompt: string; messageCount: number } {
    const events = this.cliEvents(chat);
    let firstPrompt = '';
    for (const e of events) {
      if (e.kind === 'user' && e.text) { firstPrompt = flatString(e.text.slice(0, 200)); break; }
    }
    return { firstPrompt, messageCount: events.length };
  }

  // ── Generic-engine inputs ───────────────────────────────────────

  /**
   * Both surfaces' file-touching tools in one map.
   *
   * CLI (`Read` / `StrReplace` / `Write`) and IDE (`read_file_v2`,
   * `edit_file_v2`, `search_replace`, …) use different taxonomies, and the map
   * is keyed by raw tool name, so they coexist without collision.
   */
  readonly fileToolMap: Record<string, EditOp> = {
    // cursor-agent CLI
    Read: 'read',
    StrReplace: 'edit',
    Write: 'write',
    // Cursor IDE
    read_file: 'read',
    read_file_v2: 'read',
    edit_file: 'edit',
    edit_file_v2: 'edit',
    search_replace: 'edit',
    apply_patch: 'edit',
    write: 'write',
    create_file: 'write',
    delete_file: 'write',
  };

  /**
   * Inline before/after for the tools that carry both.
   *
   * CLI:  StrReplace {path, old_string, new_string}; Write {path, contents}
   *       — note `contents`, not `content`.
   * IDE:  search_replace {old_string, new_string}; write {contents|file_text}
   */
  extractEditDelta(toolName: string, input: unknown): EditDelta | null {
    if (input == null || typeof input !== 'object') return null;
    const inp = input as Record<string, unknown>;
    const str = (k: string): string | null => (typeof inp[k] === 'string' ? inp[k] as string : null);

    if (toolName === 'StrReplace' || toolName === 'search_replace' || toolName === 'edit_file_v2') {
      const before = str('old_string') ?? str('oldString') ?? str('old_str');
      const after = str('new_string') ?? str('newString') ?? str('new_str');
      if (before === null && after === null) return null;
      return { before, after };
    }

    if (toolName === 'Write' || toolName === 'write' || toolName === 'create_file') {
      const after = str('contents') ?? str('content') ?? str('file_text');
      if (after === null) return null;
      return { before: '', after };
    }

    return null;
  }

  /**
   * Canonical events for a CLI chat: `store.db`, else the flattened JSONL.
   *
   * The fallback exists because `store.db`'s metadata carries a
   * `blobEncryptionKey`. Blobs are plaintext today; if a build starts using
   * that key, `readStoreEvents` yields nothing and the JSONL keeps the tool
   * working, minus tool results.
   */
  private cliEvents(chat: CursorChat): CanonicalEvent[] {
    const fromStore = readStoreEvents(chat);
    if (fromStore.length > 0) return fromStore;

    const jsonl = transcriptPath(cursorHomeDir(), chat.projectPath, chat.chatId);
    if (!jsonl) return [];
    try {
      return readTranscriptEvents(readFileSync(jsonl, 'utf-8'), chat.updatedAtMs);
    } catch {
      return [];
    }
  }

  readEvents(rawId: string): CanonicalEvent[] {
    const r = this.resolve(rawId);
    if (!r) return [];
    return r.surface === 'cli' ? this.cliEvents(r.chat) : readComposerEvents(r.composer);
  }

  // ── Per-session operations — all delegate to the generic engine ─

  extractTurns(id: string, opts: ExtractTurnsOpts = {}): ExtractedTurns {
    const events = this.readEvents(this.toRawId(id));
    return extractTurnsFromEvents(this.toPrefixedId(id), events, opts);
  }

  liveScanEdits(id: string): LiveScanEditsResult {
    const located = this.findSession(this.toRawId(id));
    if (!located) {
      return { found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool: 'cursor' };
    }
    const events = this.readEvents(this.toRawId(id));
    return liveScanEditsFromEvents(events, this.fileToolMap, {
      sessionId: this.toPrefixedId(id),
      tool: 'cursor',
      projectPath: located.projectPath,
      projectDir: located.projectDir,
      fileMtime: located.mtime,
      found: true,
    });
  }

  replay(id: string): SessionDiffResult {
    const located = this.findSession(this.toRawId(id));
    if (!located) {
      return {
        sessionId: this.toPrefixedId(id), found: false, projectPath: '',
        files: [], totalLinesAdded: 0, totalLinesRemoved: 0,
      };
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
    const refs = this.listSessions({
      sinceMs: opts.sinceMs,
      projectFilter: opts.projectFilter,
      limit: opts.limitSessions,
    });

    const edits: SessionEdit[] = [];
    for (const ref of refs) {
      const scan = this.liveScanEdits(ref.rawId);
      if (scan.found) edits.push(...scan.edits);
    }
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
   * A deterministic JSONL rendering of the conversation, not the raw database.
   *
   * Both surfaces keep many chats in one file — the IDE's global db holds every
   * conversation on the machine — so shipping the `.db` would export other
   * people's sessions along with this one. OpenCode set this precedent.
   */
  exportRawSession(id: string): RawSessionExport | null {
    const r = this.resolve(id);
    if (!r) return null;

    try {
      if (r.surface === 'cli') {
        const messages = readStoreMessages(r.chat.dbPath);
        const lines = messages
          ? messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
          : this.transcriptText(r.chat);
        if (!lines) return null;
        const files = [{ name: `${r.chat.chatId}.jsonl`, bytes: Buffer.from(lines, 'utf8') }];
        const metaPath = join(r.chat.dir, 'meta.json');
        if (existsSync(metaPath)) {
          files.push({ name: 'meta.json', bytes: readFileSync(metaPath) });
        }
        return { tool: 'cursor', mtime: statSync(r.chat.dbPath).mtimeMs, files };
      }

      const events = readComposerEvents(r.composer);
      if (events.length === 0) return null;
      const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      return {
        tool: 'cursor',
        mtime: statSync(r.composer.globalDbPath).mtimeMs,
        files: [{ name: `${r.composer.composerId}.jsonl`, bytes: Buffer.from(body, 'utf8') }],
      };
    } catch {
      return null;
    }
  }

  private transcriptText(chat: CursorChat): string {
    const p = transcriptPath(cursorHomeDir(), chat.projectPath, chat.chatId);
    if (!p) return '';
    try { return readFileSync(p, 'utf-8'); } catch { return ''; }
  }
}

export const cursorBackend = new CursorBackend();

