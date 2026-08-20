import { test, expect } from '@playwright/test';

/**
 * Mobile regression guard for the dashboard.
 *
 * The app once shipped with no mobile viewport under test anywhere, and a page
 * reached production 531px wide inside a 375px viewport — a constant 156px of
 * horizontal overflow on every handset. The cause was `grid-template-columns:
 * 1fr`, which means `minmax(auto, 1fr)`: the `auto` floor pins a track at its
 * content's min-content width, and a `white-space: nowrap` code line held that
 * floor wider than the screen. No breakpoint rescues a track whose minimum is
 * wider than the viewport.
 *
 * The spec that caught that covered the marketing pages, and moved to the site
 * repo when those pages did. This is the same guard aimed at the dashboard,
 * which is the part of the product a self-hoster actually runs — and which had
 * no mobile coverage at all once the other spec left.
 *
 * Runs under the mobile-safari / mobile-chrome projects (see playwright.config).
 * Point BASE_URL at a running app; it needs no data, only a rendered shell.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5000';

/** The narrow end of the real device range. 320px is an SE-class handset. */
const WIDTHS = [320, 360, 375, 390, 414, 430];

/** The views a signed-out or single-tenant visitor can reach without data. */
const VIEWS = [
  { path: '/', name: 'root' },
  { path: '/app', name: 'app shell' },
  { path: '/app?view=search', name: 'search' },
  { path: '/app?view=settings', name: 'settings' },
  { path: '/app?view=connect', name: 'connect' },
];

/**
 * Measure against documentElement.clientWidth, NOT window.innerWidth. Under
 * mobile emulation the layout viewport GROWS to contain an overflow, so
 * innerWidth reports 531 on a 375px screen and `scrollWidth - innerWidth` is 0
 * for a page that is visibly broken. clientWidth stays at the real viewport
 * width and exposes it.
 */
async function horizontalOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Name what overflowed. "expected 33 to be <= 0" sends the next person hunting. */
async function culprits(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const limit = document.documentElement.clientWidth;
    document.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right > limit + 0.5 && r.width > 0) {
        const cls = String((el as HTMLElement).className || '').trim().split(/\s+/).filter(Boolean).join('.');
        out.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} right=${Math.round(r.right)}`);
      }
    });
    return out.slice(0, 5);
  });
}

test.describe('dashboard fits every phone width', () => {
  for (const view of VIEWS) {
    for (const width of WIDTHS) {
      test(`${view.name} does not scroll horizontally at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${BASE}${view.path}`, { waitUntil: 'networkidle', timeout: 30_000 });

        // The shell must actually have rendered, or this asserts nothing: a
        // blank page never overflows, and would pass while the app is broken.
        const html = await page.locator('body').innerHTML();
        expect(html.length, `${view.name} rendered nothing at ${width}px`).toBeGreaterThan(500);

        const overflow = await horizontalOverflow(page);
        if (overflow > 0) {
          throw new Error(
            `${view.name} overflows by ${overflow}px at ${width}px. ` +
            `Offending elements: ${(await culprits(page)).join(', ')}`);
        }
        expect(overflow).toBeLessThanOrEqual(0);
      });
    }
  }
});

test('wide content scrolls inside its own container, not the page', async ({ page }) => {
  // Tables, code blocks and command lines are the usual source of a track whose
  // min-content width exceeds the screen. Whatever is horizontally scrollable
  // must be an inner element; the document itself must not be.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle', timeout: 30_000 });

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  const pageScrolls = await page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth > d.clientWidth;
  });
  expect(pageScrolls, 'the document scrolls sideways').toBe(false);
});
