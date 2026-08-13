/**
 * Cloud-mode auth against the server's EMBEDDED better-auth provider
 * (AUTH_PROVIDER=better-auth) — this replaced the Keycloak PKCE flow, so there
 * is no IdP redirect anymore: the login form is ours (components/AuthPage.tsx)
 * and the whole exchange stays on this origin under /api/auth/*.
 *
 * The SPA keeps its localStorage Bearer model from the Keycloak era: the
 * bearer() plugin returns the session token in the `set-auth-token` response
 * header on sign-in/sign-up, we store it, and api.ts attaches it as
 * `Authorization: Bearer` on every call. No cookies, no refresh dance — the
 * session lives 30 days server-side and a 401 clears the stored token.
 *
 * Enabled when VITE_CLOUD is set at build time (legacy builds that set
 * VITE_OIDC_ISSUER also count as cloud, so an old build recipe fails loud at
 * login rather than silently rendering the local no-auth app).
 */

const CLOUD = !!(import.meta.env.VITE_CLOUD || import.meta.env.VITE_OIDC_ISSUER);
const LS = 'chat-recall.session'; // { token }
const LEGACY_LS = 'chat-recall.oidc'; // Keycloak-era tokens — cleared on sight

export const isCloud = (): boolean => CLOUD;

/** True when a session token is already stored (sync; no server roundtrip).
 *  Lets the shell decide between the public landing and the app on first paint. */
export const hasStoredSession = (): boolean => !!localStorage.getItem(LS);

interface Stored { token: string }
const load = (): Stored | null => { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch { return null; } };
const save = (s: Stored) => localStorage.setItem(LS, JSON.stringify(s));
const clear = () => { localStorage.removeItem(LS); localStorage.removeItem(LEGACY_LS); };

/** /api/auth lives on the same origin as the API base. '' = same origin. */
function apiOrigin(): string {
  const base = import.meta.env.VITE_API_BASE || '/api';
  return base.replace(/\/api\/?$/, '');
}
const authUrl = (path: string) => `${apiOrigin()}/api/auth${path}`;

/** Current session token, or null when logged out. (No expiry bookkeeping —
 *  the server owns session lifetime; api.ts calls handleUnauthorized() on 401.) */
export async function getAccessToken(): Promise<string | null> {
  if (!CLOUD) return null;
  return load()?.token ?? null;
}

type AuthResult = { ok: true } | { ok: false; error: string };

async function authError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
  return body?.message || body?.error || `${fallback} (HTTP ${res.status})`;
}

/** Email + password sign-in. Stores the session token on success. */
export async function signInEmail(email: string, password: string): Promise<AuthResult> {
  const res = await fetch(authUrl('/sign-in/email'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const token = res.headers.get('set-auth-token');
  if (res.ok && token) { save({ token }); return { ok: true }; }
  return { ok: false, error: await authError(res, 'sign-in failed') };
}

/** Email + password sign-up (auto-signs-in). Stores the session token. */
export async function signUpEmail(name: string, email: string, password: string): Promise<AuthResult> {
  const res = await fetch(authUrl('/sign-up/email'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  });
  const token = res.headers.get('set-auth-token');
  if (res.ok && token) { save({ token }); return { ok: true }; }
  return { ok: false, error: await authError(res, 'sign-up failed') };
}

/** Approve or deny a CLI device-login request (?user_code=… on /device).
 *  GET /device first: it binds the pending code to THIS session, which the
 *  approve/deny endpoints require. */
export async function deviceDecision(userCode: string, approve: boolean): Promise<AuthResult> {
  const token = await getAccessToken();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const verify = await fetch(authUrl(`/device?user_code=${encodeURIComponent(userCode)}`), { headers });
  if (!verify.ok) return { ok: false, error: await authError(verify, 'device code lookup failed') };
  const res = await fetch(authUrl(approve ? '/device/approve' : '/device/deny'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ userCode }),
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: await authError(res, approve ? 'approval failed' : 'deny failed') };
}

/** Called by api.ts when a cloud API call comes back 401 with a token
 *  attached: the session is gone server-side. Clear it and return to the
 *  front door (landing) rather than leaving a half-dead app. */
export function handleUnauthorized(): void {
  if (!CLOUD || !hasStoredSession()) return;
  clear();
  window.location.assign('/');
}

export function logout(): void {
  const token = load()?.token;
  clear();
  if (!CLOUD) return;
  // Best-effort server-side revoke; the redirect must not wait on it.
  if (token) {
    void fetch(authUrl('/sign-out'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => {});
  }
  window.location.assign('/');
}
