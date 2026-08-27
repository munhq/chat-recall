/**
 * Device Authorization Grant (RFC 8628) for `chat-recall login` — two flavors,
 * picked by the target server's /api/capabilities `authProvider`:
 *
 *   better-auth  (betterAuthDeviceLogin) — the flow runs against the SERVER
 *                ITSELF (/api/auth/device/*). The token it returns is a
 *                better-auth session token; the server accepts it as a Bearer
 *                at /api/me, /api/teams* via its bearer plugin.
 *   keycloak     (deviceLogin, legacy) — the flow runs against the realm the
 *                server advertises as `oidcIssuer`. Returns a realm access
 *                token, verified server-side via JWKS.
 *
 * Either way the CLI can't host a redirect URI, so: mint a user_code, tell the
 * human to approve it in a browser, poll the token endpoint until they do.
 * There is NO baked-in issuer or server: everything is discovered from the
 * server being logged into. Self-host with AUTH_PROVIDER=none skips this flow
 * entirely (token / no-auth login).
 *
 * The Keycloak chat-recall-web client enforces PKCE (S256), so that flavor
 * carries a code_challenge on init and the matching code_verifier on the poll.
 */
import { createHash, randomBytes } from 'node:crypto';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Optional env fallback for the OIDC issuer. No hardcoded default — the value
 *  comes from the target server's /api/capabilities, `--issuer`, or this var. */
export const DEFAULT_ISSUER = process.env.CHAT_RECALL_OIDC_ISSUER || '';
export const DEFAULT_CLIENT_ID = 'chat-recall-web';

export interface DeviceTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the full device flow. `onPrompt` receives the human-facing instructions
 * (verification URL + code) so the caller controls presentation.
 */
/**
 * Read a device-code response, or say what answered instead.
 *
 * TWO FAILURES CAME THROUGH THIS ONE LINE (`await startRes.json()`):
 *
 *   - a 200 carrying HTML — a login wall or a parked domain — threw
 *     "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON", which names
 *     neither the host nor the fix;
 *   - a 200 carrying SOMEBODY ELSE'S JSON parsed fine, every field came back
 *     undefined, and the CLI printed
 *
 *         To log in, open:
 *           undefined
 *           (if prompted, enter code: undefined at undefined)
 *         Waiting for approval…
 *
 *     then polled a stranger's endpoint until the (undefined → NaN) deadline
 *     expired and reported "the code expired before approval". The user waited
 *     for a link that never existed.
 *
 * So: read as text, parse defensively, and require the three fields RFC 8628
 * makes mandatory before telling a human to go and approve something.
 */
async function readDeviceCode(res: Response, where: string): Promise<DeviceAuthResponse> {
  const text = await res.text().catch(() => '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `${where} answered ${res.status} with something that is not a device-code response `
      + `(${JSON.stringify(text.trim().slice(0, 60))}) — this host is not serving the chat-recall API`,
    );
  }
  const d = parsed as Partial<DeviceAuthResponse>;
  if (typeof d?.device_code !== 'string' || typeof d?.user_code !== 'string'
    || typeof d?.verification_uri !== 'string' || typeof d?.expires_in !== 'number') {
    throw new Error(
      `${where} answered ${res.status} with JSON that is not a device-code response `
      + `(${JSON.stringify(text.trim().slice(0, 60))}) — this host is not serving the chat-recall API`,
    );
  }
  return d as DeviceAuthResponse;
}

export async function deviceLogin(
  opts: { issuer?: string; clientId?: string; scope?: string },
  onPrompt: (p: { url: string; userCode: string; verificationUri: string }) => void,
): Promise<DeviceTokens> {
  const issuer = (opts.issuer || DEFAULT_ISSUER).replace(/\/+$/, '');
  if (!issuer) {
    throw new Error(
      'No OIDC issuer configured for SSO login. Pass --issuer <url>, set '
      + 'CHAT_RECALL_OIDC_ISSUER, or log in with a token instead: '
      + '`chat-recall login <server-url> --token <token>` '
      + '(self-host with AUTH_PROVIDER=none needs no token at all).',
    );
  }
  const clientId = opts.clientId || DEFAULT_CLIENT_ID;
  const scope = opts.scope || 'openid email profile';

  // PKCE: the client requires S256. Verifier is held until the token poll.
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());

  const startRes = await fetch(`${issuer}/protocol/openid-connect/auth/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope, code_challenge: codeChallenge, code_challenge_method: 'S256' }),
  });
  if (!startRes.ok) {
    throw new Error(`device-auth init failed: HTTP ${startRes.status} ${await startRes.text().catch(() => '')}`);
  }
  const start = await readDeviceCode(startRes, issuer);

  onPrompt({
    url: start.verification_uri_complete || start.verification_uri,
    userCode: start.user_code,
    verificationUri: start.verification_uri,
  });

  const tokenUrl = `${issuer}/protocol/openid-connect/token`;
  const deadline = Date.now() + start.expires_in * 1000;
  let interval = (start.interval ?? 5) * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        // RFC 8628 §3.4 — the exact URN matters: 'grant-type' is part of it.
        // The truncated 'urn:ietf:params:oauth:device_code' made Keycloak
        // reject every poll with unsupported_grant_type (found by the first
        // real new-user onboarding test, 2026-07-03).
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: start.device_code,
        client_id: clientId,
        code_verifier: codeVerifier,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && typeof body.access_token === 'string') {
      return {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
        expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 0,
      };
    }
    // RFC 8628 §3.5: keep polling on these, back off on slow_down, fail otherwise.
    const err = body.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += 5000; continue; }
    if (err === 'expired_token') break;
    throw new Error(`device-auth failed: ${String(err || `HTTP ${res.status}`)}`);
  }
  throw new Error('device-auth timed out — the code expired before approval.');
}

/** Client id the CLI presents to the server's embedded provider. A public
 *  identifier (not a secret) — the server pins it via validateClient. */
export const BETTER_AUTH_CLI_CLIENT_ID = 'chat-recall-cli';

/**
 * Device flow against the server's EMBEDDED better-auth provider
 * (AUTH_PROVIDER=better-auth): POST /api/auth/device/code, send the human to
 * the server's own /device page, poll /api/auth/device/token. Same RFC 8628
 * poll semantics as the Keycloak flavor; JSON bodies instead of form-encoded.
 */
export async function betterAuthDeviceLogin(
  serverUrl: string,
  onPrompt: (p: { url: string; userCode: string; verificationUri: string }) => void,
): Promise<DeviceTokens> {
  const base = serverUrl.replace(/\/+$/, '');
  const startRes = await fetch(`${base}/api/auth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: BETTER_AUTH_CLI_CLIENT_ID }),
  });
  if (!startRes.ok) {
    throw new Error(`device-auth init failed: HTTP ${startRes.status} ${await startRes.text().catch(() => '')}`);
  }
  const start = await readDeviceCode(startRes, base);

  onPrompt({
    url: start.verification_uri_complete || start.verification_uri,
    userCode: start.user_code,
    verificationUri: start.verification_uri,
  });

  const deadline = Date.now() + start.expires_in * 1000;
  let interval = (start.interval ?? 5) * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const res = await fetch(`${base}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: start.device_code,
        client_id: BETTER_AUTH_CLI_CLIENT_ID,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && typeof body.access_token === 'string') {
      return {
        accessToken: body.access_token,
        expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 0,
      };
    }
    // RFC 8628 §3.5 — same contract as the Keycloak flavor.
    const err = body.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += 5000; continue; }
    if (err === 'expired_token' || err === 'access_denied') {
      throw new Error(err === 'access_denied' ? 'device-auth denied in the browser.' : 'device-auth timed out — the code expired before approval.');
    }
    throw new Error(`device-auth failed: ${String(err || `HTTP ${res.status}`)}`);
  }
  throw new Error('device-auth timed out — the code expired before approval.');
}
