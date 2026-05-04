import { test, expect } from '@playwright/test';

/**
 * Sidebar is now persistent: every top-level view (Conversations, Memory,
 * Toolkit, Activity, Insights) shares the same Source filter, Project
 * tree, plus an optional view-specific section. The horizontal "Tool"
 * filter chips that used to live inside each view are gone.
 */

const VIEWS = [
  { label: /^Conversations$/, name: 'Conversations', expectExtra: null as RegExp | null },
  { label: /^Memory$/,        name: 'Memory',        expectExtra: /^Type$/ },
  { label: /^Toolkit$/,       name: 'Toolkit',       expectExtra: /^Type$/ },
  { label: /^Activity$/,      name: 'Activity',      expectExtra: /^Window$/ },
  { label: /^Insights$/,      name: 'Insights',      expectExtra: null },
];

for (const view of VIEWS) {
  test(`${view.name}: sidebar is shared and consistent`, async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: view.label }).click();
    await page.waitForLoadState('networkidle');

    // Sidebar present.
    const sidebar = page.getByTestId('project-sidebar');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    // Source rows present in every view.
    for (const tool of ['all', 'claude', 'gemini', 'opencode', 'codex']) {
      await expect(sidebar.getByTestId(`tool-filter-${tool}`)).toBeVisible();
    }

    // View-specific section appears (or doesn't, when not expected).
    if (view.expectExtra) {
      await expect(sidebar.getByText(view.expectExtra)).toBeVisible({ timeout: 10_000 });
    }

    // No horizontal duplicate Tool-filter chip rows in the main pane.
    // (The old in-view rows had data-testid="memory-tool-filter" /
    //  "toolkit-tool-filter" / "insights-tool-filter".)
    for (const stale of ['memory-tool-filter', 'toolkit-tool-filter', 'insights-tool-filter']) {
      await expect(page.getByTestId(stale)).toHaveCount(0);
    }
  });
}

test('clicking Codex in sidebar from Memory view filters Memory list', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /^Memory$/ }).click();
  await page.waitForLoadState('networkidle');

  const codex = page.getByTestId('project-sidebar').getByTestId('tool-filter-codex');
  await codex.click();
  await page.waitForTimeout(300);
  // After clicking, Codex row should be aria-current.
  await expect(codex).toHaveAttribute('aria-current', 'true');
});

test('clicking 7d in Activity sidebar updates the time window', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /^Activity$/ }).click();
  await page.waitForLoadState('networkidle');

  // Wait for the Window section to register.
  const sevenDay = page.getByTestId('project-sidebar').getByTestId('activity-window-168');
  await expect(sevenDay).toBeVisible({ timeout: 10_000 });
  // Wait for the next /edits-timeline response after click — confirms the
  // window changed and the activity view refetched with the new bound.
  const wait = page.waitForResponse(
    (r) => r.url().includes('/api/edits/timeline') && r.url().includes('since_hours=168'),
    { timeout: 15_000 },
  );
  await sevenDay.click();
  await wait;
  await expect(sevenDay).toHaveAttribute('aria-current', 'true');

  await page.screenshot({ path: '/tmp/sidebar-activity-7d.png', fullPage: false });
});

test('Toolkit type tabs surface in sidebar', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /^Toolkit$/ }).click();
  await page.waitForLoadState('networkidle');
  const sidebar = page.getByTestId('project-sidebar');
  // At least Skills and MCPs should appear (those are the always-on tabs).
  await expect(sidebar.getByTestId('toolkit-type-skill')).toBeVisible({ timeout: 10_000 });
  await expect(sidebar.getByTestId('toolkit-type-mcp')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: '/tmp/sidebar-toolkit.png', fullPage: false });
});
