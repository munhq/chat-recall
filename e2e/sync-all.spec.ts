import { test, expect } from '@playwright/test';

test('matrix endpoint returns presence per (type, name, tool)', async ({ page }) => {
  const r = await page.request.get('/api/toolkit/matrix');
  expect(r.status()).toBe(200);
  const data = await r.json();
  expect(typeof data.skill).toBe('object');
  expect(typeof data.mcp).toBe('object');
  expect(Array.isArray(data.supportedTargets.skill)).toBe(true);
  expect(Array.isArray(data.supportedTargets.mcp)).toBe(true);
  // gemini isn't a supported skill target
  expect(data.supportedTargets.skill).not.toContain('gemini');
  // mcp supports all four
  for (const t of ['claude', 'opencode', 'gemini', 'codex']) {
    expect(data.supportedTargets.mcp).toContain(t);
  }
});

test('sync matrix UI: open, queue add+remove, dismiss without applying', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /^Toolkit$/ }).click();
  await page.waitForLoadState('networkidle');

  const open = page.getByTestId('toolkit-sync-all');
  await expect(open).toBeVisible({ timeout: 10_000 });

  const matrixWait = page.waitForResponse(
    (r) => r.url().includes('/toolkit/matrix') && r.status() === 200,
    { timeout: 30_000 },
  );
  await open.click();
  await matrixWait;

  const matrix = page.getByTestId('toolkit-sync-matrix');
  await expect(matrix).toBeVisible({ timeout: 10_000 });

  // Apply button starts disabled with "No changes".
  const apply = page.getByTestId('toolkit-sync-apply');
  await expect(apply).toBeDisabled();
  await expect(apply).toHaveText(/No changes/i);

  // Click the first "missing" cell, then re-resolve via the same DOM
  // node (using nth(0) of a snapshot) so subsequent assertions don't
  // chase a moving locator after data-queued flips.
  const allMissing = page.locator('[data-testid="sync-matrix-cell"][data-present="false"][data-queued=""]');
  await expect(allMissing.first()).toBeVisible({ timeout: 10_000 });
  const missingHandle = await allMissing.first().elementHandle();
  expect(missingHandle).not.toBeNull();
  await missingHandle!.scrollIntoViewIfNeeded();
  await missingHandle!.click();
  await expect.poll(async () => missingHandle!.getAttribute('data-queued')).toBe('add');
  await expect(apply).toHaveText(/Apply 1 change \(1\+\)/);

  // Click a "present" cell — same elementHandle pattern.
  const presentHandle = await page
    .locator('[data-testid="sync-matrix-cell"][data-present="true"][data-queued=""]')
    .first()
    .elementHandle();
  expect(presentHandle).not.toBeNull();
  await presentHandle!.scrollIntoViewIfNeeded();
  await presentHandle!.click();
  await expect.poll(async () => presentHandle!.getAttribute('data-queued')).toBe('remove');
  await expect(apply).toHaveText(/Apply 2 changes \(1\+\/1−\)/);

  // Click the original add cell again — un-queue it.
  await missingHandle!.click();
  await expect.poll(async () => missingHandle!.getAttribute('data-queued')).toBe('');
  await expect(apply).toHaveText(/Apply 1 change \(1−\)/);

  // Take a snapshot showing the pending-remove state, then close.
  await page.screenshot({ path: '/tmp/toolkit-matrix.png', fullPage: false });

  await page.getByRole('button', { name: /^Close$/ }).click();
  await expect(matrix).toBeHidden();
});

test('sync matrix UI: search filter narrows rows', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /^Toolkit$/ }).click();
  await page.waitForLoadState('networkidle');

  const matrixWait = page.waitForResponse(
    (r) => r.url().includes('/toolkit/matrix') && r.status() === 200,
    { timeout: 30_000 },
  );
  await page.getByTestId('toolkit-sync-all').click();
  await matrixWait;

  // Switch to MCPs (smaller list) inside the modal — there's a different
  // MCPs button in the underlying Toolkit page, so scope by testid.
  const modal = page.getByTestId('toolkit-sync-matrix');
  await modal.getByRole('button', { name: /^MCPs/ }).click();
  await page.waitForTimeout(150);
  const beforeRows = await modal.locator('[data-testid="sync-matrix-cell"]').count();

  const search = modal.getByPlaceholder(/Filter MCPs/i);
  await search.fill('chrome');
  await page.waitForTimeout(200);
  const afterRows = await modal.locator('[data-testid="sync-matrix-cell"]').count();
  expect(afterRows).toBeLessThan(beforeRows);
  expect(afterRows).toBeGreaterThan(0);

  await page.screenshot({ path: '/tmp/toolkit-matrix-filtered.png', fullPage: false });
});
