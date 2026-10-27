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

import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join, dirname, basename, isAbsolute } from 'path';
// Local approval decisions + the one-shot upgrade migration. Imported directly
// (no cycle: home-approval reads settings, which knows nothing about paths).
import { isHomeSynced, grandfatherLegacyHomes, defaultHermesHome, homeDecision } from './home-approval.js';
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
  // Same decision pipeline as every other tool — local approval first, then
  // tenant exclusions. Claude used to have its own inline exclusion check, which
  // meant the tool with the most sessions was the one that skipped the approval
  // gate entirely.
  return applyDecisions(dirs, opts.includeExcluded);
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

/**
 * Hermes Agent root: `~/.hermes`, or `%LOCALAPPDATA%\hermes` on Windows.
 * Hermes itself reads `HERMES_HOME`, so a machine that sets it is read there.
 */
export function hermesHomeDir(): string {
  return process.env.CHAT_RECALL_HERMES_HOME
    || sources().hermesHome
    || process.env.HERMES_HOME?.trim()
    || defaultHermesHome();
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

/** Cursor root (`~/.cursor` by default), shared by the CLI and the IDE agent. */
export function cursorHomeDir(): string {
  return process.env.CHAT_RECALL_CURSOR_HOME
    || sources().cursorHome
    || join(homedir(), '.cursor');
}

/**
 * Cursor IDE user-data root (`~/.config/Cursor` by default).
 *
 * Note the capital C. `~/.config/cursor` (lowercase) is the CLI's auth
 * directory and holds no chats; `~/.config/Cursor` is the desktop app.
 * Both exist on Linux, which is exactly why this is a named resolver
 * rather than an inline join.
 */
export function cursorIdeHomeDir(): string {
  return process.env.CHAT_RECALL_CURSOR_IDE_HOME
    || sources().cursorIdeHome
    || (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Cursor')
      : join(homedir(), '.config', 'Cursor'));
}

/**
 * Pi coding agent config root (`~/.pi/agent` by default).
 *
 * Pi keeps one "agent dir" holding everything: sessions/, skills/, prompts/
 * and mcp.json. It reads `PI_CODING_AGENT_DIR` itself, so a machine that
 * relocates its config is read where it actually writes.
 */
export function piHomeDir(): string {
  const raw = process.env.CHAT_RECALL_PI_HOME
    || sources().piHome
    || process.env.PI_CODING_AGENT_DIR?.trim();
  return raw ? expandTildePath(raw) : join(homedir(), '.pi', 'agent');
}

/** Expand a leading `~`, which Pi accepts in its own path settings. */
export function expandTildePath(value: string): string {
  const t = value.trim();
  if (t === '~') return homedir();
  if (t.startsWith('~/') || t.startsWith('~\\')) return join(homedir(), t.slice(2));
  return t;
}

/**
 * Pi's session root — `<agent dir>/sessions` unless Pi was told otherwise.
 * `PI_CODING_AGENT_SESSION_DIR` is Pi's own override (and `--session-dir` beats
 * it at the CLI, where the value is not visible to us).
 */
export function piSessionDir(): string {
  const override = piSessionDirEnv();
  if (override) return override;
  return piSessionDirForHome(piHomeDir());
}

/** The session root from our env or Pi's own, with `~` expanded. */
function piSessionDirEnv(): string | null {
  const raw = process.env.CHAT_RECALL_PI_SESSION_DIR
    || process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  return raw && raw.trim() ? expandTildePath(raw) : null;
}

/** The session root of one Pi agent dir: an absolute `sessionDir`, else sessions/. */
export function piSessionDirForHome(home: string): string {
  // The resolved Pi home also answers to the env override, so discovery and the
  // decline path see the folder the backend syncs.
  const env = piSessionDirEnv();
  if (env && sameDir(home, piHomeDir())) return env;
  return piSessionDirFromSettings(join(home, 'settings.json')) || join(home, 'sessions');
}

/** Compare two folders, tolerating a symlink on either side. */
function sameDir(a: string, b: string): boolean {
  if (a === b) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/**
 * Pi's own `sessionDir` setting, when it is absolute. A relative one resolves
 * from a per-session working directory, so it names no single folder.
 * Cached on the file's mtime: the sync walk resolves the session root often.
 */
let piSettingsCache: { path: string; sig: number; dir: string | null } | null = null;

function piSessionDirFromSettings(file: string): string | null {
  let sig: number;
  try { sig = statSync(file).mtimeMs; } catch { return null; }
  if (piSettingsCache && piSettingsCache.path === file && piSettingsCache.sig === sig) {
    return piSettingsCache.dir;
  }
  let dir: string | null = null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { sessionDir?: unknown };
    const value = typeof parsed.sessionDir === 'string' ? parsed.sessionDir.trim() : '';
    // Pi expands `~` in this setting, and a relative path names no fixed folder.
    const expanded = value ? expandTildePath(value) : '';
    dir = expanded && isAbsolute(expanded) ? expanded : null;
  } catch { /* unreadable or malformed: the default stands */ }
  piSettingsCache = { path: file, sig, dir };
  return dir;
}

/**
 * Every Pi session root.
 *
 * The agent dir is the home the operator approves. A custom `sessionDir` is a
 * second folder, so an explicit DECLINE on it stops the sync too. The per-source
 * switch in the dashboard applies as well.
 */
export function piSessionDirs(opts: RootsOpts = {}): string[] {
  const home = piHomeDir();
  const dir = piSessionDir();
  // Only a root that EXISTS counts: an install that never ran Pi reports none.
  if (!existsSync(dir)) return [];
  if (opts.includeExcluded) return [dir];

  try { grandfatherLegacyHomes(); } catch { /* settings unreadable */ }
  try { if (!isHomeSynced(home)) return []; } catch { /* gate unreadable */ }
  try { if (homeDecision(dir) === 'declined') return []; } catch { /* gate unreadable */ }
  if (_sourceExclusionFilter && _sourceExclusionFilter(dir)) return [];
  return [dir];
}

/** Pi user skills root — `<agent dir>/skills`, one folder per skill. */
export function piSkillsDir(): string { return join(piHomeDir(), 'skills'); }

/** Pi prompt templates (slash commands) — `<agent dir>/prompts/*.md`. */
export function piPromptsDir(): string { return join(piHomeDir(), 'prompts'); }

/** Pi's user-level MCP server config — `<agent dir>/mcp.json`. */
export function piMcpConfigPath(): string { return join(piHomeDir(), 'mcp.json'); }

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

/**
 * Apply the operator's decisions to a candidate root list:
 *   1. HOME APPROVAL (local) — a discovered home that is pending or declined is
 *      not scanned. Primary homes are always in.
 *   2. TENANT EXCLUSIONS (server) — a discovered source switched off in the
 *      dashboard.
 *
 * Both fail safe to the unfiltered list when they would leave nothing: an empty
 * root set is indistinguishable from "this machine has no sessions", and that
 * reads as data loss.
 *
 * The grandfather migration runs HERE, before the first gating decision, which
 * is the only ordering that cannot silently stop syncing a home that an existing
 * install had been syncing for months. It is a no-op after the first call.
 */
function applyDecisions(roots: string[], includeExcluded?: boolean): string[] {
  if (roots.length === 0) return roots;
  let kept = roots;

  if (!includeExcluded) {
    try {
      grandfatherLegacyHomes();
      // A root is <home>/<subdir> (or the opencode db's dir), so the home is its
      // parent — one rule for every tool.
      const approved = kept.filter((r) => isHomeSynced(dirname(r)));
      if (approved.length > 0) kept = approved;
    } catch { /* settings unreadable — scan everything rather than nothing */ }
  }

  if (!includeExcluded && _sourceExclusionFilter) {
    const notExcluded = kept.filter((r) => !_sourceExclusionFilter!(r));
    if (notExcluded.length > 0) kept = notExcluded;
  }
  return kept;
}

/** @deprecated kept for the call sites below; use applyDecisions. */
function applyExclusions(roots: string[], includeExcluded?: boolean): string[] {
  return applyDecisions(roots, includeExcluded);
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

/** Every Cursor `chats/` root (the CLI agent store). */
export function cursorChatDirs(opts: RootsOpts = {}): string[] {
  const overridden = !!(process.env.CHAT_RECALL_CURSOR_HOME || sources().cursorHome);
  return applyExclusions(siblingHomes(cursorHomeDir(), overridden, 'chats'), opts.includeExcluded);
}

/** Every Cursor IDE `User/workspaceStorage/` root. */
export function cursorIdeWorkspaceDirs(opts: RootsOpts = {}): string[] {
  const overridden = !!(process.env.CHAT_RECALL_CURSOR_IDE_HOME || sources().cursorIdeHome);
  return applyExclusions(
    siblingHomes(cursorIdeHomeDir(), overridden, join('User', 'workspaceStorage')),
    opts.includeExcluded,
  );
}

/** Every Cursor IDE `User/globalStorage/state.vscdb` — where 3.0+ keeps chat content. */
export function cursorIdeGlobalDbs(opts: RootsOpts = {}): string[] {
  const overridden = !!(process.env.CHAT_RECALL_CURSOR_IDE_HOME || sources().cursorIdeHome);
  const roots = applyExclusions(
    siblingHomes(cursorIdeHomeDir(), overridden, join('User', 'globalStorage')),
    opts.includeExcluded,
  );
  const dbs: string[] = [];
  for (const r of roots) {
    const p = join(r, 'state.vscdb');
    if (existsSync(p) && !dbs.includes(p)) dbs.push(p);
  }
  return dbs;
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
 * Every Hermes database: `<root>/state.db`, then `<root>/profiles/<name>/state.db`
 * for each named profile. A profile is its own home, so it syncs once approved.
 */
export function hermesDbPaths(opts: RootsOpts = {}): string[] {
  const root = hermesHomeDir();
  const dbs = [join(root, 'state.db')];
  try {
    const profiles = join(root, 'profiles');
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = join(profiles, entry.name, 'state.db');
      if (existsSync(p)) dbs.push(p);
    }
  } catch { /* no named profiles */ }
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

/**
 * Every Claude home on this machine, as HOMES rather than session roots: the
 * resolved primary, every sibling `~/.claude-*` profile (minus `.claude-code`,
 * same carve-out as claudeProjectDirs), and any configured extra home.
 *
 * Claude is the only backend with profiles — `CLAUDE_CONFIG_DIR` selects one
 * per session, so `~/.claude-work` is a complete Claude install with its own
 * skills/, hooks.json and settings.json. The READ side has always fanned out
 * over them (claudeProjectDirs). This is that same set for WRITE-side callers,
 * which is the half that was missing: installing only into the primary home
 * leaves a profile running an agent with no chat-recall skills and no hooks,
 * while that profile's sessions index perfectly — so nothing looks broken.
 */
export function claudeHomeDirs(): string[] {
  const overridden = !!(process.env.CHAT_RECALL_CLAUDE_HOME || sources().claudeHome);
  const homes = siblingHomes(claudeHomeDir(), overridden, '')
    .filter((h) => basename(h) !== '.claude-code');
  for (const extra of extraClaudeHomeDirs()) {
    if (existsSync(extra) && !homes.includes(extra)) homes.push(extra);
  }
  return homes;
}
