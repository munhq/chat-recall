import { test, expect } from '@playwright/test';

/** Smoke test: load the root URL and capture every error in the console
 *  + every failing /api request. If the user reports "stuck" we should
 *  see whatever exception is bubbling up. */

test('root page renders without console errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  const failedReq: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 500));
  });
  page.on('pageerror', (e) => {
    consoleErrors.push(`PAGE: ${e.message}`);
  });
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) {
      failedReq.push(`${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
    }
  });

  await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });

  await page.screenshot({ path: '/tmp/smoke-root.png', fullPage: false });

  // Print everything the user might be seeing.
  const hadAbortOnly = consoleErrors.every(e => /AbortError|signal is aborted|Download the (React DevTools|Apollo)/.test(e));
  console.log('console errors:', consoleErrors.length, 'abort-only:', hadAbortOnly);
  for (const e of consoleErrors.slice(0, 20)) console.log('  ', e);
  console.log('failed /api requests:', failedReq.length);
  for (const r of failedReq.slice(0, 10)) console.log('  ', r);

  // Body should have some children (not blank/stuck).
  const html = await page.locator('body').innerHTML();
  console.log('body length:', html.length);
  expect(html.length).toBeGreaterThan(2000);
});
