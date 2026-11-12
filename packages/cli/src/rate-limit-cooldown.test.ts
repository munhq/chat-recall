/**
 * A rate-limited or oversized walk must not open the circuit breaker.
 *
 * This is the second guard of issue #16. The server now answers 429 +
 * Retry-After when its ingest is full, and 413 when one body is above the cap.
 * If either counted as a target failure, the collector would enter a 1–15
 * minute cooldown exactly while the server was recovering, and the two fixes
 * would cancel each other out.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { classifyError, countsForBreaker } from './sync-client.js';
import { noteTargetFailure, breakerState, _resetBreakers, TRIP_AFTER_FAILURES } from './target-breaker.js';

const SERVER = 'https://chatrecall.dev';

/** The exact shape the server answers when its ingest is full. */
const BUSY = 'append sync failed: HTTP 429 {"error":"ingest is busy — retry shortly","code":"ingest_busy","retry_after_ms":2000}';
/** The exact shape it answers for one body above the cap. */
const TOO_BIG = 'append sync failed: HTTP 413 {"error":"ingest body is 40000000 bytes, above the 8388608 byte limit","code":"body_too_large","max_bytes":8388608}';
/** A real outage, which MUST still count. */
const DOWN = 'append sync failed: HTTP 502 <html>Bad gateway</html>';

beforeEach(() => _resetBreakers());

/** Drive the walk's decision exactly as packages/cli/src/sync-client.ts does. */
function walkFailure(message: string): boolean {
  const cls = classifyError(message);
  if (countsForBreaker(cls)) noteTargetFailure(SERVER, message);
  return breakerState(SERVER).open;
}

describe('countsForBreaker', () => {
  test('a 429 is classified rate_limited and does not count', () => {
    expect(classifyError(BUSY)).toBe('rate_limited');
    expect(countsForBreaker('rate_limited')).toBe(false);
  });

  test('a 413 body_too_large is classified payload_too_large and does not count', () => {
    expect(classifyError(TOO_BIG)).toBe('payload_too_large');
    expect(countsForBreaker('payload_too_large')).toBe(false);
  });

  test('a 502 still counts', () => {
    expect(classifyError(DOWN)).toBe('server_error');
    expect(countsForBreaker('server_error')).toBe(true);
  });
});

describe('the breaker', () => {
  test('ten consecutive 429 walks leave the target out of cooldown', () => {
    let open = false;
    for (let i = 0; i < 10; i++) open = walkFailure(BUSY);
    expect(open).toBe(false);
    expect(breakerState(SERVER).open).toBe(false);
  });

  test('ten consecutive oversized-body walks leave the target out of cooldown', () => {
    let open = false;
    for (let i = 0; i < 10; i++) open = walkFailure(TOO_BIG);
    expect(open).toBe(false);
  });

  test('a run of 429s does not hide a real outage that follows it', () => {
    for (let i = 0; i < 10; i++) walkFailure(BUSY);
    expect(breakerState(SERVER).open).toBe(false);
    // The streak starts from zero, so an outage still needs its own full count.
    for (let i = 0; i < TRIP_AFTER_FAILURES - 1; i++) expect(walkFailure(DOWN)).toBe(false);
    expect(walkFailure(DOWN)).toBe(true);
  });
});
