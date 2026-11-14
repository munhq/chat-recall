/**
 * Two rules for tombstones on the sync route (issue #24).
 *
 * On 2026-11-12 between 19:29:13 and 19:36:30 UTC one collector sent 11,977
 * tombstones in one run. The server deleted the sessions, stored 479 of that
 * machine's 12,199 afterwards, and answered 200 to every later push of a
 * tombstoned session without storing it.
 *
 * 1. A batch that holds more than `CHAT_RECALL_TOMBSTONE_MAX_SHARE` of the
 *    tenant's stored sessions (default 5%) and more than 50 sessions is refused.
 * 2. A tombstoned session comes back when a push carries a newer mtime than the
 *    tombstone.
 */

/** Sessions below which the share is not checked. */
export const TOMBSTONE_GUARD_MIN_BATCH = 50;
export const DEFAULT_TOMBSTONE_MAX_SHARE = 0.05;

/** A value that is not a number from 0 to 1 keeps the default, so a typo cannot turn the guard off. */
export function tombstoneMaxShare(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CHAT_RECALL_TOMBSTONE_MAX_SHARE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TOMBSTONE_MAX_SHARE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_TOMBSTONE_MAX_SHARE;
  return n;
}

export function tombstoneBatchTooLarge(opts: { batch: number; stored: number; maxShare?: number }): boolean {
  const maxShare = opts.maxShare ?? tombstoneMaxShare();
  return opts.batch > TOMBSTONE_GUARD_MIN_BATCH && opts.batch > opts.stored * maxShare;
}

/** Thrown inside the ingest transaction, so the refused batch writes nothing. */
export class TombstoneBatchRefused extends Error {
  readonly code = 'tombstone_batch_too_large';
  constructor(readonly batch: number, readonly stored: number) {
    super(`refused a batch of ${batch} tombstones: it is more than ${tombstoneMaxShare() * 100}% of the ${stored} sessions this tenant stores`);
  }
}

/**
 * Which sessions of a push are dead, and which tombstones to lift.
 * A session is dead while its tombstone is at least as new as the push; a push
 * with a newer mtime lifts the tombstone and the session is ingested.
 */
export function splitTombstoned(
  conversations: ReadonlyArray<{ session_id: string; mtime?: unknown }>,
  tombstonedAt: ReadonlyMap<string, number>,
): { dead: Set<string>; lift: string[] } {
  const dead = new Set<string>();
  const lift = new Set<string>();
  for (const cv of conversations) {
    const at = tombstonedAt.get(cv.session_id);
    if (at === undefined) continue;
    const mtime = Math.floor(Number(cv.mtime) || 0);
    if (mtime > at) lift.add(cv.session_id); else dead.add(cv.session_id);
  }
  // A session that one push sends twice, once old and once new, stays dead.
  for (const id of dead) lift.delete(id);
  return { dead, lift: [...lift] };
}
