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
