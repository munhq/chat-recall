/**
 * A dead sync target must cost one log line, not a retry storm per session.
 *
 * Targets are walked in SEQUENCE, so a target that is down does not just fail —
 * it fails slowly (connect timeout, then 2s/8s/30s backoff) once per session,
 * inside the same walk as the healthy one, delaying every ship behind it and
 * delaying the walk's completion, which the ledger, the health file and the
 * progress report all wait on. One measured log carried 1,772 `fetch failed`
 * and 3,526 HTTP 429, still arriving days later at 26–38/hour.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import {
  breakerState, noteTargetFailure, noteTargetSuccess, breakerNotice,
  cooldownFor, _resetBreakers,
  TRIP_AFTER_FAILURES, BASE_COOLDOWN_MS, MAX_COOLDOWN_MS,
} from './target-breaker.js';

const URL_A = 'https://a.test';
const URL_B = 'http://192.168.1.9:8085';

beforeEach(() => { _resetBreakers(); });

describe('tripping', () => {
  test('an unknown target is closed — nothing is skipped by default', () => {
    expect(breakerState(URL_A).open).toBe(false);
  });

  // A single failed walk is ordinary: the network blipped, the server restarted.
  // Tripping on one would make the collector give up constantly.
  test('failures below the threshold do not trip it', () => {
    for (let i = 1; i < TRIP_AFTER_FAILURES; i++) {
      expect(noteTargetFailure(URL_A, 'fetch failed').open).toBe(false);
      expect(breakerState(URL_A).open).toBe(false);
    }
  });

  test('the threshold-th consecutive failure opens it', () => {
    for (let i = 1; i < TRIP_AFTER_FAILURES; i++) noteTargetFailure(URL_A, 'fetch failed');
    const v = noteTargetFailure(URL_A, 'fetch failed');
    expect(v.open).toBe(true);
    expect(v.failures).toBe(TRIP_AFTER_FAILURES);
    expect(breakerState(URL_A).open).toBe(true);
  });

  test('one success closes it completely — not partially', () => {
    for (let i = 0; i < TRIP_AFTER_FAILURES + 3; i++) noteTargetFailure(URL_A, 'boom');
    expect(breakerState(URL_A).open).toBe(true);
    noteTargetSuccess(URL_A);
    const v = breakerState(URL_A);
    expect(v.open).toBe(false);
    // The count must reset too, or the next single blip re-trips instantly.
    expect(v.failures).toBe(0);
  });

  test('targets are independent — one dead server does not skip the healthy one', () => {
    for (let i = 0; i < TRIP_AFTER_FAILURES; i++) noteTargetFailure(URL_B, 'ECONNREFUSED');
    expect(breakerState(URL_B).open).toBe(true);
    expect(breakerState(URL_A).open).toBe(false);
  });

  test('a trailing slash is the same target', () => {
    for (let i = 0; i < TRIP_AFTER_FAILURES; i++) noteTargetFailure('https://a.test/', 'boom');
    expect(breakerState(URL_A).open).toBe(true);
  });
});

describe('cooldown', () => {
  test('it reopens on its own once the cooldown expires', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < TRIP_AFTER_FAILURES; i++) noteTargetFailure(URL_A, 'boom', t0);
    expect(breakerState(URL_A, t0 + 1).open).toBe(true);
    expect(breakerState(URL_A, t0 + BASE_COOLDOWN_MS + 1).open).toBe(false);
  });

  test('it backs off by doubling', () => {
    expect(cooldownFor(TRIP_AFTER_FAILURES)).toBe(BASE_COOLDOWN_MS);
    expect(cooldownFor(TRIP_AFTER_FAILURES + 1)).toBe(BASE_COOLDOWN_MS * 2);
    expect(cooldownFor(TRIP_AFTER_FAILURES + 2)).toBe(BASE_COOLDOWN_MS * 4);
  });

  // A target must always be retried eventually — a permanently-open breaker is
  // indistinguishable from silently dropping a server the user configured.
  test('the cooldown is capped, so a target is never abandoned forever', () => {
    expect(cooldownFor(TRIP_AFTER_FAILURES + 50)).toBe(MAX_COOLDOWN_MS);
    expect(MAX_COOLDOWN_MS).toBeLessThanOrEqual(60 * 60_000);
  });
});

describe('the user is told', () => {
  test('an open breaker produces a line naming the server, the count and the wait', () => {
    let v = breakerState(URL_A);
    expect(breakerNotice(URL_A, v)).toBeNull();      // silent while healthy

    for (let i = 0; i < TRIP_AFTER_FAILURES - 1; i++) noteTargetFailure(URL_A, 'fetch failed');
    v = noteTargetFailure(URL_A, 'connect ETIMEDOUT');
    const notice = breakerNotice(URL_A, v)!;
    expect(notice).toContain(URL_A);
    expect(notice).toContain(String(TRIP_AFTER_FAILURES));
    expect(notice).toContain('next attempt');
    // The last error is what makes it actionable rather than just discouraging.
    expect(notice).toContain('connect ETIMEDOUT');
  });

  test('a long error is truncated, not pasted whole into every log line', () => {
    for (let i = 0; i < TRIP_AFTER_FAILURES - 1; i++) noteTargetFailure(URL_A, 'x');
    const v = noteTargetFailure(URL_A, 'E'.repeat(5000));
    expect(v.lastError.length).toBeLessThanOrEqual(200);
  });
});

/**
 * ONE INCIDENT IS ONE TRIP.
 *
 * A tripped breaker re-opens on every attempt until a success clears it, so a
 * caller that counts "open" verdicts measures how long a box stayed off, not how
 * often anything went wrong. A LAN box switched off for six days produced 823
 * "breaker trips" — 96 a day — and the fleet panel reported them as 823 separate
 * failures against an unnamed "sync target".
 */
describe('tripped marks the transition, not the state', () => {
  test('only the failure that crosses the threshold is a trip', () => {
    for (let i = 0; i < TRIP_AFTER_FAILURES - 1; i++) {
      expect(noteTargetFailure(URL_B, 'ECONNREFUSED').tripped).toBe(false);
    }
    const first = noteTargetFailure(URL_B, 'ECONNREFUSED');
    expect(first.open).toBe(true);
    expect(first.tripped).toBe(true);
  });

  test('every later failure re-opens the SAME incident', () => {
    for (let i = 0; i < TRIP_AFTER_FAILURES; i++) noteTargetFailure(URL_B, 'ECONNREFUSED');
    // 100 more failed walks against a box that is still off.
    for (let i = 0; i < 100; i++) {
      const v = noteTargetFailure(URL_B, 'ECONNREFUSED');
      expect(v.open).toBe(true);
      expect(v.tripped).toBe(false);
    }
    // The STREAK is where the severity lives, and it kept counting.
    expect(breakerState(URL_B).failures).toBe(TRIP_AFTER_FAILURES + 100);
  });

  test('a success ends the incident, so the next one trips again', () => {
    for (let i = 0; i < TRIP_AFTER_FAILURES; i++) noteTargetFailure(URL_B, 'ECONNREFUSED');
    noteTargetSuccess(URL_B);
    for (let i = 0; i < TRIP_AFTER_FAILURES - 1; i++) {
      expect(noteTargetFailure(URL_B, 'ECONNREFUSED').tripped).toBe(false);
    }
    expect(noteTargetFailure(URL_B, 'ECONNREFUSED').tripped).toBe(true);
  });

  test('a plain state read never claims a trip', () => {
    for (let i = 0; i < TRIP_AFTER_FAILURES; i++) noteTargetFailure(URL_B, 'ECONNREFUSED');
    expect(breakerState(URL_B).open).toBe(true);
    expect(breakerState(URL_B).tripped).toBe(false);
  });
});
