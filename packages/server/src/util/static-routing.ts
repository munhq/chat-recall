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
 * Three cases, and only the first two are genuinely uncacheable:
 *
 *   index.html AT THE ROOT — the SPA shell. Must never be cached: a browser
 *     running a stale shell renders current data with outdated code, which is
 *     the worst kind of lie. (Its hashed JS and CSS stay cacheable; their names
 *     change per build, which is what the hash is for.)
 *   landing.html — served at '/', where the response varies on a session
 *     cookie. Cloudflare ignores `Vary: Cookie` below Enterprise, so an
 *     edge-cached '/' would eventually hand one kind of visitor the other's
 *     document.
 *   everything else under a directory — a marketing page. No session in it, no
 *     personalisation, changes only on deploy.
 *
 * `path` is POSIX-relative to STATIC_DIR. Returning null means "say nothing",
 * which leaves express.static's own ETag and Last-Modified in place.
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

  return null;
}
