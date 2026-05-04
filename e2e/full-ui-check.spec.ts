import { test, expect } from '@playwright/test';

/** End-to-end smoke: navigate every view, capture every console error
 *  and every failed network request, screenshot each view. Print
 *  everything. No silent skips. */

test('every top-level view renders and reaches a usable state', async ({ page }) => {
  const allErrors: string[] = [];
  const failedReq: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') allErrors.push(`[console] ${m.text().slice(0, 600)}`);
  });
  page.on('pageerror', (e) => {
    allErrors.push(`[pageerror] ${e.message}`);
  });
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) {
      failedReq.push(`${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
    }
  });

  await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
  await page.screenshot({ path: '/tmp/ui-1-conversations.png', fullPage: false });

  // Click each view in turn and screenshot.
  for (const name of ['Activity', 'Memory', 'Toolkit', 'Insights', 'Conversations']) {
    const btn = page.getByRole('button', { name: new RegExp(`^${name}$`) });
    if (!(await btn.isVisible().catch(() => false))) {
      allErrors.push(`[nav] button "${name}" not visible`);
      continue;
    }
    await btn.click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: `/tmp/ui-${name.toLowerCase()}.png`, fullPage: false });

    // What's on the page?
    const bodyLen = (await page.locator('body').innerHTML()).length;
    const visibleText = (await page.locator('main, [data-testid="app-layout"]').first().innerText().catch(() => '')).slice(0, 200);
    console.log(`[${name}] body=${bodyLen} text="${visibleText.replace(/\n/g, ' ⏎ ')}"`);
  }

  // Click first conversation to test the viewer.
  await page.getByRole('button', { name: /^Conversations$/ }).click();
  await page.waitForLoadState('networkidle').catch(() => {});
  const firstRow = page.locator('[data-session-id]').first();
  if (await firstRow.isVisible().catch(() => false)) {
    await firstRow.click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({ path: '/tmp/ui-conversation-open.png', fullPage: false });
  } else {
    allErrors.push('[viewer] no conversation rows rendered');
  }

  // Final dump.
  console.log('=== ERRORS ===');
  for (const e of allErrors) console.log(' ', e);
  console.log('=== FAILED API REQUESTS ===');
  for (const r of failedReq) console.log(' ', r);

  // Filter benign React-strict double-mount aborts and devtool notices.
  const real = allErrors.filter(e =>
    !/AbortError|signal is aborted|Download the (React DevTools|Apollo)/i.test(e)
  );
  expect(real, `Real console errors: ${JSON.stringify(real)}`).toEqual([]);
  expect(failedReq, `Failed /api requests: ${JSON.stringify(failedReq)}`).toEqual([]);
});
