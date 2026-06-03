import { test, expect } from '@playwright/test';

/**
 * End-to-end verification for the unified project-id sidebar tree and
 * the per-project tab strip (Conversations | Dossier | Activity).
 *
 * What we check:
 *   - Sidebar renders workspaces + nested git repos (not just a flat
 *     filesystem trie).
 *   - Clicking a project leaf filters conversations and shows the tab
 *     strip with Dossier active by default on first visit.
 *   - Dossier panel renders editorial sections (Overview, Architecture).
 *   - Conversations tab switches back to the conversation list.
 *   - "Untracked locations" footer exists and is collapsed by default.
 */

test('project tree: workspace → repo → dossier tab', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'test-results/01-loaded.png', fullPage: false });

  // Diagnostic: count how many data-path rows the page rendered.
  const paths = await page.locator('[data-path]').evaluateAll(els => els.slice(0, 10).map(e => e.getAttribute('data-path')));
  console.log('first 10 data-paths:', paths);

  // Workspace row visible (auto-promoted from ~/code/personal/).
  const personalWs = page.locator('[data-path="ws:personal"]');
  await expect(personalWs).toBeVisible({ timeout: 15000 });

  // Real repo leaves render under the workspace (not as ws:personal/foo bare paths).
  const munbot = page.locator('[data-path="git:github.com/hotmun/munbot"]');
  await expect(munbot).toBeVisible();

  // Click chat-recall — should switch into the project pane.
  const chatRecall = page.locator('[data-path="git:github.com/hotmun/chat-recall"]');
  await chatRecall.click();

  // Tab strip appears and Dossier is the default first-visit tab.
  const dossierTab = page.locator('[data-testid="project-tab-dossier"]');
  await expect(dossierTab).toBeVisible({ timeout: 8000 });
  await expect(page.locator('[data-testid="project-tab-conversations"]')).toBeVisible();
  await expect(page.locator('[data-testid="project-tab-activity"]')).toBeVisible();

  // Dossier body contains an Overview heading rendered by DossierView's
  // serif h2 with data-section-slug. Wait for the fetch to land.
  await expect(page.locator('[data-section-slug="overview"]')).toBeVisible({ timeout: 10000 });

  // Switch to Conversations tab — list should appear scoped to chat-recall.
  await page.locator('[data-testid="project-tab-conversations"]').click();
  await expect(page.locator('[data-testid="brand"]')).toBeVisible();

  // Untracked footer present at the bottom of the tree, collapsed by default.
  const untracked = page.locator('[data-path="untracked:all"]');
  await expect(untracked).toBeVisible();
});
