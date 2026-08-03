/**
 * Default storage roots per AI tool, with env-var + settings overrides.
 *
 * Resolution order (highest priority first):
 *   1. process.env.CHAT_RECALL_<TOOL>_HOME           (CI/devops escape hatch)
 *   2. loadSettings().sources.<tool>Home            (user UI / settings.json)
 *   3. Built-in default                              (~/.claude, ~/.gemini, …)
 *
 * The env pass is read on every call so a mid-process override still
 * works. Settings are cached and invalidated by `settings.json` mtime
 * inside `loadSourceSettings` — cheap stat() per resolver call (no JSON
 * parse on cache hit). The cache is shared with source plugins so
 * `discover()` and path resolution see consistent values.
 */

import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname, basename } from 'path';
import { loadSourceSettings, _resetSourceSettingsCache } from './settings.js';

// Re-export so existing test imports from this module keep working.
export { _resetSourceSettingsCache };

const sources = loadSourceSettings;

/** Claude Code root (`~/.claude` by default). */
export function claudeHomeDir(): string {
  return process.env.CHAT_RECALL_CLAUDE_HOME
    || sources().claudeHome
    || join(homedir(), '.claude');
}

/**
 * Every Claude `projects/` dir to scan — config-driven, NOT hardcoded:
 *   1. the resolved claude home (env CHAT_RECALL_CLAUDE_HOME / settings / default)
 *   2. all sibling `~/.claude-*` profiles (e.g. `.claude-work`), except
 *      `.claude-code` — ONLY when no explicit home override is set: an
 *      override (env/settings) pins the scan set, which is what tests, CI
 *      and isolated setups rely on. Add profiles back via CLAUDE_DIRS.
 *   3. anything in CLAUDE_DIRS (comma-separated; leading `~/` expanded)
 * De-duped, existing dirs only. Shared by getAllSessions (index), the Claude
 * backend's listSessions (sync) and findSessionFile (lookup) so all three see
 * the same set — index, sync, and read stay consistent across profiles.
 */
export function claudeProjectDirs(opts: { includeExcluded?: boolean } = {}): string[] {
  const home = homedir();
  const dirs: string[] = [];
  const addHome = (d: string) => {
    const p = join(d, 'projects');
    if (existsSync(p) && !dirs.includes(p)) dirs.push(p);
  };
  addHome(claudeHomeDir());
  const homeOverridden = !!(process.env.CHAT_RECALL_CLAUDE_HOME || sources().claudeHome);
  if (!homeOverridden) {
    try {
      for (const entry of readdirSync(home, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('.claude-') && entry.name !== '.claude-code') {
          addHome(join(home, entry.name));
        }
      }
    } catch { /* home unreadable */ }
  }
  if (process.env.CLAUDE_DIRS) {
    for (const d of process.env.CLAUDE_DIRS.split(',')) {
      const t = d.trim();
      if (t) addHome(t.startsWith('~/') ? join(home, t.slice(2)) : t);
    }
  }
  if (dirs.length === 0) dirs.push(join(claudeHomeDir(), 'projects'));
  // Tenant-configured source exclusions (dashboard → sync client → here). The
  // server can only switch OFF a source this machine already discovered; it can
  // never name a new path. Lazy require-free import: source-discovery imports
  // this module, so the dependency is inverted through a late binding to avoid
  // a cycle at module-init time.
  if (!opts.includeExcluded && _sourceExclusionFilter) {
    const kept = dirs.filter((d) => !_sourceExclusionFilter!(d));
    // Never let configuration leave the collector with nothing to scan — an
    // empty result would look identical to "this machine has no sessions".
    if (kept.length > 0) return kept;
  }
  return dirs;
}

/** Late-bound predicate installed by source-discovery.ts, which imports this
 *  module — binding it here instead of importing keeps the cycle from forming. */
let _sourceExclusionFilter: ((projectsDir: string) => boolean) | null = null;
export function _setSourceExclusionFilter(fn: ((projectsDir: string) => boolean) | null): void {
  _sourceExclusionFilter = fn;
}

/** Gemini CLI root (`~/.gemini` by default). */
export function geminiHomeDir(): string {
  return process.env.CHAT_RECALL_GEMINI_HOME
    || sources().geminiHome
    || join(homedir(), '.gemini');
}

/** OpenCode SQLite database (`~/.local/share/opencode/opencode.db` by default). */
export function opencodeDbPath(): string {
  return process.env.CHAT_RECALL_OPENCODE_DB
    || sources().opencodeDbPath
    || join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/** Codex root (`~/.codex` by default). */
export function codexHomeDir(): string {
  return process.env.CHAT_RECALL_CODEX_HOME
    || sources().codexHome
    || join(homedir(), '.codex');
}

/** Antigravity CLI root (`~/.gemini/antigravity-cli` by default). */
export function agyHomeDir(): string {
  return process.env.CHAT_RECALL_AGY_HOME
    || sources().agyHome
    || join(homedir(), '.gemini', 'antigravity-cli');
}

/**
 * Sibling homes for a tool: `<base>` plus every `<base>-*` next to it.
 *
 * Multi-profile users get one dir per account (`~/.claude-work`, `~/.gemini-t2`),
 * and a tool resumed under a different config dir writes a DISJOINT half of the
 * same session there. Reading only the primary silently drops it — see
 * live-session-scan's cross-home union for the measured case.
 *
 * An explicit override (env or settings) means the operator has said exactly
 * where to look, so discovery is off in that case for every tool — matching how
 * claudeProjectDirs has always behaved.
 *
 * `suffix` is appended to each home to reach the session root (e.g. 'projects',
 * 'sessions', 'tmp'); pass '' for the home itself. Only roots that EXIST are
 * returned, so callers never have to re-check.
 */
function siblingHomes(base: string, overridden: boolean, suffix: string): string[] {
  const roots: string[] = [];
  const add = (home: string) => {
    const root = suffix ? join(home, suffix) : home;
    if (existsSync(root) && !roots.includes(root)) roots.push(root);
  };
  add(base);
  if (!overridden) {
    const parent = dirname(base);
    const leaf = basename(base);
    try {
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === leaf || !entry.name.startsWith(leaf + '-')) continue;
        add(join(parent, entry.name));
      }
    } catch { /* parent unreadable — primary only */ }
  }
  return roots;
}

/** Apply tenant source exclusions, failing safe to the unfiltered list: an
 *  empty root set is indistinguishable from "this machine has no sessions". */
function applyExclusions(roots: string[], includeExcluded?: boolean): string[] {
  if (includeExcluded || !_sourceExclusionFilter || roots.length === 0) return roots;
  const kept = roots.filter((r) => !_sourceExclusionFilter!(r));
  return kept.length > 0 ? kept : roots;
}

export interface RootsOpts { includeExcluded?: boolean }

/** Every Gemini `tmp/` root (chats live at `<root>/<project>/chats`). */
export function geminiTmpDirs(opts: RootsOpts = {}): string[] {
  const overridden = !!(process.env.CHAT_RECALL_GEMINI_HOME || sources().geminiHome);
  return applyExclusions(siblingHomes(geminiHomeDir(), overridden, 'tmp'), opts.includeExcluded);
}

/** Every Codex `sessions/` root. */
export function codexSessionDirs(opts: RootsOpts = {}): string[] {
  const overridden = !!(process.env.CHAT_RECALL_CODEX_HOME || sources().codexHome);
  return applyExclusions(siblingHomes(codexHomeDir(), overridden, 'sessions'), opts.includeExcluded);
}

/** Every Antigravity `brain/` root. */
export function agyBrainDirs(opts: RootsOpts = {}): string[] {
  const overridden = !!(process.env.CHAT_RECALL_AGY_HOME || sources().agyHome);
  return applyExclusions(siblingHomes(agyHomeDir(), overridden, 'brain'), opts.includeExcluded);
}

/**
 * Every OpenCode database. Unlike the others this is a FILE, so siblings are
 * discovered on the containing data dir (`~/.local/share/opencode-work/…`).
 */
export function opencodeDbPaths(opts: RootsOpts = {}): string[] {
  const primary = opencodeDbPath();
  const overridden = !!(process.env.CHAT_RECALL_OPENCODE_DB || sources().opencodeDbPath);
  const dbFile = basename(primary);
  const dirs = siblingHomes(dirname(primary), overridden, '');
  const dbs: string[] = [];
  for (const d of dirs) {
    const p = join(d, dbFile);
    if (existsSync(p) && !dbs.includes(p)) dbs.push(p);
  }
  // The primary may not exist yet (fresh install) — keep it so callers that
  // create/open it still get a path.
  if (dbs.length === 0) dbs.push(primary);
  return applyExclusions(dbs, opts.includeExcluded);
}

/**
 * Extra Claude home directories (multi-install). Returns the deduped list
 * minus the primary `claudeHomeDir()`. Discovery code can union these with
 * the primary home to scan all known installs.
 */
export function extraClaudeHomeDirs(): string[] {
  const extras = sources().extraClaudeHomes ?? [];
  const primary = claudeHomeDir();
  return Array.from(new Set(extras)).filter(p => p && p !== primary);
}
