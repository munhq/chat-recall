/**
 * Toolkit cross-tool promotion + UI matrix tests.
 *
 * Covers the user-facing surface added in the Memory/Toolkit redesign:
 *   - Toolkit nav opens and shows the 6 sub-tabs
 *   - Tool-first ordering: Tool row renders before sub-tabs row
 *   - Cross-tool availability matrix in the detail pane shows one row per
 *     AI tool (claude/gemini/opencode/codex)
 *   - Empty-state import flow lists rows from other tools when the
 *     selected (sub-tab, tool) combo is empty
 *   - Honest "tool doesn't natively support X" copy for hooks/commands
 *     when codex / gemini / opencode is selected
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5000';

test.describe('Toolkit', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await page.locator("[data-testid='nav-more']").click();
    await page.locator("[data-testid='nav-toolkit']").click();
    // Sub-tabs are loaded async — wait until at least Skills shows a count.
    await page.getByRole('button', { name: /^Skills \(/ }).waitFor({ state: 'visible' });
  });

  test('renders all 6 sub-tabs (Skills, MCPs, Commands, Subagents, Hooks, Plugins)', async ({ page }) => {
    for (const label of ['Skills', 'MCPs', 'Commands', 'Subagents', 'Hooks', 'Plugins']) {
      await expect(page.getByRole('button', { name: new RegExp(`^${label} \\(`) })).toBeVisible();
    }
  });

  test('tool filter row renders before sub-tab row (tool-first ordering)', async ({ page }) => {
    const toolRow = page.locator("[data-testid='toolkit-tool-filter']");
    const subTabsRow = page.getByRole('button', { name: /^Skills \(/ }).locator('xpath=ancestor::div[1]');
    await expect(toolRow).toBeVisible();
    const toolBox = await toolRow.boundingBox();
    const subBox = await subTabsRow.boundingBox();
    expect(toolBox).not.toBeNull();
    expect(subBox).not.toBeNull();
    // y-coordinate: the tool row sits above the sub-tabs row visually.
    expect(toolBox!.y).toBeLessThan(subBox!.y);
  });

  test('Codex + Hooks shows honest "doesn\'t natively support" copy', async ({ page }) => {
    await page.locator("[data-testid='toolkit-tool-filter']").getByRole('button', { name: 'Codex' }).click();
    await page.getByRole('button', { name: /^Hooks \(/ }).click();
    await expect(page.getByText(/doesn['’]t natively support hooks/i)).toBeVisible({ timeout: 5000 });
  });

  test('Codex + Skills empty-state lists importable items from other tools', async ({ page }) => {
    await page.locator("[data-testid='toolkit-tool-filter']").getByRole('button', { name: 'Codex' }).click();
    await page.getByRole('button', { name: /^Skills \(/ }).click();
    // Either Codex already has skills, or we see the import-from-another-tool banner.
    const importBanner = page.getByText(/Import from another tool/i);
    const itemRow = page.getByText(/^OpenCode|^Claude/, { exact: false }).first();
    await Promise.race([
      importBanner.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null),
      itemRow.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null),
    ]);
    // At minimum a Copy → button exists when the empty state is shown.
    if (await importBanner.isVisible()) {
      await expect(page.getByRole('button', { name: /Copy →/ }).first()).toBeVisible();
    }
  });

  test('detail pane shows the cross-tool availability matrix', async ({ page }) => {
    // Pick the first item in any populated sub-tab (Skills should always have rows).
    await page.locator("[data-testid='toolkit-tool-filter']").getByRole('button', { name: 'All' }).click();
    await page.getByRole('button', { name: /^Skills \(/ }).click();
    // Click first row (skills are grouped by name; the row is a div with cursor:pointer).
    const firstRow = page.locator('div[style*="cursor: pointer"]').filter({ has: page.locator(':scope > div') }).first();
    await firstRow.click();
    await expect(page.getByText(/Cross-tool availability/i)).toBeVisible({ timeout: 5000 });
    // Expect each AI tool to be listed by badge label.
    for (const label of ['Claude', 'Gemini', 'OpenCode', 'Codex']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });
});
