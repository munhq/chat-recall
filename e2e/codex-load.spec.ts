import { test, expect } from '@playwright/test';

const TOOLS: Array<{ tool: string; label: string }> = [
  { tool: 'codex', label: 'Codex' },
  { tool: 'gemini', label: 'Gemini' },
  { tool: 'opencode', label: 'OpenCode' },
  { tool: 'agy', label: 'Antigravity' },
  { tool: 'cursor', label: 'Cursor' },
];

/**
 * For every non-Claude tool, look up the latest session via the API,
 * open it in the UI, and click through every tab the conversation
 * viewer exposes. Asserts:
 *   - the row in the conversation list is actually that tool (not a
 *     Claude row that slipped through),
 *   - clicking each tab doesn't trigger a console error or surface a
 *     "Failed to load" banner,
 *   - no /api response returns >= 400.
 */
for (const { tool, label } of TOOLS) {
  test(`${label}: conversation tabs load without 404s`, async ({ page }) => {
    // 1. Resolve a real session id for this tool via the API.
    const apiBase = `http://127.0.0.1:5000`;
    const recent = await page.request.get(`${apiBase}/api/conversations/recent?tool=${tool}&limit=1`);
    expect(recent.status()).toBe(200);
    const recentJson = await recent.json();
    expect(recentJson.sessions?.length, `no ${tool} sessions on disk`).toBeGreaterThan(0);
    const sessionId: string = recentJson.sessions[0].sessionId;
    console.log(`[${tool}] target sessionId=${sessionId}`);

    // 2. Browser hooks BEFORE navigation so we capture everything.
    const consoleErrors: string[] = [];
    const failed: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('response', (r) => {
      if (r.url().includes('/api/') && r.status() >= 400) {
        failed.push(`${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
      }
    });

    await page.goto('/');

    // Wait for the initial unfiltered /recent to land. Otherwise the click
    // below races: the filter toggle can fire before the unfiltered fetch
    // resolves, and React's setState then clobbers our filtered list.
    await page.waitForResponse(
      (r) => r.url().includes('/api/conversations/recent') && r.status() === 200,
      { timeout: 30_000 },
    );
    // Belt + braces: wait for at least one row from the initial list, so we
    // know React has committed the unfiltered render.
    await expect(page.locator('[data-session-id]').first()).toBeVisible({ timeout: 15_000 });

    // 3. Click the tool filter and wait for the post-click response.
    const filteredResp = page.waitForResponse(
      (r) => r.url().includes('/api/conversations/recent') && r.url().includes(`tool=${tool}`),
      { timeout: 20_000 },
    );
    await page.locator('aside').getByText(label, { exact: true }).click();
    await filteredResp;

    // 4. Find the target row.
    const targetRow = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(targetRow).toBeVisible({ timeout: 15_000 });
    await targetRow.click();
    await page.waitForLoadState('networkidle');
    await targetRow.click();
    await page.waitForLoadState('networkidle');

    // 5. Click each tab and assert no error rendered.
    for (const tabName of ['Summary', 'Outcome', 'First Prompt', 'Full', 'Files', 'Diff', 'Commits', 'Raw']) {
      const tab = page.getByRole('button', { name: new RegExp(`^${tabName}$`, 'i') });
      const visible = await tab.isVisible().catch(() => false);
      if (!visible) {
        console.log(`[${tool}] tab "${tabName}" not visible — skipping`);
        continue;
      }
      await tab.click();
      await page.waitForTimeout(700);
      const errCount = await page.locator('text=/Failed to load/i').count();
      if (errCount > 0) {
        const errText = await page.locator('text=/Failed to load/i').first().textContent();
        throw new Error(`[${tool}] tab "${tabName}" rendered error: ${errText}`);
      }
      console.log(`[${tool}] tab ${tabName}: ok`);
    }

    await page.screenshot({ path: `/tmp/${tool}-final.png`, fullPage: false });

    if (consoleErrors.length) console.log(`[${tool}] console errors:`, consoleErrors);
    if (failed.length) console.log(`[${tool}] failed /api requests:`, failed);
    expect(failed).toEqual([]);
    // React DevTools / Apollo notices and AbortError (caused by fast tab
    // clicks aborting in-flight requests) are noise — ignore them.
    const realErrors = consoleErrors.filter(e =>
      !/Download the (React DevTools|Apollo)/i.test(e) &&
      !/AbortError|signal is aborted/i.test(e)
    );
    expect(realErrors).toEqual([]);
  });
}

/** Per-tool diff/outcome must surface real session data — not empty stubs. */
test('per-tool diff returns real edits when present', async ({ page }) => {
  // The Gemini session 49830bbc edited 12 files in this repo.
  const r = await page.request.get('/api/conversations/gemini_49830bbc-1ada-42af-8f0b-4b33daf8539f/diff');
  expect(r.status()).toBe(200);
  const diff = await r.json();
  expect(diff.files.length).toBeGreaterThanOrEqual(5);
  expect(diff.totalLinesAdded).toBeGreaterThan(100);
  // Each edited file must carry an actual unified diff body.
  const withDiff = diff.files.filter((f: any) => f.diff && f.diff.length > 0);
  expect(withDiff.length).toBe(diff.files.length);

  const out = await (await page.request.get('/api/conversations/gemini_49830bbc-1ada-42af-8f0b-4b33daf8539f/outcome')).json();
  expect(out.fileCount).toBe(diff.files.length);
  // Prompts should be real strings, not "[object Object]".
  expect(out.prompts.every((p: any) => p.text && !p.text.includes('[object Object]'))).toBe(true);
});

/** Codex parent must have its 6 sub-agents linked, not surfaced as separate sessions. */
test('codex: parent has 6 sub-agents linked', async ({ page }) => {
  const apiBase = `http://127.0.0.1:5000`;
  const recent = await page.request.get(`${apiBase}/api/conversations/recent?tool=codex&limit=10`);
  const recentJson = await recent.json();
  // Only the parent should surface — sub-agents are filtered out at the source.
  expect(recentJson.count).toBe(1);
  const parentId = recentJson.sessions[0].sessionId;
  const conv = await (await page.request.get(`${apiBase}/api/conversations/${parentId}`)).json();
  expect(conv.subagents?.length).toBe(6);
  expect(conv.messages?.length).toBeGreaterThan(50);
});
