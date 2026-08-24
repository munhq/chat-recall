/**
 * What the collector's last walk report means, as a pure function.
 *
 * This lived inline in GET /api/status/sync, which is why it was wrong for
 * months without anything noticing: there was no way to assert "a finished walk
 * stops reporting progress" without a Postgres tenant and a live collector.
 *
 * The bug it exists to prevent: the collector marks `complete` on the last line
 * of its walk, AFTER its final upload has gone out, so the flag only ever ships
 * on the NEXT post — and a walk with nothing new to upload never makes one. The
 * server was therefore left holding `done === total` with `complete: false`,
 * refreshed often enough that the staleness window never rescued it, and the UI
 * read that as "syncing 99%" indefinitely.
 *
 * So `done >= total` is treated as finished whatever the flag says. That is
 * checked HERE rather than only in the collector because collectors already
 * installed keep reporting the old way, and should not need an upgrade before
 * the badge stops lying.
 */

/** A walk report as the collector writes it into kv_store. */
export interface WalkReport {
  done: number;
  total: number;
  complete: boolean;
  /** Server-stamped epoch ms of when this report was received. */
  at: number;
}

export interface WalkProgressView {
  /** Present only while a walk is genuinely in flight. */
  progress: { done: number; total: number } | null;
  /**
   * Age of the collector's last report, which answers "is sync working" — a
   * different question from how old the newest session is. Present whenever a
   * report exists at all, including a finished one, because a finished walk is
   * precisely the case that needs it.
   */
  lastSyncAgeMs: number | null;
}

/**
 * A report older than this is treated as gone: a collector that died mid-walk
 * must not leave the UI claiming "syncing 62%" forever.
 */
export const PROGRESS_STALE_MS = 10 * 60_000;

const EMPTY: WalkProgressView = { progress: null, lastSyncAgeMs: null };

/**
 * @param raw   the kv_store value, or null/undefined when nothing was reported
 * @param now   injected so tests are not clock-dependent
 */
export function readWalkProgress(raw: string | null | undefined, now: number): WalkProgressView {
  if (!raw) return EMPTY;

  let p: WalkReport;
  try {
    p = JSON.parse(raw) as WalkReport;
  } catch {
    // A malformed value is not a reason to fail the status endpoint. Progress is
    // cosmetic; the rest of the payload is not.
    return EMPTY;
  }
  if (typeof p.done !== 'number' || typeof p.total !== 'number') return EMPTY;

  const lastSyncAgeMs =
    typeof p.at === 'number' && p.at > 0 ? Math.max(0, now - p.at) : null;

  const finished = p.complete === true || p.done >= p.total;
  const stale = lastSyncAgeMs == null || lastSyncAgeMs >= PROGRESS_STALE_MS;
  const inFlight = !finished && !stale && p.total > 0;

  return {
    progress: inFlight ? { done: p.done, total: p.total } : null,
    lastSyncAgeMs,
  };
}
