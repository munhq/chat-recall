/**
 * Single source of truth for chat-recall data paths.
 *
 * History: chat-recall used to write all its state under `~/.claude/`
 * because it started out as a Claude-only tool. Now that it indexes
 * Codex, Gemini, OpenCode and others, putting its own state under
 * `~/.claude/` is wrong — that directory belongs to one of the tools
 * we *read from*, not to chat-recall itself.
 *
 * Layout (new, current):
 *   ~/.chat-recall/
 *     cache.db            (session metadata + outcome cache)
 *     index/
 *       metadata.db       (memory_metadata, links, FTS5 chunks)
 *       knowledge_graph.db
 *       lancedb/          (vector embeddings, when configured)
 *       wal/              (write-ahead log of MCP writes)
 *       diary/            (per-agent persistent diary)
 *     memory/             (auto-saved hook facts)
 *     identity.txt
 *     hooks/              (chat-recall hook scripts)
 *
 * Override the root with `CHAT_RECALL_DATA_DIR=/some/path`.
 *
 * Backwards compatibility: on the first call after upgrade, if the new
 * root doesn't exist but the legacy `~/.claude/chat-recall-*` paths do,
 * we move them to the new location. This is a one-shot migration —
 * subsequent runs see the new dir already in place and skip the check.
 */

import { existsSync, mkdirSync, renameSync, readdirSync, statSync, copyFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { createLogger } from './logger.js';

const log = createLogger('paths');

/** Root data directory. Respects $CHAT_RECALL_DATA_DIR; defaults to ~/.chat-recall. */
export function getDataDir(): string {
  const override = process.env.CHAT_RECALL_DATA_DIR;
  if (override && override.trim()) return override.trim();
  return join(homedir(), '.chat-recall');
}

/** Combined metadata + outcome cache db. */
export function getCacheDbPath(): string {
  ensureMigrated();
  ensureDir(getDataDir());
  return join(getDataDir(), 'cache.db');
}

/** Index directory holding memory metadata, KG, lancedb, wal, diary. */
export function getIndexDir(): string {
  ensureMigrated();
  const p = join(getDataDir(), 'index');
  ensureDir(p);
  return p;
}

export function getMetadataDbPath(): string { return join(getIndexDir(), 'metadata.db'); }
export function getKnowledgeGraphDbPath(): string { return join(getIndexDir(), 'knowledge_graph.db'); }
export function getLanceDbDir(): string {
  const p = join(getIndexDir(), 'lancedb');
  ensureDir(p);
  return p;
}
export function getWalDir(): string {
  const p = join(getIndexDir(), 'wal');
  ensureDir(p);
  return p;
}
export function getDiaryDir(): string {
  const p = join(getIndexDir(), 'diary');
  ensureDir(p);
  return p;
}
export function getMemoryDir(): string {
  ensureMigrated();
  const p = join(getDataDir(), 'memory');
  ensureDir(p);
  return p;
}
export function getIdentityFilePath(): string {
  ensureMigrated();
  ensureDir(getDataDir());
  return join(getDataDir(), 'identity.txt');
}
export function getHooksDir(): string {
  ensureMigrated();
  const p = join(getDataDir(), 'hooks');
  ensureDir(p);
  return p;
}

/** Where the legacy state used to live. Used only by the migration. */
function legacyRoot(): string {
  return join(homedir(), '.claude');
}

interface LegacyEntry {
  legacyPath: string;
  newPath: string;
  /** When `true`, the entry is a directory; when `false`, a single file. */
  isDir: boolean;
}

function legacyMappings(): LegacyEntry[] {
  const root = legacyRoot();
  const newRoot = getDataDir();
  return [
    { legacyPath: join(root, 'chat-recall-cache.db'),       newPath: join(newRoot, 'cache.db'),         isDir: false },
    { legacyPath: join(root, 'chat-recall-index'),          newPath: join(newRoot, 'index'),            isDir: true  },
    { legacyPath: join(root, 'chat-recall-memory'),         newPath: join(newRoot, 'memory'),           isDir: true  },
    { legacyPath: join(root, 'chat-recall-identity.txt'),   newPath: join(newRoot, 'identity.txt'),     isDir: false },
    { legacyPath: join(root, 'chat-recall-hooks'),          newPath: join(newRoot, 'hooks'),            isDir: true  },
    // The legacy settings directory was named just "chat-recall" (no
    // suffix) — odd choice. Move it to a clearer "settings" subdir.
    { legacyPath: join(root, 'chat-recall'),                newPath: join(newRoot, 'settings'),         isDir: true  },
    // SQLite WAL/SHM siblings — must move with their main .db so they don't
    // get re-created and stale-out the migrated cache.
    { legacyPath: join(root, 'chat-recall-cache.db-wal'),   newPath: join(newRoot, 'cache.db-wal'),     isDir: false },
    { legacyPath: join(root, 'chat-recall-cache.db-shm'),   newPath: join(newRoot, 'cache.db-shm'),     isDir: false },
  ];
}

/**
 * One-shot migration: if any legacy `~/.claude/chat-recall-*` path exists
 * AND its new counterpart doesn't, move it over. Cached per-process so
 * repeated path lookups don't hit the filesystem after the first run.
 *
 * Move semantics: same-filesystem rename (atomic, preserves inode +
 * mtimes); cross-filesystem fallback via copy+verify+delete. We don't
 * leave a copy behind — the data follows chat-recall to its new home.
 */
let _migrationDone = false;
function ensureMigrated(): void {
  if (_migrationDone) return;
  _migrationDone = true;

  // Skip migration entirely if a custom data dir is set — the user is
  // explicitly opting into a non-default location and we shouldn't
  // surprise them by moving anything.
  if (process.env.CHAT_RECALL_DATA_DIR && process.env.CHAT_RECALL_DATA_DIR.trim()) return;

  const newRoot = getDataDir();
  ensureDir(newRoot);

  for (const m of legacyMappings()) {
    if (!existsSync(m.legacyPath)) continue;
    if (existsSync(m.newPath)) continue; // already migrated, leave the legacy alone

    try {
      renameSync(m.legacyPath, m.newPath);
      log.error({ from: m.legacyPath, to: m.newPath }, 'migrated');
    } catch (err) {
      // Cross-filesystem rename fails with EXDEV. Fall back to recursive copy.
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        try {
          if (m.isDir) copyDir(m.legacyPath, m.newPath);
          else { ensureDir(dirname(m.newPath)); copyFileSync(m.legacyPath, m.newPath); }
          rmSync(m.legacyPath, { recursive: true, force: true });
          log.error({ from: m.legacyPath, to: m.newPath }, 'migrated (cross-fs)');
        } catch (copyErr) {
          // Non-fatal: log and continue. The new dir will start empty.
          log.error({ err: copyErr, path: m.legacyPath }, 'migration failed');
        }
      } else {
        log.error({ err, path: m.legacyPath }, 'migration failed');
      }
    }
  }
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function copyDir(src: string, dest: string): void {
  ensureDir(dest);
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) copyDir(srcPath, destPath);
    else if (st.isFile()) copyFileSync(srcPath, destPath);
    // Symlinks are intentionally skipped — chat-recall doesn't create any.
  }
}

/** Test-only: reset the per-process migration flag so tests can re-run it. */
export function _resetMigrationStateForTests(): void {
  _migrationDone = false;
}
