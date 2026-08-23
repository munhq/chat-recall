/**
 * Which transcript SOURCES this machine has, and which of them the operator
 * wants synced.
 *
 * ── Why this is an exclusion, not an opt-in ──────────────────────────────
 * The obvious design is "the dashboard tells each collector which paths to
 * sync". Do not build that. The collector runs as the user with full read
 * access, so a server that can name a path is a server that can make every
 * customer's machine read `~/.ssh` and upload it. The existing tenant sync
 * config is deliberately union-only for the same reason:
 *
 *   "Union is the fail-safe direction: server config can only ADD protection —
 *    it can never silently re-enable syncing of something a machine excluded."
 *
 * So the split is: the CLIENT discovers what exists and reports it (paths only
 * ever travel machine → server), and the server may only switch a discovered
 * source OFF. A compromised server can shrink what we collect, never widen it,
 * and it cannot introduce a path the machine did not already find on its own.
 *
 * The concrete need this serves: `~/.claude-work` holds an employer's sessions,
 * and whether those belong in a personal tenant is the operator's call to make
 * in the dashboard — not a decision buried in a shell script.
 */

import { createHash } from 'crypto';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  claudeProjectDirs, geminiTmpDirs, codexSessionDirs, agyBrainDirs, cursorChatDirs, opencodeDbPaths,
  _setSourceExclusionFilter,
} from './tool-paths.js';

export type SourceTool = 'claude' | 'gemini' | 'codex' | 'agy' | 'opencode' | 'cursor';

export interface SessionSource {
  /** Stable id derived from the path — what the dashboard toggles and the
   *  server stores. Never a raw path in the server→client direction. */
  id: string;
  tool: SourceTool;
  /** Absolute projects dir on this machine. Reported UP only. */
  path: string;
  /** Transcript count, so the dashboard can show what is at stake. */
  sessions: number;
  /** Newest transcript mtime (ms), 0 when empty. */
  newestMtime: number;
  /** True for the tool's main home — excluding it is possible but loud. */
  isPrimary: boolean;
}

/** Stable, path-derived id. Hashed so the wire format carries no filesystem
 *  layout beyond what the client already reported. */
export function sourceId(path: string): string {
  return 'src_' + createHash('sha256').update(path).digest('hex').slice(0, 12);
}

// ── Exclusions installed by the sync client from tenant config ────────────
// Module-level, same shape as the redactor's server rule pack: fetched at the
// start of a sync, applied in-process, never persisted anywhere the server can
// reach directly.
let excludedIds = new Set<string>();

/** Replace the excluded set for this process. Ids only — a path from the
 *  server is never honoured, which is the whole point. */
/** Exactly the shape `sourceId()` produces, and exactly what the server
 *  validates on write. A looser check (`startsWith('src_')`) let `src_anything`
 *  through — harmless in isolation, but this is the one function standing
 *  between a hostile config value and what the collector reads, so it matches
 *  the full format or nothing. */
const SOURCE_ID_RE = /^src_[0-9a-f]{12}$/;

export function installSourceExclusions(ids: string[]): { excluded: number } {
  excludedIds = new Set((ids || []).filter((s) => typeof s === 'string' && SOURCE_ID_RE.test(s)));
  _setSourceExclusionFilter(isSourceExcluded);
  return { excluded: excludedIds.size };
}

/** Tests + `logout`. */
export function _clearSourceExclusions(): void {
  excludedIds = new Set();
  _setSourceExclusionFilter(null);
}

/** True when this projects dir has been switched off for this tenant. */
export function isSourceExcluded(path: string): boolean {
  return excludedIds.size > 0 && excludedIds.has(sourceId(path));
}

/** Current exclusions, for logging and for the sync summary. */
export function excludedSourceIds(): string[] { return [...excludedIds]; }

/**
 * Count transcripts under a source root. Each tool nests differently — Claude
 * one level (`<project>/<id>.jsonl`), Gemini two (`<project>/chats/session-*.json`),
 * Codex three (`YYYY/MM/DD/rollout-*.jsonl`), Antigravity four
 * (`<id>/.system_generated/logs/*.jsonl`) — so this walks to a bounded depth
 * with a per-tool filename test rather than assuming a shape. Counting the
 * wrong thing here shows the operator "0 sessions" next to a profile that has
 * thousands, which is exactly the sort of number people make decisions on.
 */
const MAX_DEPTH = 5;

function isTranscript(tool: SourceTool, name: string): boolean {
  if (name === 'sessions-index.json') return false;
  switch (tool) {
    case 'gemini':
      return name.startsWith('session-') && (name.endsWith('.json') || name.endsWith('.jsonl'));
    case 'claude':
    case 'codex':
    case 'agy':
      return name.endsWith('.jsonl');
    case 'cursor':
      // One store.db per chat directory, so counting them counts sessions.
      return name === 'store.db';
    default:
      return false;
  }
}

function countTranscripts(root: string, tool: SourceTool): { sessions: number; newestMtime: number } {
  let sessions = 0;
  let newestMtime = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!isTranscript(tool, e.name)) continue;
      sessions++;
      try {
        const m = statSync(full).mtimeMs;
        if (m > newestMtime) newestMtime = m;
      } catch { /* vanished mid-scan */ }
    }
  };
  walk(root, 0);
  return { sessions, newestMtime };
}

/** Count sessions in an OpenCode database — one row per session, so the file
 *  itself is the unit rather than a directory of transcripts. */
function countOpencodeSessions(dbPath: string): { sessions: number; newestMtime: number } {
  try {
    const st = statSync(dbPath);
    // Reading the db here would mean loading better-sqlite3 just to render a
    // checkbox. The file's own mtime answers "is this profile active?", and the
    // exact count is not worth an optional native dependency on this path.
    return { sessions: 0, newestMtime: st.mtimeMs };
  } catch { return { sessions: 0, newestMtime: 0 }; }
}

/**
 * Every transcript source on this machine, for EVERY tool, INCLUDING ones
 * currently excluded — the dashboard has to be able to show a switched-off
 * source in order to switch it back on. Primary first within each tool.
 */
export function discoverSessionSources(): SessionSource[] {
  const out: SessionSource[] = [];

  const dirTools: Array<[SourceTool, string[]]> = [
    ['claude',  claudeProjectDirs({ includeExcluded: true })],
    ['gemini',  geminiTmpDirs({ includeExcluded: true })],
    ['codex',   codexSessionDirs({ includeExcluded: true })],
    ['agy',     agyBrainDirs({ includeExcluded: true })],
    ['cursor',  cursorChatDirs({ includeExcluded: true })],
  ];
  for (const [tool, dirs] of dirTools) {
    for (const [i, path] of dirs.entries()) {
      if (!existsSync(path)) continue;
      const { sessions, newestMtime } = countTranscripts(path, tool);
      out.push({ id: sourceId(path), tool, path, sessions, newestMtime, isPrimary: i === 0 });
    }
  }

  for (const [i, path] of opencodeDbPaths({ includeExcluded: true }).entries()) {
    if (!existsSync(path)) continue;
    const { sessions, newestMtime } = countOpencodeSessions(path);
    out.push({ id: sourceId(path), tool: 'opencode', path, sessions, newestMtime, isPrimary: i === 0 });
  }

  return out;
}
