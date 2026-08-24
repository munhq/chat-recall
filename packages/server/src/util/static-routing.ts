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
