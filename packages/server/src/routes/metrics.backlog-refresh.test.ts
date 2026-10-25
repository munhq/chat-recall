import { describe, expect, test } from 'vitest';
import { backlogRefreshMs, DEFAULT_BACKLOG_REFRESH_MS } from './metrics.js';

describe('backlogRefreshMs', () => {
  test('defaults to two minutes when the variable is unset or invalid', () => {
    expect(backlogRefreshMs(undefined)).toBe(DEFAULT_BACKLOG_REFRESH_MS);
    expect(backlogRefreshMs('')).toBe(120_000);
    expect(backlogRefreshMs('soon')).toBe(120_000);
  });

  test('uses a valid value from the variable', () => {
    expect(backlogRefreshMs('30000')).toBe(30_000);
  });

  test('never goes below five seconds', () => {
    expect(backlogRefreshMs('100')).toBe(5000);
  });
});
