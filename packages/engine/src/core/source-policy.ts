/**
 * Settings-driven gating for memory sources.
 *
 * Two responsibilities:
 *   1. `isItemAllowed(item)` — should this MemoryItem enter the index at all?
 *      Combines per-source enable flags (`sources.enabled.<tool>.<src>`)
 *      and project allow/deny lists from `privacy`. Also enforces the
 *      paste-cache privacy hard-skip.
 *   2. `policyKeyFor(item)` — pure helper used by tests and UI to explain
 *      which setting key gates a given item.
 *
 * Invoked from `SourceRegistry.discoverAll()` / `processSource()`. Plugins
 * stay unchanged so the registry is the single chokepoint — there's no
 * way for an indexer call site to skip the gate.
 */

import type { MemoryItem, SourceType } from '../types/memory.js';
import { loadSettings, settingsFilePath, type AppSettings, type SourcesEnabled } from './settings.js';
import { statSync } from 'fs';

interface CacheEntry {
  mtimeMs: number;
  settings: AppSettings;
}
let cache: CacheEntry | null = null;

function settings(): AppSettings {
  let mtimeMs = -1;
  try { mtimeMs = statSync(settingsFilePath()).mtimeMs; } catch { /* missing → defaults */ }
  if (cache && cache.mtimeMs === mtimeMs) return cache.settings;
  const s = loadSettings();
  cache = { mtimeMs, settings: s };
  return s;
}

/** Force a re-read on next gate check. Used by tests. */
export function _resetSourcePolicyCache(): void {
  cache = null;
}

type Tool = 'claude' | 'gemini' | 'opencode' | 'codex' | 'agy' | 'cursor';

const TOOLS: readonly Tool[] = ['claude', 'gemini', 'opencode', 'codex', 'agy', 'cursor'];

/** Pull the originating AI tool from `extra.tool`. Falls back per sourceType. */
function toolOf(item: MemoryItem): Tool | null {
  const t = item.extra?.tool;
  return typeof t === 'string' && (TOOLS as readonly string[]).includes(t) ? t as Tool : null;
}

/**
 * Resolve the dotted policy key for an item, e.g. `'claude.sessions'`.
 * Returns null for items that aren't user-toggleable (diary).
 */
export function policyKeyFor(item: MemoryItem): string | null {
  const tool = toolOf(item);
  switch (item.sourceType as SourceType) {
    case 'session':   return `${tool ?? 'claude'}.sessions`;
    case 'plan':      return `${tool ?? 'claude'}.plans`;
    case 'task':
      // OpenCodeTodoSource yields tool='opencode' → opencode.todos.
      // TaskSource yields tool='claude'           → claude.tasks.
      return tool === 'opencode' ? 'opencode.todos' : 'claude.tasks';
    case 'paste':     return 'claude.pasteCache';
    case 'history':   return 'claude.history';
    case 'hook':      return 'claude.hooks';
    case 'agent':     return 'claude.agents';
    case 'command':   return 'claude.commands';
    case 'skill':     return `${tool ?? 'claude'}.skills`;
    case 'plugin':
      // Gemini calls them "extensions"; Claude/Codex call them "plugins".
      return tool === 'gemini' ? 'gemini.extensions' : `${tool ?? 'claude'}.plugins`;
    case 'mcp':       return 'common.mcps';
    case 'claude_md': return 'common.agentMd';
    case 'diary':     return null;
    default:          return null;
  }
}

/** Walk an `enabled` map by dotted key; returns true if the leaf is true or missing. */
function lookupEnabled(enabled: SourcesEnabled, key: string): boolean {
  const [group, leaf] = key.split('.') as [keyof SourcesEnabled, string];
  const block = enabled[group] as Record<string, boolean> | undefined;
  if (!block) return true;
  return block[leaf] !== false;
}

/**
 * Match a project path against a list of patterns.
 *
 * Supports:
 *   - Exact match (`/home/me/foo` matches itself)
 *   - Subtree match (`/home/me/foo` matches anything under `/home/me`)
 *   - Suffix-`*` glob (`/home/me/work/*` matches direct children)
 *
 * Empty list ⇒ no match. Empty `projectPath` ⇒ no match (item isn't
 * project-scoped, e.g. ~/CLAUDE.md global note).
 */
function matchesProjectList(projectPath: string, patterns: string[]): boolean {
  if (!projectPath || patterns.length === 0) return false;
  for (const raw of patterns) {
    if (!raw) continue;
    const p = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (p.endsWith('/*')) {
      const parent = p.slice(0, -2);
      const tail = projectPath.slice(parent.length + 1);
      if (projectPath.startsWith(parent + '/') && !tail.includes('/')) return true;
    } else if (projectPath === p || projectPath.startsWith(p + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * Final say: does this item enter the index?
 *
 * Order of checks (any failure short-circuits):
 *   1. Privacy: paste-cache hard-skip (`privacy.redactPasteCache`)
 *   2. Privacy: project allowlist (if non-empty, item must match)
 *   3. Privacy: project denylist (item must not match)
 *   4. Sources: per-source enable flag for the resolved policy key
 */
export function isItemAllowed(item: MemoryItem): boolean {
  const s = settings();

  if (item.sourceType === 'paste' && s.privacy.redactPasteCache) return false;

  const allowlist = s.privacy.projectAllowlist ?? [];
  if (allowlist.length > 0) {
    // Items without a projectPath (global notes, MCP configs) bypass the
    // allowlist — those aren't project-scoped, so an allowlist meant for
    // project filtering shouldn't suppress them.
    if (item.projectPath && !matchesProjectList(item.projectPath, allowlist)) return false;
  }

  if (matchesProjectList(item.projectPath, s.privacy.projectDenylist)) return false;

  const key = policyKeyFor(item);
  if (key && !lookupEnabled(s.sources.enabled, key)) return false;

  return true;
}
