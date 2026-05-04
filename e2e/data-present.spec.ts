import { test, expect } from '@playwright/test';

/**
 * Sanity test: it's not enough to verify the API returns 200. The user
 * cares about whether there's content. After a full reindex the
 * sidebar Type counts must be > 0 for the major source types we know
 * exist on disk. This is the test we should have had before claiming
 * "everything works".
 */

test('memory + toolkit sidebar show non-zero counts', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Memory view
  await page.getByRole('button', { name: /^Memory$/ }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);

  const memStatus = await page.request.get('/api/memory/status');
  expect(memStatus.status()).toBe(200);
  const m = await memStatus.json();
  console.log('memory totals:', m.totalItems, Object.keys(m.bySourceType || {}));
  expect(m.totalItems, 'memory totalItems > 0').toBeGreaterThan(0);
  // We expect at LEAST sessions, plans, claude_md, mcp, skill, plugin to all
  // be populated. (Not every install has tasks/diary/paste; don't assert
  // those.)
  for (const t of ['session', 'plan', 'claude_md', 'mcp', 'skill', 'plugin']) {
    const n = m.bySourceType?.[t]?.items ?? 0;
    console.log(' ', t, '=', n);
    expect(n, `memory.${t} > 0`).toBeGreaterThan(0);
  }

  // Toolkit view
  await page.getByRole('button', { name: /^Toolkit$/ }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);

  const tk = await page.request.get('/api/toolkit/status');
  expect(tk.status()).toBe(200);
  const t = await tk.json();
  for (const type of ['skill', 'mcp', 'plugin']) {
    const total = (t.counts?.[type]?.claude ?? 0) +
                  (t.counts?.[type]?.opencode ?? 0) +
                  (t.counts?.[type]?.codex ?? 0) +
                  (t.counts?.[type]?.gemini ?? 0);
    console.log(' toolkit.', type, '=', total);
    expect(total, `toolkit.${type} > 0`).toBeGreaterThan(0);
  }
});
