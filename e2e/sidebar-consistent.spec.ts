import { test, expect } from '@playwright/test';

/**
 * The sidebar is persistent, and its FILTERS are not.
 *
 * This file used to assert the opposite: that every top-level view shows the
 * same Source rows and the same project tree. That was the bug, written down as
 * a requirement. The rail renders everywhere, so the source pills and the
 * project tree appeared on all nine views and changed nothing on five of them,
 * because those screens receive neither `toolFilter` nor `projectFilter`. A
 * control that looks live and does nothing teaches a reader that the controls
 * are unreliable, and the lesson carries to the screens where they work.
 *
 * See VIEW_FILTERS in components/Sidebar.tsx — this file is its test.
 */

/** Views that read the tool filter, the project tree, both, or neither. */
const VIEWS = [
  { label: /^Conversations$/,  name: 'Conversations',  tool: true,  project: true,  extra: null as RegExp | null },
  { label: /^Projects$/,       name: 'Projects',       tool: true,  project: true,  extra: null },
  { label: /^Decisions$/,      name: 'Decisions',      tool: false, project: true,  extra: null },
  { label: /^Skills & tools$/, name: 'Skills & tools', tool: true,  project: false, extra: /^Skills$/ },
  { label: /^Tasks$/,          name: 'Tasks',          tool: false, project: false, extra: null },
  { label: /^Security$/,       name: 'Security',       tool: false, project: false, extra: null },
];

for (const view of VIEWS) {
  test(`${view.name}: shows only the filters it actually reads`, async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: view.label }).click();
    await page.waitForLoadState('networkidle');

    const sidebar = page.getByTestId('project-sidebar');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    // The source pills, present only where a per-tool filter does something.
    for (const tool of ['all', 'claude', 'opencode', 'codex', 'agy', 'cursor']) {
      const pill = sidebar.getByTestId(`tool-filter-${tool}`);
      if (view.tool) await expect(pill).toBeVisible({ timeout: 10_000 });
      else await expect(pill).toHaveCount(0);
    }

    // The project tree, same rule.
    const allProjects = sidebar.getByTestId('project-all');
    if (view.project) await expect(allProjects).toBeVisible({ timeout: 10_000 });
    else await expect(allProjects).toHaveCount(0);

    if (view.extra) {
      // Scope to the section HEADING. The grouping means a heading and a row can
      // carry the same word — "Skills" is both the group and a type inside it —
      // so a bare text match is ambiguous by design rather than by accident.
      await expect(sidebar.locator('.cr-sidebar-section-label', { hasText: view.extra }))
        .toBeVisible({ timeout: 10_000 });
    }

    // No horizontal duplicate Tool-filter chip rows in the main pane.
    for (const stale of ['memory-tool-filter', 'toolkit-tool-filter', 'insights-tool-filter']) {
      await expect(page.getByTestId(stale)).toHaveCount(0);
    }
  });
}

test('the rail is eight items, and Memory Hub is not one of them', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const sidebar = page.getByTestId('project-sidebar');
  for (const id of ['home', 'decisions', 'search', 'projects', 'tasks', 'toolkit', 'security']) {
    await expect(sidebar.getByTestId(`nav-${id}`)).toBeVisible({ timeout: 10_000 });
  }
  // Dissolved into Decisions (the graph) and Conversations (the note corpus).
  await expect(sidebar.getByTestId('nav-memory')).toHaveCount(0);
  // Demoted to the footer chip; the page and its deep link both survive.
  await expect(sidebar.getByTestId('nav-health')).toHaveCount(0);
  await expect(sidebar.getByTestId('sync-chip')).toBeVisible({ timeout: 10_000 });
});

test('?view=memory lands on Conversations rather than snapping home', async ({ page }) => {
  await page.goto('/?view=memory');
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('project-sidebar').getByTestId('nav-search'))
    .toHaveAttribute('aria-current', 'page', { timeout: 10_000 });
});

test('the note corpus is a facet of Conversations', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /^Conversations$/ }).click();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /^Notes & memory$/ }).click();
  await expect(page.getByTestId('memory-explorer')).toBeVisible({ timeout: 10_000 });
});

test('clicking Codex in the sidebar from Conversations filters the list', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /^Conversations$/ }).click();
  await page.waitForLoadState('networkidle');

  const codex = page.getByTestId('project-sidebar').getByTestId('tool-filter-codex');
  await codex.click();
  await page.waitForTimeout(300);
  await expect(codex).toHaveAttribute('aria-current', 'true');
});

test('Skills & tools groups its type rows into Skills and Connections', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /^Skills & tools$/ }).click();
  await page.waitForLoadState('networkidle');
  const sidebar = page.getByTestId('project-sidebar');
  // Six rows under one heading is past the limit for one decision point, and
  // the six are two kinds of thing: work you author, and wiring to something else.
  await expect(sidebar.locator('.cr-sidebar-section-label', { hasText: /^Skills$/ }))
    .toBeVisible({ timeout: 10_000 });
  await expect(sidebar.locator('.cr-sidebar-section-label', { hasText: /^Connections$/ }))
    .toBeVisible({ timeout: 10_000 });
  await expect(sidebar.getByTestId('toolkit-type-skill')).toBeVisible({ timeout: 10_000 });
  await expect(sidebar.getByTestId('toolkit-type-mcp')).toBeVisible({ timeout: 10_000 });
});
