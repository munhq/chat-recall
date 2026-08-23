import { test, expect } from '@playwright/test';

/**
 * Mobile regression guard for the five static marketing pages.
 *
 * These pages shipped to production with the landing 531px wide inside a 375px
 * viewport — a constant 156px of horizontal overflow on every handset, and
 * 211px on a 320px screen. The cause was `grid-template-columns: 1fr`, which
 * means `minmax(auto, 1fr)`: the `auto` floor pins a track at its content's
 * min-content width, and `.cmd code { white-space: nowrap }` (the
 * `curl … | sh` line) held that floor at ~507px. No breakpoint can rescue a
 * track whose minimum is wider than the screen.
 *
 * Nothing caught it because no mobile viewport was under test anywhere in the
 * suite. That is what this file exists to prevent.
 *
 * Lives in this repo because the pages do: the product repo builds the dashboard
 * only, so there is nothing there for this to load.
 *
 * Generate the pages and point MARKETING_BASE_URL at them:
 *   CLIENT_DIR=../chat-recall/packages/server/client DIST_DIR=/tmp/site \
 *     REQUIRE_LEGAL=1 node build-marketing.mjs
 *   npx http-server /tmp/site -p 4899   # or any static server
 *   MARKETING_BASE_URL=http://127.0.0.1:4899 npx playwright test --project=mobile-safari
 */

const BASE = process.env.MARKETING_BASE_URL || process.env.BASE_URL || 'http://127.0.0.1:4899';

const PAGES = [
  { path: '/landing.html', name: 'landing' },
  { path: '/mcp/', name: 'mcp tools' },
  { path: '/pricing/', name: 'pricing' },
  { path: '/security/', name: 'security' },
  { path: '/terms/', name: 'terms' },
];

// The narrow end of the real device range. 320px is an SE-class handset and is
// where the nav previously pushed the sign-in button off the edge.
const WIDTHS = [320, 360, 375, 390, 414, 430];

test.describe('marketing pages fit every phone width', () => {
  for (const page_ of PAGES) {
    for (const width of WIDTHS) {
      test(`${page_.name} does not scroll horizontally at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${BASE}${page_.path}`, { waitUntil: 'load' });

        // Compare against documentElement.clientWidth, NOT window.innerWidth.
        // Under mobile emulation the layout viewport GROWS to contain an
        // overflow, so innerWidth reports 531 on a 375px screen and
        // `scrollWidth - innerWidth` is 0 for a page that is visibly broken.
        // clientWidth stays at the real viewport width and exposes it.
        const overflow = await page.evaluate(() =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth);

        // Report WHICH element overflowed, not just that something did — a bare
        // "expected 33 to be <= 0" sends the next person hunting by hand.
        if (overflow > 0) {
          const culprits = await page.evaluate(() => {
            const out: string[] = [];
            const limit = document.documentElement.clientWidth;
            document.querySelectorAll('*').forEach((el) => {
              const r = el.getBoundingClientRect();
              if (r.right > limit + 0.5) {
                const cls = String((el as HTMLElement).className || '').trim().split(/\s+/).join('.');
                out.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} right=${Math.round(r.right)}`);
              }
            });
            return out.slice(0, 5);
          });
          throw new Error(`overflows by ${overflow}px. Offending elements: ${culprits.join(', ')}`);
        }

        expect(overflow).toBeLessThanOrEqual(0);
      });
    }
  }

  test('the install command scrolls itself rather than the page', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${BASE}/landing.html`, { waitUntil: 'load' });

    const cmd = page.locator('.cmd code').first();
    await expect(cmd).toBeVisible();

    const box = await cmd.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        right: el.getBoundingClientRect().right,
        viewport: document.documentElement.clientWidth,
        overflowX: cs.overflowX,
        minWidth: cs.minWidth,
        whiteSpace: cs.whiteSpace,
      };
    });

    // What actually regressed: the element sat at min-width:auto, so it refused
    // to shrink below the command string and dragged the page sideways instead.
    expect(box.clientWidth).toBeLessThanOrEqual(box.viewport);
    expect(box.right).toBeLessThanOrEqual(box.viewport);

    // And it is configured to scroll ITSELF when the command does not fit.
    // Asserted from the computed style, not from scrollWidth > clientWidth:
    // whether this particular string overflows at this particular width depends
    // on which font actually loaded, so a geometry assertion here is flaky and
    // says nothing about the bug. min-width:0px is the fix; overflow-x:auto is
    // what it enables.
    expect(box.minWidth).toBe('0px');
    expect(['auto', 'scroll']).toContain(box.overflowX);
    expect(box.whiteSpace).toBe('nowrap');
    // If it does overflow, the overflow is contained rather than pushing the page.
    if (box.scrollWidth > box.clientWidth) {
      expect(box.right).toBeLessThanOrEqual(box.viewport);
    }
  });

  test('the /mcp tool table stacks instead of forcing the page wide', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${BASE}/mcp/`, { waitUntil: 'load' });

    // Stacked layout: the two cells of a row sit on different lines.
    const rowTops = await page.evaluate(() => {
      const tr = document.querySelector('.tools tr');
      if (!tr) return null;
      return [...tr.children].map((td) => Math.round(td.getBoundingClientRect().top));
    });
    expect(rowTops).not.toBeNull();
    expect(rowTops!.length).toBe(2);
    expect(rowTops![1]).toBeGreaterThan(rowTops![0]);
  });

  test('every marketing page declares a responsive viewport', async ({ page }) => {
    for (const p of PAGES) {
      await page.goto(`${BASE}${p.path}`, { waitUntil: 'load' });
      const content = await page.locator('meta[name="viewport"]').getAttribute('content');
      expect(content, `${p.name} viewport meta`).toContain('width=device-width');
    }
  });
});
