/**
 * What the sync badge says, and when the stale-sync banner fires.
 *
 * Both decisions used to be inline — one a JSX ternary in TopBar, the other a
 * condition inside a useEffect in CommandCenter — which is why both were wrong
 * and neither was caught. Extracted so the tests call the real thing rather
 * than a copy of it.
 *
 * The distinction the whole file turns on:
 *
 *   newestSessionAgeMs  how old your newest TRANSCRIPT is
 *   lastSyncAgeMs       how long since the COLLECTOR last reported
 *
 * They are not interchangeable, and conflating them is what produced both bugs.
 * A healthy install that nobody has coded on for a day has day-old data and a
 * minutes-old sync. Reading the first as sync health said "1h behind" on a
 * working install, and fired a red "nothing is arriving, go debug your machine"
 * banner after a two-day break.
 */

export interface SyncFacts {
  newestSessionAgeMs?: number | null;
  lastSyncAgeMs?: number | null;
  progress?: { done: number; total: number } | null;
}

export type SyncTone = 'busy' | 'ok' | 'warn' | 'unknown';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Human "how long ago", coarse on purpose: nobody needs seconds here. */
export function ago(ms: number): string {
  if (ms < 90_000) return 'just now';
  if (ms < HOUR) return `${Math.round(ms / MIN)}m ago`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h ago`;
  return `${Math.round(ms / DAY)}d ago`;
}

/**
 * The percentage shown during a walk.
 *
 * NO CLAMP TO 99. `floor(100 * done / total)` cannot reach 100 before
 * `done === total`, and that case is not "syncing" at all — the server drops
 * progress once the walk is finished. So a clamp could never bind for a real
 * in-flight walk; the previous one existed only because a finished-but-unflagged
 * walk kept reaching this code, and it turned that bug into a permanent "99%".
 */
export function syncPct(p: { done: number; total: number }): number {
  if (p.total <= 0) return 0;
  return Math.floor((100 * p.done) / p.total);
}

/** A walk is only in flight if the server said so AND it has somewhere to go. */
function inFlight(s: SyncFacts): { done: number; total: number } | null {
  return s.progress && s.progress.total > 0 ? s.progress : null;
}

/**
 * The badge text. Answers "is this working", so it reports the SYNC, and falls
 * back to data freshness only where no collector has ever reported — the one
 * case where freshness is all there is to say.
 */
export function syncLabel(s: SyncFacts): string {
  const busy = inFlight(s);
  if (busy) return `syncing ${syncPct(busy)}%`;
  if (s.lastSyncAgeMs != null) return `synced ${ago(s.lastSyncAgeMs)}`;
  if (s.newestSessionAgeMs == null) return '—';
  if (s.newestSessionAgeMs < 2 * MIN) return 'live';
  if (s.newestSessionAgeMs < HOUR) return `${Math.round(s.newestSessionAgeMs / MIN)}m behind`;
  return `${Math.round(s.newestSessionAgeMs / HOUR)}h behind`;
}

/** How recently a sync must have run before the dot stops being reassuring. */
export const SYNC_OK_MS = 15 * MIN;

export function syncTone(s: SyncFacts): SyncTone {
  if (inFlight(s)) return 'busy';
  if (s.lastSyncAgeMs != null) return s.lastSyncAgeMs < SYNC_OK_MS ? 'ok' : 'warn';
  if (s.newestSessionAgeMs == null) return 'unknown';
  return s.newestSessionAgeMs < 2 * MIN ? 'ok' : 'warn';
}

/** A collector silent this long is a real fault worth a red banner. */
export const STALE_SYNC_MS = 48 * HOUR;

/**
 * Whether to raise the "collector has not reported" banner, and for how long.
 *
 * Gated on the SYNC age. The previous version used the session age, so an idle
 * fortnight produced a red error telling a healthy install to go debug itself.
 */
export function staleSyncAlert(
  s: SyncFacts,
  activeDevices: number,
): { ageH: number } | null {
  if (activeDevices <= 0) return null;
  const age = s.lastSyncAgeMs != null
    ? s.lastSyncAgeMs
    // No collector has ever reported: the session age is the only signal there
    // is, so it stands in rather than staying silent about a real outage.
    : s.newestSessionAgeMs;
  if (age == null || age <= STALE_SYNC_MS) return null;
  return { ageH: Math.round(age / HOUR) };
}
