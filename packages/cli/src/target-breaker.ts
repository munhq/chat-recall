/**
 * Stop hammering a server that is not answering.
 *
 * ── The behaviour this replaces ───────────────────────────────────────────
 * Every walk tried every configured target, in full, forever. A target that was
 * down did not merely fail — it failed SLOWLY, once per session, inside the same
 * serial walk as the healthy one: connect timeout, three retries with 2s/8s/30s
 * backoff, then the next session. One measured log carried 1,772 `fetch failed`
 * and 3,526 HTTP 429 and was still producing them at 26–38 per hour, days later.
 *
 * The cost lands on the wrong target. Because targets are walked in sequence, a
 * dead LAN box delays every ship to the healthy SaaS host behind it, and the
 * whole walk's completion — which is what the ledger, the health file and the
 * progress report all wait on.
 *
 * ── The rule ─────────────────────────────────────────────────────────────
 * Consecutive whole-walk failures trip the breaker. It stays open for a
 * doubling cooldown, capped, and one success closes it completely.
 *
 * Deliberately counted per WALK, not per request. A single walk already retries
 * internally and obeys Retry-After; failing individual requests are normal
 * operation and must not trip anything. What "the target is down" actually looks
 * like is a whole walk failing, repeatedly.
 *
 * Process-lifetime only, and that is the right lifetime: a restart is exactly
 * when you want to retry a target you gave up on. Nothing is persisted.
 *
 * A tripped breaker is never silent. It is reported to the health file so the
 * user hears "this server is being skipped" instead of watching a target quietly
 * never sync.
 */

/** Consecutive failed walks before a target is skipped. */
export const TRIP_AFTER_FAILURES = Number(process.env.CHAT_RECALL_BREAKER_TRIP) || 3;
/** First cooldown, doubled per subsequent failure. */
export const BASE_COOLDOWN_MS = Number(process.env.CHAT_RECALL_BREAKER_COOLDOWN_MS) || 60_000;
/** Ceiling, so a target is always retried eventually. */
export const MAX_COOLDOWN_MS = Number(process.env.CHAT_RECALL_BREAKER_MAX_MS) || 15 * 60_000;

interface State { failures: number; openUntil: number; lastError: string }

const state = new Map<string, State>();

/** Test seam. */
export function _resetBreakers(): void { state.clear(); }

const key = (serverUrl: string): string => serverUrl.replace(/\/+$/, '');

/** Cooldown for the Nth consecutive failure, doubling and capped. */
export function cooldownFor(failures: number): number {
  const over = Math.max(0, failures - TRIP_AFTER_FAILURES);
  return Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** over);
}

export interface BreakerVerdict {
  /** True when this target should be skipped right now. */
  open: boolean;
  /** Milliseconds until the next attempt. 0 when closed. */
  retryInMs: number;
  failures: number;
  lastError: string;
  /**
   * True only for the failure that OPENS a new incident.
   *
   * A tripped breaker re-opens on every attempt until a success clears it, so a
   * caller that reports "tripped" on each open verdict counts elapsed time, not
   * incidents. One device reported 823 trips for ONE LAN box that was switched
   * off — 96 a day, for as long as the box stayed off — and the fleet panel read
   * that back as if 823 separate things had gone wrong.
   *
   * `failures` is the number to read for "how bad is it"; this flag is the one
   * to count.
   */
  tripped: boolean;
}

/** Should this target be skipped? */
export function breakerState(serverUrl: string, now = Date.now()): BreakerVerdict {
  const s = state.get(key(serverUrl));
  if (!s || s.openUntil <= now) {
    return { open: false, retryInMs: 0, failures: s?.failures ?? 0, lastError: s?.lastError ?? '', tripped: false };
  }
  return { open: true, retryInMs: s.openUntil - now, failures: s.failures, lastError: s.lastError, tripped: false };
}

/** A walk against this target completed. Clear everything. */
export function noteTargetSuccess(serverUrl: string): void {
  state.delete(key(serverUrl));
}

/**
 * A walk against this target failed. Returns the verdict for the NEXT attempt,
 * so the caller can report "skipping for 4m" in the same breath as the failure.
 */
export function noteTargetFailure(serverUrl: string, error: string, now = Date.now()): BreakerVerdict {
  const k = key(serverUrl);
  const prior = state.get(k);
  const failures = (prior?.failures ?? 0) + 1;
  const lastError = error.slice(0, 200);
  if (failures < TRIP_AFTER_FAILURES) {
    // Not yet a pattern — a single failed walk is ordinary.
    state.set(k, { failures, openUntil: 0, lastError });
    return { open: false, retryInMs: 0, failures, lastError, tripped: false };
  }
  const cooldown = cooldownFor(failures);
  state.set(k, { failures, openUntil: now + cooldown, lastError });
  // Exactly AT the threshold is the transition into a new incident. Every later
  // failure re-opens the SAME incident, because only a success clears `state`.
  return { open: true, retryInMs: cooldown, failures, lastError, tripped: failures === TRIP_AFTER_FAILURES };
}

/** One line for the log, or null when there is nothing to say. */
export function breakerNotice(serverUrl: string, v: BreakerVerdict): string | null {
  if (!v.open) return null;
  const mins = Math.max(1, Math.round(v.retryInMs / 60_000));
  return `skipping ${serverUrl} — ${v.failures} consecutive failed sync(s), next attempt in ~${mins}m`
    + (v.lastError ? ` (last error: ${v.lastError})` : '');
}
