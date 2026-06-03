import { describe, it, expect } from 'vitest';
import { isQuotaError, parseQuotaRetryMs } from './quota-detect.js';

describe('isQuotaError', () => {
  it('matches QUOTA_EXHAUSTED reason', () => {
    expect(isQuotaError("reason: 'QUOTA_EXHAUSTED'")).toBe(true);
  });
  it('matches the Gemini human-readable phrase', () => {
    expect(isQuotaError('You have exhausted your capacity on this model.')).toBe(true);
  });
  it('matches HTTP 429', () => {
    expect(isQuotaError('Error: 429 Too Many Requests')).toBe(true);
  });
  it('matches rate-limit phrasing', () => {
    expect(isQuotaError('rate limit reached')).toBe(true);
    expect(isQuotaError('rate-limit hit')).toBe(true);
  });
  it('does not match unrelated errors', () => {
    expect(isQuotaError('Command failed: cat /tmp/foo | gemini')).toBe(false);
    expect(isQuotaError('Generated summary too short')).toBe(false);
    expect(isQuotaError('')).toBe(false);
  });
});

describe('parseQuotaRetryMs', () => {
  it('parses h/m/s reset phrasing', () => {
    expect(parseQuotaRetryMs('Your quota will reset after 1h20m49s.')).toBe(
      ((1 * 3600) + (20 * 60) + 49) * 1000
    );
    expect(parseQuotaRetryMs('reset after 9h13m42s')).toBe(
      ((9 * 3600) + (13 * 60) + 42) * 1000
    );
  });
  it('parses partial reset phrasing', () => {
    expect(parseQuotaRetryMs('reset after 30s')).toBe(30_000);
    expect(parseQuotaRetryMs('reset after 5m')).toBe(5 * 60_000);
    expect(parseQuotaRetryMs('reset after 2h')).toBe(2 * 3_600_000);
  });
  it('parses retryDelayMs', () => {
    expect(parseQuotaRetryMs('retryDelayMs: 4849385.100621')).toBe(4_849_385);
    expect(parseQuotaRetryMs("retryDelayMs: '60000'")).toBe(60_000);
  });
  it('returns null when nothing parseable', () => {
    expect(parseQuotaRetryMs('Command failed')).toBeNull();
    expect(parseQuotaRetryMs('')).toBeNull();
    expect(parseQuotaRetryMs('reset after')).toBeNull();
  });
});
