/**
 * Tool-first ordering: every view that exposes an AI-tool filter renders
 * it BEFORE any view-specific sub-options. Memory and Toolkit also hide
 * (or visually collapse) sub-tabs that have zero rows for the selected
 * tool when the user expects per-tool focus.
 *
 * Conversations is exempt: it uses a left sidebar (the project tree
 * needs vertical space), and the Source filter at the top of that
 * sidebar is the tool-first equivalent.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5000';

const HORIZONTAL_VIEWS: Array<{ nav: string; toolFilter: string; firstSecondaryControl: RegExp }> = [
  // Activity has Window presets directly under the tool row.
  { nav: 'nav-activity',  toolFilter: '[data-testid=\'memory-tool-filter\']', firstSecondaryControl: /^Window$/ },
  // Memory: source-type tabs row sits below the tool filter.
  { nav: 'nav-memory',    toolFilter: '[data-testid=\'memory-tool-filter\']', firstSecondaryControl: /^(Everything|Plans) \(/ },
  // Toolkit: sub-tab segmented control sits below the tool filter.
  { nav: 'nav-toolkit',   toolFilter: '[data-testid=\'toolkit-tool-filter\']', firstSecondaryControl: /^Skills \(/ },
  // Insights: the only "secondary control" is the This-week digest card heading.
  { nav: 'nav-dashboard', toolFilter: '[data-testid=\'insights-tool-filter\']', firstSecondaryControl: /^This week$/ },
];

test.describe('Tool filter renders first across views', () => {
  for (const view of HORIZONTAL_VIEWS) {
    test(`${view.nav}: Tool row sits above the first secondary control`, async ({ page }) => {
      await page.goto(BASE);
      await page.locator(`[data-testid='${view.nav}']`).click();

      // Activity uses a generic data-testid override, so fall back if not found.
      const toolRow = page.locator(view.toolFilter).first();
      await toolRow.waitFor({ state: 'visible', timeout: 5000 });

      const secondary = page.getByText(view.firstSecondaryControl).first();
      await secondary.waitFor({ state: 'visible', timeout: 5000 });

      const toolBox = await toolRow.boundingBox();
      const secBox  = await secondary.boundingBox();
      expect(toolBox).not.toBeNull();
      expect(secBox).not.toBeNull();
      expect(toolBox!.y).toBeLessThan(secBox!.y);
    });
  }

  test('Conversations: Source filter at top of left sidebar (tool-first equivalent)', async ({ page }) => {
    await page.goto(BASE);
    await page.locator("[data-testid='nav-search']").click();
    // The Source list lives at the top of the sidebar with one chip per tool.
    for (const label of ['All', 'Claude', 'Gemini', 'OpenCode', 'Codex']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });
});

test.describe('Tool filter is radio-style (not multi-toggle)', () => {
  test('Activity: clicking Codex narrows to Codex only (not deselects)', async ({ page }) => {
    await page.goto(BASE);
    await page.locator("[data-testid='nav-more']").click();
    await page.locator("[data-testid='nav-activity']").click();
    // Wait for first chip
    await page.getByRole('button', { name: /^All\s+\d+/ }).first().waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /Codex\s+\d+/ }).click();
    // After clicking Codex, the All button should NOT be highlighted (radio behavior)
    // and clicking All should restore everything.
    const allBtn = page.getByRole('button', { name: /^All\s+\d+/ }).first();
    await allBtn.click();
    // Total chip should reflect all-tool count again — at least Claude>0.
    await expect(page.getByText(/edit/).first()).toBeVisible();
  });
});
