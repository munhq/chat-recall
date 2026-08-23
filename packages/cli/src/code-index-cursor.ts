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
 * A tiny JSON map of workspace path → last successful index. Best-effort in both
 * directions: a missing or corrupt file just means "nothing indexed yet", and a
 * write that fails is ignored. It records COMPLETIONS only, so a workspace that
 * crashes the indexer is retried rather than being marked done — the opposite
 * choice would silently drop a repo forever.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getDataDir } from '@chat-recall/engine/core/paths.js';

const cursorPath = (): string => join(getDataDir(), 'code-index-cursor.json');

/** workspace path → epoch ms of the last COMPLETED index. */
export type CodeIndexCursor = Record<string, number>;

export function readCursor(): CodeIndexCursor {
  try {
    const raw = JSON.parse(readFileSync(cursorPath(), 'utf-8')) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const out: CodeIndexCursor = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
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
export function noteIndexed(workspace: string, now = Date.now()): void {
  const c = readCursor();
  c[workspace] = now;
  // Forget paths that are no longer candidates, so a machine that has moved on
  // does not carry a growing map of dead repos forever.
  writeCursor(c);
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
    .map((w, i) => ({ w, i, at: cursor[w] ?? -1 }))
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
