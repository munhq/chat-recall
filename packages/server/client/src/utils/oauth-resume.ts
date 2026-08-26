/**
 * RESUMING AN MCP AUTHORIZE REQUEST ACROSS SIGN-IN.
 *
 * The remote MCP endpoint (/mcp) is an OAuth 2.1 protected resource, which is
 * what lets claude.ai, ChatGPT or a browser IDE connect with one click instead
 * of a device code. The flow is:
 *
 *   1. the client GETs /api/auth/mcp/authorize?response_type=code&client_id=…
 *   2. no session cookie yet, so better-auth 302s to the login page
 *   3. the visitor signs in or signs up
 *   4. >>> the authorize request must now be REPLAYED, with the cookie <<<
 *   5. better-auth issues the code and redirects to the client's callback
 *
 * Step 4 did not exist. A visitor arriving from claude.ai signed in and landed
 * in the dashboard; the authorization request was simply dropped, so the client
 * that sent them waited for a code that was never issued. Nothing was red — the
 * user was logged in, the dashboard worked, and the connector just never
 * finished. Two ways it was lost:
 *
 *   - the embedded email form keeps the URL, but nothing ever looked at it;
 *   - `signInSocial` sends the browser to Google/GitHub with a callbackURL of
 *     '/app', so the query was gone before it came back — and social is the path
 *     the connector WANTS, because a verified address is what grants the trial
 *     on the spot.
 *
 * So this module answers one question — "is there an authorize request waiting
 * in this URL?" — and builds the two paths that carry it. Pure and
 * search-injectable, like utils/checkout.ts, because the interesting cases are
 * the malformed ones and they cannot be reached through a browser.
 *
 * IT NEVER ECHOES ARBITRARY INPUT. Only the parameters the OAuth
 * authorization-code flow defines are copied, and they go back to OUR OWN
 * authorize endpoint, which validates redirect_uri against the registered
 * client. A key that is not on the list is dropped rather than forwarded.
 */

/** The authorization-code + PKCE request parameters, and nothing else. */
const AUTHORIZE_PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
  'resource',
  'nonce',
  'prompt',
  'login_hint',
] as const;

/** Where better-auth's MCP plugin mounts its authorization endpoint. */
export const AUTHORIZE_ENDPOINT = '/api/auth/mcp/authorize';

/**
 * The canonical query string of a pending authorize request, or null.
 *
 * Requires BOTH `client_id` and `response_type=code`. A visitor with a stray
 * `state` or `scope` in their URL — a share link, a marketing UTM tail — is not
 * mid-authorization, and treating them as if they were would bounce them into an
 * OAuth error page instead of the dashboard they asked for.
 */
export function pendingAuthorizeQuery(search?: string): string | null {
  try {
    const q = new URLSearchParams(search ?? window.location.search);
    if (!q.get('client_id')) return null;
    if (q.get('response_type') !== 'code') return null;
    const out = new URLSearchParams();
    for (const k of AUTHORIZE_PARAMS) {
      const v = q.get(k);
      if (v !== null && v !== '') out.set(k, v);
    }
    return out.toString() || null;
  } catch {
    return null;
  }
}

/**
 * The URL to send the browser to once a session exists — step 4. Same request,
 * now with a cookie, so better-auth answers with a code instead of a redirect
 * back to the login page.
 */
export function authorizeResumeUrl(search?: string): string | null {
  const q = pendingAuthorizeQuery(search);
  return q ? `${AUTHORIZE_ENDPOINT}?${q}` : null;
}

/**
 * Where a social sign-in should land, so the request survives the IdP round
 * trip. An app path rather than the authorize endpoint itself: the cookie is set
 * during the callback, and coming back through the SPA lets the normal gate
 * confirm the session before replaying the request. `/app` then carries the same
 * query, which is exactly what `authorizeResumeUrl` reads on arrival.
 */
export function postAuthorizeSignInPath(search?: string): string | null {
  const q = pendingAuthorizeQuery(search);
  return q ? `/app?${q}` : null;
}
