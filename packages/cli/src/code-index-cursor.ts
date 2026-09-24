/**
 * Remember which workspaces have been code-indexed, so a restart makes progress
 * instead of starting the sweep over.
 *
 * ── The behaviour this fixes ──────────────────────────────────────────────
 * `codeIndexTick` discovered up to 50 workspaces sorted by most-recently-used
 * and walked them in that order, holding nothing across process boundaries. The
 * daemon's median uptime during the OOM crash-loop was ~105 seconds, and a
 * single large repo takes tens of seconds — so every restart re-indexed the same
 * first workspace or two and the tail of the list was never reached AT ALL. The
 * log showed 8,919 `indexing` lines against 382 completions.
 *
 * Ordering by recency is right for a first run and wrong for every run after it:
 * the busiest repo is always first, so it is always the one that gets done. What
 * makes a sweep finish is going to the LEAST-RECENTLY-INDEXED workspace next,
 * which is what this cursor provides.
 *
 * ── Shape ────────────────────────────────────────────────────────────────
 * A tiny JSON map of workspace path → last successful index (its time and the
 * workspace fingerprint it saw, so a pass skips code that did not change).
 * Best-effort in both
 * directions: a missing or corrupt file just means "nothing indexed yet", and a
 * write that fails is ignored. It records COMPLETIONS only, so a workspace that
 * crashes the indexer is retried rather than being marked done — the opposite
 * choice would silently drop a repo forever.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { getDataDir } from '@chat-recall/engine/core/paths.js';

const cursorPath = (): string => join(getDataDir(), 'code-index-cursor.json');

/** One completed index: when, and the workspace fingerprint it saw. */
export interface CursorEntry { at: number; fp?: string }

/** workspace path → the last COMPLETED index. */
export type CodeIndexCursor = Record<string, CursorEntry>;

export function readCursor(): CodeIndexCursor {
  try {
    const raw = JSON.parse(readFileSync(cursorPath(), 'utf-8')) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const out: CodeIndexCursor = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        // A bare number is the file an earlier version wrote: a time, no fingerprint.
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = { at: v };
        else if (v && typeof v === 'object' && typeof (v as CursorEntry).at === 'number' && Number.isFinite((v as CursorEntry).at)) {
          const fp = (v as CursorEntry).fp;
          out[k] = typeof fp === 'string' ? { at: (v as CursorEntry).at, fp } : { at: (v as CursorEntry).at };
        }
      }
      return out;
    }
  } catch { /* absent or corrupt — nothing indexed yet */ }
  return {};
}

function writeCursor(c: CodeIndexCursor): void {
  try {
    const p = cursorPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(c));
  } catch { /* housekeeping must never fail a sweep */ }
}

/** Record a COMPLETED index. Never called for a failure — see the header. */
export function noteIndexed(workspace: string, now = Date.now(), fp?: string | null): void {
  const c = readCursor();
  c[workspace] = fp ? { at: now, fp } : { at: now };
  writeCursor(c);
}

/**
 * What the code in a git workspace is right now: HEAD, plus each changed or
 * untracked file with its size and mtime, plus the collector's own version so
 * a new result format rescans everything. Null when the workspace is not a git
 * repository or git does not answer; such a workspace is scanned every pass.
 */
export function workspaceFingerprint(workspace: string, collectorVersion: number): string | null {
  try {
    const git = (args: string[]) => execFileSync('git', ['-C', workspace, ...args],
      { encoding: 'utf-8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const head = git(['rev-parse', 'HEAD']).trim();
    const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const h = createHash('sha256').update(`v${collectorVersion}\0${head}\0`);
    for (const entry of status.split('\0')) {
      if (entry.length < 4) continue;
      const rel = entry.slice(3);
      let stamp = 'gone';
      try { const s = statSync(join(workspace, rel)); stamp = `${s.size}:${Math.floor(s.mtimeMs)}`; } catch { /* deleted */ }
      h.update(`${entry.slice(0, 2)}\0${rel}\0${stamp}\0`);
    }
    return h.digest('hex');
  } catch {
    return null;
  }
}

/** An unchanged workspace is still sent again after this long. The collector
 *  cannot see the server's copy, and a server that lost it gets it back. */
export const UNCHANGED_RESEND_MS = 7 * 24 * 3600 * 1000;

/** True when the last completed index saw this same fingerprint recently. */
export function isUnchangedSinceIndexed(workspace: string, fp: string | null, cursor: CodeIndexCursor, now = Date.now()): boolean {
  const e = cursor[workspace];
  return !!fp && !!e && e.fp === fp && now - e.at < UNCHANGED_RESEND_MS;
}

/**
 * Order workspaces least-recently-indexed first, so a sweep that keeps getting
 * interrupted still eventually covers everything.
 *
 * Never-indexed workspaces sort before indexed ones — a repo the collector has
 * never looked at is more valuable than refreshing one done an hour ago. Ties
 * keep the caller's order, which is recency, so a first run behaves exactly as
 * it did before this existed.
 */
export function orderByStaleness(workspaces: string[], cursor = readCursor()): string[] {
  return workspaces
    .map((w, i) => ({ w, i, at: cursor[w]?.at ?? -1 }))
    .sort((a, b) => (a.at - b.at) || (a.i - b.i))
    .map((e) => e.w);
}

/** Drop entries for paths that are no longer candidates. */
export function pruneCursor(known: string[]): void {
  const keep = new Set(known);
  const c = readCursor();
  let changed = false;
  for (const k of Object.keys(c)) {
    if (!keep.has(k)) { delete c[k]; changed = true; }
  }
  if (changed) writeCursor(c);
}
