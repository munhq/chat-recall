/**
 * Which document an unmatched path should get: the app shell, or a 404.
 *
 * Factored out of server.ts for one reason — server.ts starts listening on
 * import, so nothing in it can be unit-tested. This is the same move the billing
 * route makes with `applyStripeEvent`: keep the decision pure, test the
 * decision, leave the wiring untested.
 *
 * WHAT WENT WRONG BEFORE: the catch-all returned the SPA shell with status 200
 * for every unmatched path. `/settings`, `/definitely-not-a-page`, every typo
 * and every retired inbound link answered 200 with an indexable document whose
 * canonical pointed at `/app` — a path robots.txt disallows. Google classes that
 * as a soft 404. Dead URLs enter the crawl set, crawl budget is spent on
 * addresses that do not exist, and a styled 404.html that was already being
 * built and shipped could never be reached.
 */

/**
 * The only paths the client owns.
 *
 * This is exhaustive rather than cautious: the client has no path-based router.
 * `services/url-state.ts` holds every piece of navigational state in QUERY
 * params on the current path, so there are no nested app routes to miss.
 * `/app/install/*` belongs to its own router and is matched long before the
 * catch-all.
 */
const APP_PATHS = new Set(['/app', '/app/', '/device', '/device/']);

export type StaticVerdict = 'app-shell' | 'not-found';

/**
 * Keep this an ALLOWLIST. What it replaces was effectively a denylist, and a
 * denylist of paths that do not exist can only ever be one unlisted path behind
 * — which is exactly how every unknown URL came to return 200.
 */
export function classifyStaticPath(path: string): StaticVerdict {
  return APP_PATHS.has(path) ? 'app-shell' : 'not-found';
}

/**
 * A build asset whose file name carries a content hash.
 *
 * Vite emits `assets/<name>-<hash><ext>`, and the hash is 8 base64url
 * characters (`index-C6u9GiO4.js`). Matching the HASH rather than the `assets/`
 * directory is deliberate: an unhashed file that lands in that directory must
 * not be given a year of immutability, because nothing would ever fetch the
 * replacement.
 */
/* The trailing segment must LOOK like a hash, which means carrying at least one
 * digit or one capital. Without that clause the pattern matched any file whose
 * name ends in a hyphen and a word of eight letters, and the site is full of
 * them: apple-touch-icon.png, conversation-overview.webp, project-overview.webp,
 * toolkit-coverage.webp and every og-guide-<slug>.png were all being served a
 * year of immutability under a name that will be REUSED by the next build. A
 * re-rendered card or a replaced touch icon would never reach a browser or a
 * CDN edge that had already seen the old bytes.
 *
 * Vite's hash is 8 base64url characters, so an all-lowercase-letter one occurs
 * about 0.03% of the time. That build's file falls through to the CDN default
 * and the next build's name clears it. */
const HASHED_ASSET = /-(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/**
 * What `Cache-Control` a file under STATIC_DIR should be served with.
 *
 * WHAT WENT WRONG BEFORE: the rule was `path.endsWith('index.html')`, written to
 * mean "the SPA shell". Every marketing page is `<slug>/index.html`, so every
 * one of them matched and was served `no-store` — while the comment above the
 * rule said marketing pages "get a short public TTL". Measured on production:
 * `curl -I https://<origin>/guides/<slug>/` answered `cache-control: no-store`.
 *
 * The cost is not a wrong header. It is that no browser, and no CDN, may keep a
 * marketing page for even a second: every repeat visitor and every crawler
 * re-downloads ~50KB of HTML from the origin, and a conditional request can
 * never be answered with a 304.
 *
 * Four cases, and only the first two are genuinely uncacheable:
 *
 *   index.html AT THE ROOT — the SPA shell. Must never be cached: a browser
 *     running a stale shell renders current data with outdated code, which is
 *     the worst kind of lie. (Its hashed JS and CSS stay cacheable; their names
 *     change per build, which is what the hash is for.)
 *   landing.html — served at '/', where the response varies on a session
 *     cookie. Cloudflare ignores `Vary: Cookie` below Enterprise, so an
 *     edge-cached '/' would eventually hand one kind of visitor the other's
 *     document.
 *   a font, or a content-hashed build asset — a year, and immutable. The name
 *     carries the version, so these bytes are the only bytes that name will
 *     ever have.
 *   everything else under a directory — a marketing page. No session in it, no
 *     personalisation, changes only on deploy.
 *
 * `path` is POSIX-relative to STATIC_DIR. Returning null means "say nothing",
 * and the lesson of the hashed-asset case below is that saying nothing hands
 * the decision to the CDN — so reach for null only where a default is harmless.
 * It leaves express.static's own ETag and Last-Modified in place.
 */
export function cacheControlFor(path: string): string | null {
  const rel = path.replace(/\\/g, '/').replace(/^\.?\//, '');

  if (rel === 'index.html' || rel === 'landing.html') return 'no-store';

  // A year, and immutable: a font's content is the whole reason its name exists.
  if (rel.startsWith('fonts/') || rel.includes('/fonts/')) {
    return 'public, max-age=31536000, immutable';
  }

  // Five minutes at the edge, a day of serving stale while it refreshes. Short
  // enough that a deploy is visible almost at once — Keel's roll is not instant
  // either — and long enough that a crawl or a burst of traffic does not hit the
  // origin for every page view.
  if (rel.endsWith('.html')) return 'public, max-age=300, stale-while-revalidate=86400';

  /* Marketing media under an UNHASHED name: a day, a week of serving stale.
   *
   * These used to fall through to the hashed-asset rule and get a year of
   * immutability under a name the next build reuses. An explicit value keeps the
   * decision here: returning null hands it to Cloudflare, which answered
   * `max-age=14400` on the bundle for the same reason recorded below. A day
   * matches how often a screenshot or a social card is re-rendered. */
  if (/\.(png|jpg|jpeg|webp|avif|gif|svg|ico|mp4|webm)$/.test(rel)) {
    return 'public, max-age=86400, stale-while-revalidate=604800';
  }

  // A content-hashed build asset. A year, and immutable, for the same reason a
  // font gets it: the hash IS the version, so the bytes behind this exact name
  // can never change. A new build emits a new name.
  //
  // WHAT WENT WRONG BEFORE: this function returned null here on purpose, to
  // "keep express.static's ETag rather than invent a header". Saying nothing
  // does not mean nothing is said — it means the CDN decides. Measured on
  // production: the 500KB main bundle answered `cache-control: public,
  // max-age=14400` and `cf-cache-status: REVALIDATED`. Four hours is a
  // Cloudflare default, not a policy anyone here chose, and it makes every
  // return visit after four hours revalidate the largest asset on the critical
  // path before the app can boot. An ETag turns that into a 304 instead of a
  // re-download, which is cheaper but still a round trip the hash makes
  // unnecessary.
  if (HASHED_ASSET.test(rel)) return 'public, max-age=31536000, immutable';

  return null;
}

/**
 * Whether a file served straight out of STATIC_DIR must carry
 * `X-Robots-Tag: noindex`.
 *
 * WHAT WENT WRONG BEFORE: the catch-all sets this header on `/app`, and
 * robots.txt disallowed `/app`, so between them the app shell was believed to
 * be unindexable. Neither reached the file at its OWN name. express.static is
 * mounted at the root, so `GET /index.html` answered 200 with the shell — 62
 * words of body text, a second brand `<title>`, and a canonical pointing at
 * `/app`. Nothing disallowed that path and nothing set a header on it.
 *
 * Its canonical pointed at `/app`, which robots.txt disallowed. A crawler that
 * cannot fetch `/app` cannot confirm that claim, so `/index.html` stayed
 * eligible for the index under its own address.
 *
 * Only the SHELL at the root. `guides/index.html` and every other marketing
 * page is also called `index.html`, and those are the pages the site exists to
 * get indexed — hence an exact match on the relative path, the same test
 * cacheControlFor already makes.
 */
export function robotsTagFor(path: string): string | null {
  const rel = path.replace(/\\/g, '/').replace(/^\.?\//, '');
  return rel === 'index.html' ? 'noindex' : null;
}
