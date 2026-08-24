/**
 * The soft-404 regression, pinned.
 *
 * Every unmatched path used to return the SPA shell with status 200. That is a
 * soft 404 in Google's terms, and it is not a cosmetic problem: an indexable
 * document was served at every wrong URL, canonicalising to `/app` — a path
 * robots.txt disallows — so dead addresses entered the crawl set and the styled
 * 404 page the marketing build already ships was unreachable.
 *
 * A 200 where a 404 belongs is invisible in a diff and invisible in a browser.
 * Only the status code differs, and only a crawler cares. That is exactly the
 * kind of defect that needs a test rather than a reviewer.
 */
import { describe, test, expect } from 'vitest';
import { classifyStaticPath } from './static-routing.js';

describe('the app owns three paths and no others', () => {
  test.each(['/app', '/app/', '/device', '/device/'])('%s gets the app shell', (p) => {
    expect(classifyStaticPath(p)).toBe('app-shell');
  });
});

describe('THE REGRESSION: everything else is a 404, not a 200', () => {
  test.each([
    '/definitely-not-a-page',
    '/settings',                 // plausible, and never existed
    '/app/anything',             // nested app route — the client has no path router
    '/apps',                     // prefix collision with /app
    '/devices',
    '/App',                      // case matters; a different URL is a different page
    '/404.html',                 // must not be served as if it were a real page
    '/wp-login.php',             // scanner traffic, of which there is a lot
    '/pricing',                  // redirected to /pricing/ upstream; never reaches here as-is
  ])('%s is not found', (p) => {
    expect(classifyStaticPath(p)).toBe('not-found');
  });
});

describe('the allowlist stays an allowlist', () => {
  test('an empty or odd path is not found rather than assumed to be the app', () => {
    // '/' never reaches this handler — it has its own route above express.static
    // — so the safe answer here is still "not found" rather than the app shell.
    for (const p of ['', '/', '//', '/app//', '/app/./']) {
      expect(classifyStaticPath(p)).toBe('not-found');
    }
  });
});
