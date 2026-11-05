import { describe, expect, test } from 'vitest';
import { dashboardRefreshMs, DEFAULT_DASHBOARD_REFRESH_MS } from './metrics.js';

describe('dashboardRefreshMs', () => {
  test('defaults to one minute when the variable is unset or invalid', () => {
    expect(dashboardRefreshMs(undefined)).toBe(DEFAULT_DASHBOARD_REFRESH_MS);
    expect(dashboardRefreshMs('')).toBe(60_000);
    expect(dashboardRefreshMs('soon')).toBe(60_000);
  });

  test('uses a valid value from the variable', () => {
    expect(dashboardRefreshMs('30000')).toBe(30_000);
  });

  test('never goes below five seconds', () => {
    expect(dashboardRefreshMs('100')).toBe(5000);
  });
});
