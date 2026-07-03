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
import { join } from 'path';
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
export function claudeProjectDirs(): string[] {
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
  return dirs;
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
 * Extra Claude home directories (multi-install). Returns the deduped list
 * minus the primary `claudeHomeDir()`. Discovery code can union these with
 * the primary home to scan all known installs.
 */
export function extraClaudeHomeDirs(): string[] {
  const extras = sources().extraClaudeHomes ?? [];
  const primary = claudeHomeDir();
  return Array.from(new Set(extras)).filter(p => p && p !== primary);
}
