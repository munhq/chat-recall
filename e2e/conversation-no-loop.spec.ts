import { test, expect } from '@playwright/test';

/**
 * Regression: clicking a Claude session whose parent JSONL is an empty
 * stub (new-format sessions where everything lives in
 * `<id>/subagents/*`) used to loop forever. The conversation viewer's
 * auto-load effect fired, the parser returned messages.length === 0,
 * the effect re-fired, etc.
 *
 * The fix tracks per-(session, mode) loads in a ref. We assert by
 * counting `/api/conversations/<id>` GETs during a 5 s window — any
 * count larger than ~3 means we're looping.
 */

test('clicking a session does not loop the body fetch', async ({ page }) => {
  const convoFetches = new Map<string, number>();
  page.on('response', (r) => {
    // Match /api/conversations/<id>  (no trailing /subpath)
    const m = r.url().match(/\/api\/conversations\/([^/?]+)(?:\?[^/]*)?$/);
    if (!m) return;
    const id = decodeURIComponent(m[1]);
    if (id === 'recent' || id === 'outcome') return;
    convoFetches.set(id, (convoFetches.get(id) ?? 0) + 1);
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const row = page.locator('[data-session-id]').first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  const sessionId = await row.getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  convoFetches.clear();

  await row.click();
  await page.waitForLoadState('networkidle');
  // Click Full to force the auto-load codepath in ConversationViewer.
  const fullBtn = page.getByRole('button', { name: /^Full$/ });
  if (await fullBtn.isVisible().catch(() => false)) await fullBtn.click();

  // Sit on the session for 5 s. The bug fired once per render tick (~10/s).
  await page.waitForTimeout(5_000);

  const calls = convoFetches.get(sessionId!) ?? 0;
  console.log(`[no-loop] /api/conversations/${sessionId} called ${calls} times in 5 s`);
  // Allow up to 3 (initial load + maybe a strict-mode re-fire + a Full
  // tab click triggering a refresh). Anything more is a regression.
  expect(calls).toBeLessThanOrEqual(3);
});
