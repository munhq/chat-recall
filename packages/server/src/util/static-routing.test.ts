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
import { classifyStaticPath, cacheControlFor, robotsTagFor } from './static-routing.js';

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

  // THE REGRESSION THIS REPLACED: these returned null, so the origin sent no
  // Cache-Control at all and Cloudflare applied its own four-hour default to the
  // largest asset on the boot path. Saying nothing is not neutral; it delegates.
  test('keeps a content-hashed build asset immutable for a year', () => {
    for (const asset of [
      'assets/index-a1b2c3d4.js',
      'assets/index-C6u9GiO4.js',
      'assets/index-CxtuYwZl.css',
      'assets/vendor-react-BE_SqJGT.js',
    ]) {
      expect(cacheControlFor(asset)).toBe('public, max-age=31536000, immutable');
    }
  });

  // The rule keys off the HASH, not the directory. A file that lands in assets/
  // without one is a file whose name can be reused by a later build, and a year
  // of immutability would strand every browser that already holds the old bytes.
  test('says nothing about an unhashed file', () => {
    expect(cacheControlFor('assets/short-abc.js')).toBeNull();
  });

  // A HASH CARRIES A DIGIT OR A CAPITAL. Without that clause the pattern read
  // any "-<eight or more letters>.<ext>" as a hash, and the site is full of
  // those: measured on the built output, apple-touch-icon.png,
  // conversation-overview.webp, project-overview.webp, toolkit-coverage.webp
  // and every og-guide-<slug>.png were served a year of immutability under
  // names the next build reuses. Re-rendering a social card could then never
  // reach a browser or a CDN edge that had already seen the old bytes.
  test('does not mistake an English word for a content hash', () => {
    for (const name of [
      'apple-touch-icon.png',
      'conversation-overview.webp',
      'project-overview.webp',
      'toolkit-coverage.webp',
      'og-guide-claude-continue-alternative.png',
      'og-guide-does-claude-code-remember-previous-sessions.png',
    ]) {
      expect(cacheControlFor(name)).toBe('public, max-age=86400, stale-while-revalidate=604800');
    }
  });

  // Real names emitted by this project's own Vite build. If a future config
  // changes the hash alphabet, this is the test that says so.
  test('still recognises a real Vite hash', () => {
    for (const name of [
      'assets/index-C2oprdCQ.js',
      'assets/index-CxtuYwZl.css',
      'assets/App-Biam4zwc.js',
      'assets/react-DAXJ19zV.js',
      'assets/useDocumentScroll-HddF02lS.js',
    ]) {
      expect(cacheControlFor(name)).toBe('public, max-age=31536000, immutable');
    }
  });

  // Unhashed media carries an explicit short public TTL. Returning null hands
  // the decision to Cloudflare, which is the failure the hashed-asset comment
  // above already records.
  test('gives unhashed media an explicit day', () => {
    expect(cacheControlFor('og-card.png')).toBe('public, max-age=86400, stale-while-revalidate=604800');
    expect(cacheControlFor('assets/logo.svg')).toBe('public, max-age=86400, stale-while-revalidate=604800');
    expect(cacheControlFor('favicon.ico')).toBe('public, max-age=86400, stale-while-revalidate=604800');
  });

  // relative() on Windows produces backslashes, and the rule is about the URL
  // shape rather than the host filesystem's separator.
  test('reads a Windows-style relative path', () => {
    expect(cacheControlFor('guides\\index.html'))
      .toBe('public, max-age=300, stale-while-revalidate=86400');
    expect(cacheControlFor('fonts\\body.woff2')).toBe('public, max-age=31536000, immutable');
    expect(cacheControlFor('assets\\index-C6u9GiO4.js'))
      .toBe('public, max-age=31536000, immutable');
  });
});

describe('robotsTagFor', () => {
  // The defect this was written for. express.static mounts at the root, so the
  // SPA shell has a URL at its own file name, and that URL answered 200 with 62
  // words of body text and a canonical pointing at a path robots.txt disallowed.
  test('noindexes the SPA shell at the root', () => {
    expect(robotsTagFor('index.html')).toBe('noindex');
    expect(robotsTagFor('./index.html')).toBe('noindex');
    expect(robotsTagFor('/index.html')).toBe('noindex');
  });

  // The pages the site exists to get indexed are ALSO called index.html. A
  // substring or endsWith() test here would noindex the whole marketing site,
  // which is the one failure mode worth a test of its own.
  test('leaves every marketing page alone', () => {
    for (const page of [
      'guides/index.html',
      'guides/claude-continue-alternative/index.html',
      'pricing/index.html',
      'landing.html',
      '404.html',
    ]) {
      expect(robotsTagFor(page)).toBeNull();
    }
  });

  test('reads a Windows-style relative path', () => {
    expect(robotsTagFor('guides\\index.html')).toBeNull();
  });
});
