/**
 * Cloud-mode auth against the server's EMBEDDED better-auth provider
 * (AUTH_PROVIDER=better-auth) — this replaced the Keycloak PKCE flow, so there
 * is no IdP redirect anymore: the login form is ours (components/AuthPage.tsx)
 * and the whole exchange stays on this origin under /api/auth/*.
 *
 * ── The session is an httpOnly cookie, NOT a stored token ───────────────────
 *
 * It used to be a Bearer token in localStorage, inherited from the Keycloak era
 * and carried through the better-auth migration out of momentum rather than
 * intent. That model rests on one assumption — that no script the app did not
 * ship ever runs on this origin — and it pays for a broken assumption with the
 * whole session, because any script on the page can read localStorage and post
 * the token somewhere else. A CSP now makes that hard (server.ts), but defense
 * in depth means not leaving the credential readable in the first place.
 *
 * An httpOnly cookie cannot be read by script at all. An injected script can
 * still make requests as the user while the page is open, which is bad, but it
 * cannot walk away with a credential that stays valid after the tab closes.
 *
 * The server needed no change to accept this: getSessionUser() forwards the raw
 * request headers to better-auth, which reads its own cookie. The bearer()
 * plugin stays mounted for the CLI and the MCP server, which are not browsers
 * and hold their tokens in a 600 file.
 *
 * The cost is that "am I signed in" stops being a synchronous localStorage read.
 * It is now one /api/auth/get-session call at boot (main.tsx). That is the
 * honest shape of the question — only the server ever knew the real answer, and
 * the old sync check was really asking "is there a string in localStorage",
 * which was true for revoked and expired sessions too.
 *
 * Enabled when VITE_CLOUD is set at build time (legacy builds that set
 * VITE_OIDC_ISSUER also count as cloud, so an old build recipe fails loud at
 * login rather than silently rendering the local no-auth app).
 */

import { checkoutReturnPath } from '../utils/checkout';
import { postAuthorizeSignInPath } from '../utils/oauth-resume';

const CLOUD = !!(import.meta.env.VITE_CLOUD || import.meta.env.VITE_OIDC_ISSUER);
// Both are pre-cookie storage keys. Nothing writes them any more; they are
// cleared on sight so a token minted before the cutover cannot sit in a browser
// profile for 30 days as a second, weaker credential for the same account.
const LEGACY_KEYS = ['chat-recall.session', 'chat-recall.oidc'];

export const isCloud = (): boolean => CLOUD;

/** Drop any pre-cookie token. Safe to call on every boot. */
export function clearLegacyTokens(): void {
  try { for (const k of LEGACY_KEYS) localStorage.removeItem(k); } catch { /* storage blocked */ }
}

/** /api/auth lives on the same origin as the API base. '' = same origin. */
function apiOrigin(): string {
  const base = import.meta.env.VITE_API_BASE || '/api';
  return base.replace(/\/api\/?$/, '');
}
const authUrl = (path: string) => `${apiOrigin()}/api/auth${path}`;

/**
 * Ask the server whether this browser has a live session.
 *
 * The only source of truth. Returns false on any network or parse failure,
 * which is the safe direction: a false negative shows the public landing, a
 * false positive would render the app shell and then throw on every call.
 */
export async function isSignedIn(): Promise<boolean> {
  if (!CLOUD) return false;
  try {
    const res = await fetch(authUrl('/get-session'), {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { user?: { id?: string } } | null;
    return !!body?.user?.id;
  } catch {
    return false;
  }
}

type AuthResult = { ok: true } | { ok: false; error: string };

async function authError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
  return body?.message || body?.error || `${fallback} (HTTP ${res.status})`;
}

/** Email + password sign-in. The session arrives as an httpOnly cookie; there
 *  is deliberately nothing to store on this side. */
export async function signInEmail(email: string, password: string): Promise<AuthResult> {
  const res = await fetch(authUrl('/sign-in/email'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.ok) { clearLegacyTokens(); return { ok: true }; }
  return { ok: false, error: await authError(res, 'sign-in failed') };
}

/** Email + password sign-up (auto-signs-in). Same cookie contract as sign-in. */
export async function signUpEmail(name: string, email: string, password: string): Promise<AuthResult> {
  const res = await fetch(authUrl('/sign-up/email'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  });
  if (res.ok) { clearLegacyTokens(); return { ok: true }; }
  return { ok: false, error: await authError(res, 'sign-up failed') };
}

/**
 * Ask for a reset link.
 *
 * Resolves ok for ANY address, including one with no account. That is the
 * server's contract ("If this email exists in our system, check your email"),
 * and mirroring it here matters: a UI that said "no such user" would turn the
 * reset form into an account-enumeration oracle for anyone with a word list.
 */
export async function requestPasswordReset(email: string): Promise<AuthResult> {
  // /request-password-reset, NOT /forget-password. better-auth 1.6.27 answers
  // 404 on the older name — it survives only inside the rate limiter's path
  // matcher, so hitting it returns 429 under load and 404 otherwise, which
  // reads like a working endpoint right up until nobody gets an email.
  // Verified against production: /request-password-reset → 200.
  const res = await fetch(authUrl('/request-password-reset'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, redirectTo: '/app?view=reset' }),
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: await authError(res, 'could not send the reset link') };
}

/** Set a new password using the token from the emailed link. The token is
 *  single-use and expires after an hour, so a stale link fails here rather
 *  than silently doing nothing. */
export async function resetPassword(token: string, newPassword: string): Promise<AuthResult> {
  const res = await fetch(authUrl('/reset-password'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, newPassword }),
  });
  if (res.ok) { clearLegacyTokens(); return { ok: true }; }
  return { ok: false, error: await authError(res, 'could not reset the password') };
}

/**
 * Which social providers the SERVER has credentials for.
 *
 * Asked rather than assumed: a provider whose id or secret is missing is not
 * registered at all, so rendering its button would send the user to an IdP
 * error page. /api/capabilities is public and already reports authProvider, so
 * this costs no extra round trip beyond the one the shell makes anyway.
 * Returns [] on any failure — the email form always works, so the safe
 * direction is to show fewer options rather than broken ones.
 */
export async function socialProviders(): Promise<string[]> {
  if (!CLOUD) return [];
  try {
    const res = await fetch(`${apiOrigin()}/api/capabilities`, { headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    const body = (await res.json().catch(() => null)) as { socialProviders?: unknown } | null;
    return Array.isArray(body?.socialProviders) ? body!.socialProviders.filter((p): p is string => typeof p === 'string') : [];
  } catch { return []; }
}

/**
 * Start a social sign-in. better-auth answers with a redirect URL rather than
 * redirecting itself, so the browser navigation happens here.
 *
 * `callbackURL` is where the IdP round trip lands the user afterwards. It must
 * be an app path, not the sign-in page, or a successful login bounces back to
 * a form that no longer applies.
 */
/**
 * Where the IdP round trip should land.
 *
 * '/app' unless the visitor arrived mid-purchase: a completed Stripe Checkout
 * carries a session_id that exists nowhere else and is the only route back to a
 * self-host licence serial, so signing in must not discard it. Anything else is
 * ignored — this builds the path, it never echoes arbitrary input.
 */
function postSignInPath(): string {
  // The MCP authorize request comes FIRST. A visitor sent here by claude.ai is
  // mid-authorization, and landing them on '/app' drops the request: the client
  // waits for a code that is never issued, while the user sees a working
  // dashboard and no error. See utils/oauth-resume.ts.
  return postAuthorizeSignInPath() ?? checkoutReturnPath() ?? '/app';
}

export async function signInSocial(provider: string): Promise<AuthResult> {
  const res = await fetch(authUrl('/sign-in/social'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, callbackURL: postSignInPath() }),
  });
  if (!res.ok) return { ok: false, error: await authError(res, `${provider} sign-in failed`) };
  const body = (await res.json().catch(() => null)) as { url?: string; redirect?: boolean } | null;
  if (!body?.url) return { ok: false, error: `${provider} did not return a redirect URL` };
  window.location.assign(body.url);
  return { ok: true };
}

/**
 * Ask for another confirmation mail.
 *
 * The one action available to an account that has signed up and not confirmed,
 * and it had no UI at all: the address could be a typo, the mail could be in
 * spam, or the first send could simply have failed, and the only recovery was to
 * make a second account.
 */
export async function resendVerificationEmail(email: string): Promise<AuthResult> {
  const res = await fetch(authUrl('/email-otp/send-verification-otp'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, type: 'email-verification' }),
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: await authError(res, 'could not resend the confirmation code') };
}

/**
 * Finish verification with the code from the mail.
 *
 * The whole reason a code beats a link for this product: it completes HERE,
 * in the tab the person signed up in, rather than in whichever browser their
 * mail client happens to open.
 */
export async function verifyEmailWithOtp(email: string, otp: string): Promise<AuthResult> {
  const res = await fetch(authUrl('/email-otp/verify-email'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, otp }),
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: await authError(res, 'that code did not work') };
}

/** Approve or deny a CLI device-login request (?user_code=… on /device).
 *  GET /device first: it binds the pending code to THIS session, which the
 *  approve/deny endpoints require. Both calls carry the session cookie. */
export async function deviceDecision(userCode: string, approve: boolean): Promise<AuthResult> {
  const init: RequestInit = {
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
  };
  const verify = await fetch(authUrl(`/device?user_code=${encodeURIComponent(userCode)}`), init);
  if (!verify.ok) return { ok: false, error: await authError(verify, 'device code lookup failed') };
  const res = await fetch(authUrl(approve ? '/device/approve' : '/device/deny'), {
    ...init,
    method: 'POST',
    body: JSON.stringify({ userCode }),
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: await authError(res, approve ? 'approval failed' : 'deny failed') };
}

/** Called by api.ts when a cloud API call comes back 401: the session is gone
 *  server-side. Return to the front door rather than leaving a half-dead app.
 *
 *  Guarded against a redirect loop — the landing itself makes no authenticated
 *  calls, but a 401 storm from a background poller must not re-trigger this
 *  once we are already on the way out. */
let leaving = false;
export function handleUnauthorized(): void {
  if (!CLOUD || leaving) return;
  leaving = true;
  clearLegacyTokens();
  // Carry a completed Stripe Checkout through the sign-in bounce.
  //
  // The session_id in the purchase redirect is the ONLY way back to a self-host
  // buyer's licence serial, and it exists nowhere else. Dropping it on a 401 —
  // which is likely, since checkout returns before the session settles — left a
  // paying customer with no route to the thing they bought. It is not a
  // credential for anything but its own purchase, so preserving it grants
  // nothing extra.
  window.location.assign(checkoutReturnPath() ?? '/');
}

export function logout(): void {
  clearLegacyTokens();
  if (!CLOUD) { window.location.assign('/'); return; }
  // Revoke server-side, THEN leave. Unlike the old token model there is nothing
  // we can delete locally to end the session, so a redirect that races the
  // revoke would leave a live cookie behind on a shared machine. The catch
  // keeps a failed revoke from stranding the user in a signed-in-looking app.
  void fetch(authUrl('/sign-out'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
    .catch(() => {})
    .finally(() => window.location.assign('/'));
}
