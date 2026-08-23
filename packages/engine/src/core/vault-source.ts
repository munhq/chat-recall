/**
 * Vault source — discovers chat session files to back up.
 *
 * Walks each installed AI tool's chat storage on the local device,
 * yielding `(sessionId, tool, path, mtime, projectPath?)` records. The
 * Vault client uses these as inputs to the encrypt-and-upload pipeline.
 *
 * Tier-A tools (per the design discussion) — chats live as one
 * append-only or write-once file per session:
 *   • Claude Code:  ~/.claude/projects/<encoded>/<uuid>.jsonl
 *   • Gemini CLI:   ~/.gemini/tmp/<sha256>/chats/session-*.{json,jsonl}
 *   • Codex CLI:    ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Tier-C tools (single SQLite) — exported via the SQLite online-backup
 * API to a snapshot, then SELECT'd into JSONL per session. This module
 * scaffolds the source contract; the SQLite extractor is a separate
 * follow-up. Tier-A covers ~95% of users by usage volume.
 *
 * No network. No encryption. Pure local discovery.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { extname, join } from 'path';
import { claudeBackend } from './backends/claude.js';
import { geminiBackend } from './backends/gemini.js';
import { codexBackend } from './backends/codex.js';
import { agyBackend } from './backends/agy.js';
import { cursorBackend } from './backends/cursor.js';
import { listChatsIn, transcriptPath } from './backends/cursor-store.js';
import { cursorChatDirs, cursorHomeDir } from './tool-paths.js';
import { loadSettings } from './settings.js';
import { decodeProjectDirName } from './project-dir-name.js';

export type VaultTool = 'claude' | 'gemini' | 'codex' | 'opencode' | 'cursor' | 'agy';

export interface VaultSourceFile {
  /** chat-recall-style session id: bare `<uuid>` for claude, `<tool>_<id>` for
   *  gemini / codex / opencode / agy / cursor. */
  sessionId: string;
  tool: VaultTool;
  /** Absolute path to the source file. */
  path: string;
  /** ms epoch — used to skip unchanged files on resync. */
  mtimeMs: number;
  /** File size in bytes (pre-encryption). */
  sizeBytes: number;
  /** Project path the session belongs to, when discoverable. */
  projectPath?: string;
}

/** Yields every chat file the local user has across enabled, supported tools. */
export function* walkVaultSources(): Generator<VaultSourceFile> {
  const t = loadSettings().team.vault;
  const include = new Set<VaultTool>(t.syncTools);

  if (include.has('claude')   && claudeBackend.isAvailable()) yield* walkClaude();
  if (include.has('gemini')   && geminiBackend.isAvailable()) yield* walkGemini();
  if (include.has('codex')    && codexBackend.isAvailable())  yield* walkCodex();
  if (include.has('agy')      && agyBackend.isAvailable())    yield* walkAgy();
  if (include.has('cursor')   && cursorBackend.isAvailable()) yield* walkCursor();
  // opencode is tier C — its sessions are ROWS in one shared SQLite file with
  // no per-session file to back up, so it needs a module that snapshots the DB
  // via the online backup API and synthesizes JSONL per session.
  // if (include.has('opencode') && opencodeBackend.isAvailable()) yield* walkOpenCode();
}

function safeStat(path: string): { mtimeMs: number; size: number } | null {
  try {
    const s = statSync(path);
    if (!s.isFile()) return null;
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch { return null; }
}

function* walkClaude(): Generator<VaultSourceFile> {
  const root = claudeBackend.projectsDir();
  if (!existsSync(root)) return;
  let projectDirs: string[] = [];
  try { projectDirs = readdirSync(root); } catch { return; }

  for (const proj of projectDirs) {
    if (proj.startsWith('.')) continue;
    // Claude encodes the project path into the dir name as `-home-user-...`.
    const projectPath = decodeProjectDirName(proj);
    const projDir = join(root, proj);
    let entries: string[] = [];
    try { entries = readdirSync(projDir); } catch { continue; }
    for (const f of entries) {
      if (extname(f) !== '.jsonl') continue;
      const path = join(projDir, f);
      const s = safeStat(path);
      if (!s) continue;
      const sessionId = f.replace(/\.jsonl$/, '');
      yield { sessionId, tool: 'claude', path, mtimeMs: s.mtimeMs, sizeBytes: s.size, projectPath };
    }
  }
}

function* walkGemini(): Generator<VaultSourceFile> {
  const tmp = geminiBackend.tmpDir();
  if (!existsSync(tmp)) return;
  let hashDirs: string[] = [];
  try { hashDirs = readdirSync(tmp); } catch { return; }

  for (const hash of hashDirs) {
    const chatsDir = join(tmp, hash, 'chats');
    if (!existsSync(chatsDir)) continue;
    let entries: string[] = [];
    try { entries = readdirSync(chatsDir); } catch { continue; }
    for (const f of entries) {
      const ext = extname(f);
      if (ext !== '.json' && ext !== '.jsonl') continue;
      const path = join(chatsDir, f);
      const s = safeStat(path);
      if (!s) continue;
      // Gemini session ids in chat-recall use a `gemini_` prefix.
      const base = f.replace(/^session-/, '').replace(/\.(jsonl?)$/, '');
      yield { sessionId: `gemini_${base}`, tool: 'gemini', path, mtimeMs: s.mtimeMs, sizeBytes: s.size };
    }
  }
}

/**
 * Cursor CLI chats.
 *
 * Cursor was originally filed alongside OpenCode as "SQLite, needs a snapshot
 * module". That was wrong: the CLI also writes a plain-JSONL transcript per
 * chat, so the vault can back up a real file today. The JSONL drops tool
 * results, but a vault entry is a restorable copy of the conversation, not the
 * indexing path — the backend still reads `store.db` for that.
 */
function* walkCursor(): Generator<VaultSourceFile> {
  for (const chatsRoot of cursorChatDirs()) {
    for (const chat of listChatsIn(chatsRoot)) {
      const path = transcriptPath(cursorHomeDir(), chat.projectPath, chat.chatId);
      if (!path) continue;
      const s = safeStat(path);
      if (!s) continue;
      yield {
        sessionId: `cursor_${chat.chatId}`,
        tool: 'cursor',
        path,
        mtimeMs: s.mtimeMs,
        sizeBytes: s.size,
        projectPath: chat.projectPath || undefined,
      };
    }
  }
}

function* walkCodex(): Generator<VaultSourceFile> {
  const sessionsRoot = join(codexBackend.homeDir(), 'sessions');
  if (!existsSync(sessionsRoot)) return;
  // Recurse YYYY/MM/DD/rollout-*.jsonl
  const stack: string[] = [sessionsRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import('fs').Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) { stack.push(path); continue; }
      if (extname(e.name) !== '.jsonl') continue;
      const s = safeStat(path);
      if (!s) continue;
      const base = e.name.replace(/\.jsonl$/, '');
      yield { sessionId: `codex_${base}`, tool: 'codex', path, mtimeMs: s.mtimeMs, sizeBytes: s.size };
    }
  }
}

function* walkAgy(): Generator<VaultSourceFile> {
  const brainDir = join(agyBackend.homeDir(), 'brain');
  if (!existsSync(brainDir)) return;
  let sessionDirs: string[] = [];
  try { sessionDirs = readdirSync(brainDir); } catch { return; }

  for (const rawId of sessionDirs) {
    const sessionPath = join(brainDir, rawId);
    try {
      if (!statSync(sessionPath).isDirectory()) continue;
    } catch {
      continue;
    }

    let filePath = join(sessionPath, '.system_generated', 'logs', 'transcript.jsonl');
    if (!existsSync(filePath)) {
      filePath = join(sessionPath, '.system_generated', 'logs', 'transcript_full.jsonl');
    }
    if (!existsSync(filePath)) continue;

    const s = safeStat(filePath);
    if (!s) continue;

    const sessionId = `agy_${rawId}`;
    yield { sessionId, tool: 'agy', path: filePath, mtimeMs: s.mtimeMs, sizeBytes: s.size };
  }
}
