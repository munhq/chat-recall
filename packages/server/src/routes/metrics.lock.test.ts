/**
 * Which database errors the metrics path is allowed to swallow.
 *
 * A monitoring read holds ACCESS SHARE across several tables for the length of
 * its transaction, and the migrate init container ALTERs those tables on every
 * pod start — which the autoscaler triggers routinely. Production logged
 * `deadlock detected` on the scrape twice in two hours. The scrape now yields:
 * it sets a lock budget, skips the tenant it could not read, and keeps serving.
 *
 * The risk in that design is swallowing too much. A real fault — a missing
 * column, a broken pool, a syntax error — must still surface as an error,
 * because a silently degraded metrics endpoint blinds the KEDA scalers that
 * read it. So the predicate is pinned to exactly three SQLSTATEs.
 */
import { describe, test, expect } from 'vitest';
import { isLockContention } from './metrics.js';

const pgErr = (code: string) => Object.assign(new Error(`pg error ${code}`), { code });

describe('isLockContention', () => {
  test('yields to the three contention states, and nothing else', () => {
    expect(isLockContention(pgErr('40P01'))).toBe(true);   // deadlock_detected
    expect(isLockContention(pgErr('55P03'))).toBe(true);   // lock_not_available
    expect(isLockContention(pgErr('57014'))).toBe(true);   // query_canceled
  });

  test('a real fault is never swallowed', () => {
    for (const code of [
      '42703',   // undefined_column — a migration that has not landed yet
      '42P01',   // undefined_table
      '42601',   // syntax_error
      '53300',   // too_many_connections
      '08006',   // connection_failure
      '40001',   // serialization_failure — a retry case, not a skip case
    ]) {
      expect(isLockContention(pgErr(code)), code).toBe(false);
    }
  });

  test('a non-pg error has no code and is not contention', () => {
    expect(isLockContention(new Error('boom'))).toBe(false);
    expect(isLockContention(null)).toBe(false);
    expect(isLockContention(undefined)).toBe(false);
    expect(isLockContention('40P01')).toBe(false);   // a bare string, not an error
  });
});
