/**
 * Project sidebar tree grouping.
 *
 * Intercepts `/api/status` with a controlled fixture that reproduces the
 * "Flat Parent Trapping" bug (a folder that is both a project and a
 * parent of other projects) and asserts the recursive tree never
 * duplicates a folder.
 *
 * Works regardless of the user's real indexed data or host OS.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

const STATUS_FIXTURE = {
  totalChunks: 42,
  totalSessions: 14,
  indexPath: '/tmp/fake-index',
  projects: {
    // `munbot` is itself a project AND has children — this is the bug trigger.
    '/home/user/code/personal/munbot': 5,
    '/home/user/code/personal/munbot/dashboard': 3,
    '/home/user/code/personal/munbot/api': 2,
    '/home/user/code/personal/chat-recall': 4,
    // Two projects under acme → acme becomes a folder with two leaves.
    '/home/user/code/acme/starter': 1,
    '/home/user/code/acme/platform': 2,
  },
};

async function mockApi(page: Page) {
  await page.route('**/api/status', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(STATUS_FIXTURE),
    })
  );
  // Block streaming endpoint to keep the test deterministic.
  await page.route('**/api/status/stream', (route: Route) => route.abort());
  // Give recent sessions an empty response so the list column renders quickly.
  await page.route('**/api/conversations/recent**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions: [], count: 0 }),
    })
  );
}

test.describe('Project sidebar tree', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="project-all"]', { timeout: 15000 });
  });

  test('renders "All Projects" with the aggregate count from the fixture', async ({ page }) => {
    const total = Object.values(STATUS_FIXTURE.projects).reduce((s, n) => s + n, 0);
    const allProjects = page.getByTestId('project-all');
    await expect(allProjects).toContainText('All Projects');
    await expect(allProjects).toContainText(String(total));
  });

  test('collapses shared /home/user/code prefix and renders categories as top level', async ({ page }) => {
    // `personal` and `acme` sit directly under the shared prefix and
    // should be the top-level folders. `home`, `user`, and `code` are
    // transparent chain links and must not appear as their own rows.
    const allRows = page.locator('[data-testid="project-folder"], [data-testid="project-item"]');
    const paths = await allRows.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-path') || '')
    );
    expect(paths).toContain('/home/user/code/personal');
    expect(paths).toContain('/home/user/code/acme');
    expect(paths).not.toContain('/home');
    expect(paths).not.toContain('/home/user');
    expect(paths).not.toContain('/home/user/code');
  });

  test('munbot is rendered ONCE as a folder, never duplicated as a leaf', async ({ page }) => {
    const munbotFolder = page.locator('[data-path="/home/user/code/personal/munbot"]');
    await expect(munbotFolder).toHaveCount(1);
    await expect(munbotFolder).toHaveAttribute('data-testid', 'project-folder');

    // No project-item leaf should point at the munbot folder path itself.
    const leafAtMunbotPath = page.locator(
      '[data-testid="project-item"][data-path="/home/user/code/personal/munbot"]'
    );
    await expect(leafAtMunbotPath).toHaveCount(0);
  });

  test('munbot folder total aggregates its own sessions plus descendants', async ({ page }) => {
    // munbot(5) + dashboard(3) + api(2) = 10
    const munbotFolder = page.locator('[data-path="/home/user/code/personal/munbot"]');
    await expect(munbotFolder).toContainText('10');
  });

  test('dashboard and api render as nested leaves inside munbot, not top level', async ({ page }) => {
    const dashboard = page.locator('[data-path="/home/user/code/personal/munbot/dashboard"]');
    const api = page.locator('[data-path="/home/user/code/personal/munbot/api"]');

    await expect(dashboard).toHaveCount(1);
    await expect(api).toHaveCount(1);
    await expect(dashboard).toHaveAttribute('data-testid', 'project-item');
    await expect(api).toHaveAttribute('data-testid', 'project-item');
  });

  test('children sort folders before leaves, alphabetic within each group', async ({ page }) => {
    // Top level: acme and personal are both folders → alphabetic order.
    const topPaths = await page
      .locator('[data-testid="project-folder"], [data-testid="project-item"]')
      .evaluateAll((nodes) =>
        nodes
          .filter((n) => {
            // Pick top-level rows by their left padding (depth 0 → 8px).
            const pl = parseFloat(getComputedStyle(n as HTMLElement).paddingLeft);
            return pl < 14;
          })
          .map((n) => n.getAttribute('data-path') || '')
      );
    expect(topPaths).toEqual([
      '/home/user/code/acme',
      '/home/user/code/personal',
    ]);

    // Inside `personal`: munbot (folder) must come before chat-recall (leaf).
    const personalChildren = await page
      .locator(
        '[data-path^="/home/user/code/personal/"]:not([data-path*="/munbot/"])'
      )
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-path') || ''));
    expect(personalChildren).toEqual([
      '/home/user/code/personal/munbot',
      '/home/user/code/personal/chat-recall',
    ]);
  });

  test('chat-recall (single leaf under personal) is a project-item, not a folder', async ({ page }) => {
    const chatRecall = page.locator('[data-path="/home/user/code/personal/chat-recall"]');
    await expect(chatRecall).toHaveCount(1);
    await expect(chatRecall).toHaveAttribute('data-testid', 'project-item');
  });

  test('clicking a folder filters by its path (prefix match on server)', async ({ page }) => {
    let lastFilter: string | null = null;
    await page.route('**/api/conversations/recent**', (route) => {
      const url = new URL(route.request().url());
      lastFilter = url.searchParams.get('project');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessions: [], count: 0 }),
      });
    });

    const munbotFolder = page.locator('[data-path="/home/user/code/personal/munbot"]');
    await munbotFolder.click();

    await expect.poll(() => lastFilter).toBe('/home/user/code/personal/munbot');
  });

  test('chevron toggles expansion without triggering filter selection', async ({ page }) => {
    const munbotFolder = page.locator('[data-path="/home/user/code/personal/munbot"]');
    const dashboard = page.locator('[data-path="/home/user/code/personal/munbot/dashboard"]');

    // Dashboard is visible initially (top-level folders render open).
    await expect(dashboard).toBeVisible();

    // Clicking the chevron inside munbot should collapse it.
    const chevron = munbotFolder.locator('[data-testid="tree-chevron"]');
    await chevron.click();
    await expect(dashboard).toBeHidden();

    // And clicking again should re-expand.
    await chevron.click();
    await expect(dashboard).toBeVisible();
  });
});

test.describe('Project sidebar tree — edge cases', () => {
  test('handles a single deep project path without crashing', async ({ page }) => {
    await page.route('**/api/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalChunks: 1,
          totalSessions: 1,
          indexPath: '/tmp/x',
          projects: { '/home/user/code/personal/only-one': 1 },
        }),
      })
    );
    await page.route('**/api/status/stream', (r) => r.abort());
    await page.route('**/api/conversations/recent**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '{"sessions":[],"count":0}' })
    );

    await page.goto('/');
    await page.waitForSelector('[data-testid="project-all"]');

    // Single project collapses to a single top-level leaf.
    const leaves = page.getByTestId('project-item');
    await expect(leaves).toHaveCount(1);
  });

  test('handles disjoint roots (linux + external mount)', async ({ page }) => {
    await page.route('**/api/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalChunks: 2,
          totalSessions: 2,
          indexPath: '/tmp/x',
          projects: {
            '/home/user/code/foo': 1,
            '/mnt/external/work/bar': 1,
          },
        }),
      })
    );
    await page.route('**/api/status/stream', (r) => r.abort());
    await page.route('**/api/conversations/recent**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '{"sessions":[],"count":0}' })
    );

    await page.goto('/');
    await page.waitForSelector('[data-testid="project-all"]');

    // Two disjoint trees: both paths should appear as leaves/nodes
    // (no common prefix to strip beyond "/").
    const foo = page.locator('[data-path="/home/user/code/foo"]');
    const bar = page.locator('[data-path="/mnt/external/work/bar"]');
    await expect(foo).toHaveCount(1);
    await expect(bar).toHaveCount(1);
  });
});
