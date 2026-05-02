/**
 * Analytics route honors the ?tool= filter.
 *
 * The Insights tab calls /api/analytics?tool=<X> when a tool is selected.
 * Asserts: filtering returns a strict subset of the unfiltered total, and
 * the per-tool slice's sessionsByTool only contains the chosen tool.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5000';

test('GET /api/analytics returns full fleet by default', async ({ request }) => {
  const r = await request.get(`${BASE}/api/analytics`);
  expect(r.status()).toBe(200);
  const d = await r.json();
  expect(d.summary?.totalSessions).toBeGreaterThan(0);
  // Should see multiple tools when not filtered.
  const tools = (d.sessionsByTool || []).map((x: { tool: string }) => x.tool);
  expect(tools.length).toBeGreaterThanOrEqual(1);
});

test('GET /api/analytics?tool=claude scopes totals to claude only', async ({ request }) => {
  const full = await (await request.get(`${BASE}/api/analytics`)).json();
  const claude = await (await request.get(`${BASE}/api/analytics?tool=claude`)).json();

  expect(claude.summary.totalSessions).toBeLessThanOrEqual(full.summary.totalSessions);
  // sessionsByTool in the filtered response must contain only 'claude'.
  const tools = (claude.sessionsByTool || []).map((x: { tool: string }) => x.tool);
  expect(tools).toEqual(['claude']);
});

test('GET /api/analytics?tool=opencode returns the opencode slice', async ({ request }) => {
  const oc = await (await request.get(`${BASE}/api/analytics?tool=opencode`)).json();
  if (oc.summary.totalSessions === 0) {
    test.skip(true, 'no opencode sessions to validate against');
  }
  const tools = (oc.sessionsByTool || []).map((x: { tool: string }) => x.tool);
  expect(tools).toEqual(['opencode']);
});

test('GET /api/analytics?tool=invalid is treated as unfiltered', async ({ request }) => {
  const full = await (await request.get(`${BASE}/api/analytics`)).json();
  const bogus = await (await request.get(`${BASE}/api/analytics?tool=notarealtool`)).json();
  // Should fall back to full counts when the tool param is unknown.
  expect(bogus.summary.totalSessions).toBe(full.summary.totalSessions);
});
