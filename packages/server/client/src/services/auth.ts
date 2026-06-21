/**
 * Cloud-mode auth: OIDC Authorization Code + PKCE against Keycloak, for when
 * the dashboard talks to the cloud API (chat-recall.munhq.com) instead of the
 * local server. Dependency-free (no keycloak-js) — the flow is small and the
 * cloud API only needs a realm Bearer (server.mjs verifies it via JWKS).
 *
 * Enabled when VITE_OIDC_ISSUER is set at build time; otherwise the app runs
 * in local mode with no auth (getAccessToken() returns null, isCloud()=false).
 *
 *   VITE_OIDC_ISSUER     e.g. https://auth.munhq.com/realms/munhq
 *   VITE_OIDC_CLIENT_ID  default: chat-recall-web
 *   VITE_API_BASE        e.g. https://chat-recall.munhq.com/api
 */

const ISSUER = (import.meta.env.VITE_OIDC_ISSUER || '').replace(/\/+$/, '');
const CLIENT_ID = import.meta.env.VITE_OIDC_CLIENT_ID || 'chat-recall-web';
const LS = 'chat-recall.oidc'; // { access_token, refresh_token, expires_at }

export const isCloud = (): boolean => !!ISSUER;

/** True when a token is already stored (sync; doesn't refresh). Lets the shell
 *  decide between the public landing and the authenticated app on first paint. */
export const hasStoredSession = (): boolean => !!localStorage.getItem(LS);

/** True when the URL is an OIDC redirect callback (?code&state) coming back from
 *  Keycloak — in that case we must complete the exchange, not show the landing. */
export const isAuthCallback = (): boolean => {
  const q = new URLSearchParams(window.location.search);
  return q.has('code') && q.has('state');
};

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = () => b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
async function challenge(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

interface Stored { access_token: string; refresh_token?: string; expires_at: number }
const load = (): Stored | null => { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch { return null; } };
const save = (s: Stored) => localStorage.setItem(LS, JSON.stringify(s));
const clear = () => localStorage.removeItem(LS);
const redirectUri = () => window.location.origin + window.location.pathname;

function storeTokens(t: Record<string, unknown>): void {
  save({
    access_token: String(t.access_token),
    refresh_token: typeof t.refresh_token === 'string' ? t.refresh_token : undefined,
    expires_at: Date.now() + (Number(t.expires_in) || 60) * 1000,
  });
}

/** Begin login: redirect the browser to Keycloak's authorize endpoint (PKCE).
 *  Exported so the public landing page's "Get started" CTA can start the flow. */
export async function beginLogin(): Promise<void> {
  const verifier = rand();
  const state = rand();
  sessionStorage.setItem('oidc.v', verifier);
  sessionStorage.setItem('oidc.s', state);
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: redirectUri(),
    state,
    code_challenge: await challenge(verifier),
    code_challenge_method: 'S256',
  });
  window.location.assign(`${ISSUER}/protocol/openid-connect/auth?${p}`);
}

/** If we're returning from Keycloak (?code&state), exchange the code. Returns
 *  true if a callback was handled (URL is then cleaned). */
export async function handleRedirectCallback(): Promise<boolean> {
  const q = new URLSearchParams(window.location.search);
  const code = q.get('code');
  if (!code) return false;
  const expected = sessionStorage.getItem('oidc.s');
  if (!expected || q.get('state') !== expected) { clear(); return false; }
  const verifier = sessionStorage.getItem('oidc.v') || '';
  const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: CLIENT_ID, code,
      redirect_uri: redirectUri(), code_verifier: verifier,
    }),
  });
  if (res.ok) storeTokens(await res.json());
  sessionStorage.removeItem('oidc.v');
  sessionStorage.removeItem('oidc.s');
  window.history.replaceState({}, '', redirectUri()); // strip ?code&state
  return true;
}

async function refresh(rt: string): Promise<boolean> {
  const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: rt }),
  });
  if (!res.ok) { clear(); return false; }
  storeTokens(await res.json());
  return true;
}

/** Current access token (refreshing if near expiry), or null if not logged in. */
export async function getAccessToken(): Promise<string | null> {
  if (!isCloud()) return null;
  const s = load();
  if (!s) return null;
  if (Date.now() < s.expires_at - 30_000) return s.access_token;
  if (s.refresh_token && (await refresh(s.refresh_token))) return load()!.access_token;
  return null;
}

/** Ensure the user is logged in. Handles the redirect callback, then redirects
 *  to Keycloak if there's no valid token. Resolves with a token when present;
 *  if it triggers a redirect the promise never resolves (page navigates away). */
export async function ensureLogin(): Promise<string | null> {
  if (!isCloud()) return null;
  await handleRedirectCallback();
  const tok = await getAccessToken();
  if (tok) return tok;
  await beginLogin();
  return null; // navigating away
}

export function logout(): void {
  clear();
  if (isCloud()) window.location.assign(`${ISSUER}/protocol/openid-connect/logout?client_id=${CLIENT_ID}&post_logout_redirect_uri=${encodeURIComponent(redirectUri())}`);
}
