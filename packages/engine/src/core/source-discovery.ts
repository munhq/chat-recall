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
import { claudeProjectDirs, _setSourceExclusionFilter } from './tool-paths.js';

export interface SessionSource {
  /** Stable id derived from the path — what the dashboard toggles and the
   *  server stores. Never a raw path in the server→client direction. */
  id: string;
  tool: 'claude';
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

function countTranscripts(projectsDir: string): { sessions: number; newestMtime: number } {
  let sessions = 0;
  let newestMtime = 0;
  let projects: string[];
  try { projects = readdirSync(projectsDir); } catch { return { sessions, newestMtime }; }
  for (const proj of projects) {
    let files: string[];
    try { files = readdirSync(join(projectsDir, proj)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl') || f === 'sessions-index.json') continue;
      sessions++;
      try {
        const m = statSync(join(projectsDir, proj, f)).mtimeMs;
        if (m > newestMtime) newestMtime = m;
      } catch { /* vanished mid-scan */ }
    }
  }
  return { sessions, newestMtime };
}

/**
 * Every transcript source on this machine, INCLUDING ones currently excluded —
 * the dashboard has to be able to show a switched-off source in order to switch
 * it back on. Ordered as scanned, primary first.
 */
export function discoverSessionSources(): SessionSource[] {
  const out: SessionSource[] = [];
  const dirs = claudeProjectDirs({ includeExcluded: true });
  for (const [i, path] of dirs.entries()) {
    if (!existsSync(path)) continue;
    const { sessions, newestMtime } = countTranscripts(path);
    out.push({ id: sourceId(path), tool: 'claude', path, sessions, newestMtime, isPrimary: i === 0 });
  }
  return out;
}
