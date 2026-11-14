/**
 * A bound on ONE walk, and the rule for when a restart must walk everything.
 *
 * Measured on a machine with 12,224 local sessions (issue #16): listing every
 * session costs about 92 MiB, and the upload phase churns several hundred MiB
 * of buffers that V8 does not return to the OS (573 MiB RSS against 76 MiB of
 * live heap). A walk of the whole corpus therefore has no memory bound that a
 * restart can respect: each restart began the corpus again from the first
 * session, reached the systemd MemoryMax of 2 GiB and was killed — 15 times in
 * one day, and about 400 MiB of the peak came from process start alone.
 *
 * Two rules follow, and both live here so they are testable without a daemon:
 *
 *  1. One walk carries at most `walkSessionLimit()` sessions, and the sessions
 *     the ledger has NOT acknowledged come first. The rest wait for the next
 *     walk, so a large corpus makes progress in bounded steps instead of one
 *     unbounded step.
 *  2. A daemon restart walks 'changed', not 'full', while the last successful
 *     walk is recent (`shouldWalkFull`). A restart with nothing changed then
 *     uploads nothing and lists only the recent window.
 */

/** Sessions one walk may carry. ~190 sessions/min measured, so about 10 minutes. */
export const DEFAULT_WALK_MAX_SESSIONS = 2000;

/** A full walk is due again after this long without a success. */
export const FULL_WALK_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * The cap for one walk. A bound that a typo can disable is not a bound, so an
 * empty, non-numeric, fractional or non-positive value keeps the default.
 */
export function walkSessionLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CHAT_RECALL_SYNC_WALK_MAX;
  if (raw === undefined || raw.trim() === '') return DEFAULT_WALK_MAX_SESSIONS;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return DEFAULT_WALK_MAX_SESSIONS;
  return n;
}

/**
 * Put the sessions without an acknowledged row first, and keep the incoming
 * order inside both groups. Without this the cap would always carry the same
 * first N sessions and the corpus past N would never move.
 */
export function orderRefsForWalk<T extends { prefixedId: string }>(
  refs: readonly T[],
  isAcked: (prefixedId: string) => boolean,
): T[] {
  const fresh: T[] = [];
  const acked: T[] = [];
  for (const ref of refs) (isAcked(ref.prefixedId) ? acked : fresh).push(ref);
  return [...fresh, ...acked];
}

/**
 * Must the next walk be a FULL walk?
 *
 * A full walk is due when there is no successful stamp, when the stamp is
 * unusable, or when it is older than the interval. A stamp in the future means
 * the clock moved back, and an untrustworthy stamp must not suppress the walk
 * that catches up after a gap.
 */
export function shouldWalkFull(opts: {
  lastSuccessAt?: number;
  now: number;
  fullIntervalMs?: number;
}): boolean {
  const { lastSuccessAt, now } = opts;
  const interval = opts.fullIntervalMs ?? FULL_WALK_INTERVAL_MS;
  if (typeof lastSuccessAt !== 'number' || !Number.isFinite(lastSuccessAt) || lastSuccessAt <= 0) return true;
  if (lastSuccessAt > now) return true;
  return now - lastSuccessAt >= interval;
}

/**
 * True when a walk may tombstone the sessions that it did not visit.
 *
 * A session that is in the ledger and was not visited counts as deleted only
 * when the walk listed every local session and visited every one of them. A walk
 * that carries a slice of the list (the cap of `walkSessionLimit()`), or that
 * paused at the memory bound, leaves unvisited sessions that still exist.
 * Measured on 2026-11-12: the first capped walk after the upgrade sent 11,977
 * tombstones for sessions that were on disk, and the server never accepts a
 * session again after its tombstone.
 */
export function mayTombstone(walk: { changedWalk: boolean; listed: number; sliceSize: number; paused: boolean }): boolean {
  return !walk.changedWalk && !walk.paused && walk.sliceSize >= walk.listed;
}
