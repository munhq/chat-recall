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
import { classifyStaticPath, cacheControlFor } from './static-routing.js';

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

describe('cacheControlFor', () => {
  // The regression this function exists for. Every marketing page is
  // <slug>/index.html, so the old `endsWith('index.html')` rule served all of
  // them no-store while its own comment promised a short public TTL.
  test('gives a marketing page a public TTL, not the shell rule', () => {
    for (const page of ['guides/index.html', 'guides/claude-continue-alternative/index.html',
      'pricing/index.html', 'mcp/index.html', 'terms/index.html']) {
      expect(cacheControlFor(page)).toBe('public, max-age=300, stale-while-revalidate=86400');
    }
  });

  test('never caches the SPA shell or the landing page', () => {
    expect(cacheControlFor('index.html')).toBe('no-store');
    expect(cacheControlFor('landing.html')).toBe('no-store');
  });

  test('keeps fonts immutable for a year', () => {
    expect(cacheControlFor('fonts/hanken-grotesk-400-latin.woff2'))
      .toBe('public, max-age=31536000, immutable');
    expect(cacheControlFor('assets/fonts/martian-mono-500-latin.woff2'))
      .toBe('public, max-age=31536000, immutable');
  });

  // Hashed bundles keep express.static's ETag rather than being given a header
  // this function has no business inventing.
  test('says nothing about other assets', () => {
    expect(cacheControlFor('assets/index-a1b2c3d4.js')).toBeNull();
    expect(cacheControlFor('og-card.png')).toBeNull();
  });

  // relative() on Windows produces backslashes, and the rule is about the URL
  // shape rather than the host filesystem's separator.
  test('reads a Windows-style relative path', () => {
    expect(cacheControlFor('guides\\index.html'))
      .toBe('public, max-age=300, stale-while-revalidate=86400');
    expect(cacheControlFor('fonts\\body.woff2')).toBe('public, max-age=31536000, immutable');
  });
});
