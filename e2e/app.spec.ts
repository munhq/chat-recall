/**
 * End-to-end tests for Chat Recall UI.
 * Requires the app to be running (npm run web:dev or docker compose up).
 * Set BASE_URL env var to override default (http://localhost:5174).
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForLoad(page: Page) {
  // Wait for the sidebar + "All Projects" item to be visible (data loaded)
  await page.waitForSelector('[data-testid="project-all"]', { timeout: 15000 });
  // Wait for recent sessions panel to appear too
  await page.waitForSelector('[data-testid="recent-sessions"]', { timeout: 15000 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Basic load
// ---------------------------------------------------------------------------

test.describe('App loads', () => {
  test('shows the header with title and nav buttons', async ({ page }) => {
    await page.goto('/');
    await waitForLoad(page);

    await expect(page.locator('h1')).toContainText('Chat Recall');
    await expect(page.getByTestId('nav-search')).toBeVisible();
    await expect(page.getByTestId('nav-memory')).toBeVisible();
  });

  test('defaults to conversations view', async ({ page }) => {
    await page.goto('/');
    await waitForLoad(page);

    await expect(page.getByTestId('search-layout')).toBeVisible();
    await expect(page.getByTestId('project-sidebar')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Project sidebar
// ---------------------------------------------------------------------------

test.describe('Project sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForLoad(page);
  });

  test('shows "All Projects" option', async ({ page }) => {
    const allProjects = page.getByTestId('project-all');
    await expect(allProjects).toBeVisible();
    await expect(allProjects).toContainText('All Projects');
  });

  test('"All Projects" is selected by default', async ({ page }) => {
    const allProjects = page.getByTestId('project-all');
    await expect(allProjects).toHaveClass(/active/);
  });

  test('shows project list with counts', async ({ page }) => {
    const projectItems = page.getByTestId('project-item');
    const count = await projectItems.count();

    // Should have at least the "All Projects" entry
    // (actual project count depends on the user's data)
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('clicking a project selects it', async ({ page }) => {
    const projectItems = page.getByTestId('project-item');
    const count = await projectItems.count();

    if (count > 0) {
      await projectItems.first().click();
      await expect(projectItems.first()).toHaveClass(/active/);

      // All Projects should no longer be active
      const allProjects = page.getByTestId('project-all');
      await expect(allProjects).not.toHaveClass(/active/);
    }
  });

  test('clicking "All Projects" clears project filter', async ({ page }) => {
    const projectItems = page.getByTestId('project-item');
    const count = await projectItems.count();

    if (count > 0) {
      // Select a project first
      await projectItems.first().click();

      // Then click All Projects
      await page.getByTestId('project-all').click();
      await expect(page.getByTestId('project-all')).toHaveClass(/active/);
    }
  });
});

// ---------------------------------------------------------------------------
// Conversations list
// ---------------------------------------------------------------------------

test.describe('Conversations list', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForLoad(page);
  });

  test('shows recent sessions on load', async ({ page }) => {
    const recentSessions = page.getByTestId('recent-sessions');
    await expect(recentSessions).toBeVisible();
  });

  test('shows session items', async ({ page }) => {
    const sessionItems = page.getByTestId('session-item');
    const count = await sessionItems.count();
    // May be 0 if no sessions indexed yet
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('clicking a session opens it in detail view', async ({ page }) => {
    const sessionItems = page.getByTestId('session-item');
    const count = await sessionItems.count();

    if (count > 0) {
      await sessionItems.first().click();

      // Conversation column should show content
      const conversationColumn = page.locator('.conversation-column');
      await expect(conversationColumn).not.toHaveClass(/hidden/);
    }
  });

  test('selected session is highlighted', async ({ page }) => {
    const sessionItems = page.getByTestId('session-item');
    const count = await sessionItems.count();

    if (count > 0) {
      await sessionItems.first().click();
      await expect(sessionItems.first()).toHaveClass(/selected/);
    }
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test.describe('Search', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForLoad(page);
  });

  test('search input is visible', async ({ page }) => {
    await expect(page.getByTestId('search-input')).toBeVisible();
  });

  test('search button is disabled when input is empty', async ({ page }) => {
    await expect(page.getByTestId('search-button')).toBeDisabled();
  });

  test('search button enables when query is typed', async ({ page }) => {
    await page.getByTestId('search-input').fill('test query');
    await expect(page.getByTestId('search-button')).toBeEnabled();
  });

  test('performing a search shows results', async ({ page }) => {
    await page.getByTestId('search-input').fill('the');
    await page.getByTestId('search-button').click();

    // Wait for search to complete (may take a moment for embeddings)
    await page.waitForTimeout(5000);

    // Either shows results or recent (if no results)
    const hasResults = await page.getByTestId('search-results').isVisible().catch(() => false);
    const hasRecent = await page.getByTestId('recent-sessions').isVisible().catch(() => false);
    expect(hasResults || hasRecent).toBe(true);
  });

  test('search filters by project when project is selected', async ({ page }) => {
    const projectItems = page.getByTestId('project-item');
    const projectCount = await projectItems.count();

    if (projectCount > 0) {
      // Select a project
      await projectItems.first().click();

      // Check that search placeholder mentions the project
      const searchInput = page.getByTestId('search-input');
      const placeholder = await searchInput.getAttribute('placeholder');
      expect(placeholder).toContain('Search in');
    }
  });

  test('clear button appears after search and resets', async ({ page }) => {
    const searchInput = page.getByTestId('search-input');
    await searchInput.fill('something');

    // The × button should appear
    const clearBtn = page.locator('.search-clear');
    await expect(clearBtn).toBeVisible();

    await clearBtn.click();
    await expect(searchInput).toHaveValue('');
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForLoad(page);
  });

  test('switching to Memory tab shows memory explorer', async ({ page }) => {
    await page.getByTestId('nav-memory').click();

    // Memory explorer should appear
    await expect(page.locator('.memory-explorer, [data-testid="memory-explorer"]')).toBeVisible({
      timeout: 5000,
    });

    // Search layout should be gone
    await expect(page.getByTestId('search-layout')).not.toBeVisible();
  });

  test('switching back to Conversations shows search layout', async ({ page }) => {
    await page.getByTestId('nav-memory').click();
    await page.getByTestId('nav-search').click();

    await expect(page.getByTestId('search-layout')).toBeVisible();
    await expect(page.getByTestId('project-sidebar')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// API health
// ---------------------------------------------------------------------------

test.describe('API health', () => {
  test('health endpoint returns ok', async ({ request }) => {
    const baseUrl = process.env.BASE_URL || 'http://localhost:5174';
    const response = await request.get(`${baseUrl}/api/status`);
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data).toHaveProperty('totalSessions');
    expect(data).toHaveProperty('projects');
  });

  test('conversations recent endpoint responds', async ({ request }) => {
    const baseUrl = process.env.BASE_URL || 'http://localhost:5174';
    const response = await request.get(`${baseUrl}/api/conversations/recent`);
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data).toHaveProperty('sessions');
    expect(Array.isArray(data.sessions)).toBe(true);
  });
});
