/**
 * OIDC Device Authorization Grant (RFC 8628) for `chat-recall login`.
 *
 * The CLI can't host a redirect URI, so we use the device flow: ask Keycloak
 * for a user_code, tell the human to approve it in a browser, then poll the
 * token endpoint until they do. Returns the realm access token — server.mjs
 * (`authUser`) verifies it via JWKS, so it's accepted at /api/me, /api/teams*.
 *
 * Defaults target the hotmun cloud realm; both are overridable for self-host.
 *
 * The chat-recall-web client enforces PKCE (S256), so the device flow carries
 * a code_challenge on init and the matching code_verifier on the token poll.
 */
import { createHash, randomBytes } from 'node:crypto';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const DEFAULT_ISSUER = 'https://auth.hotmun.com/realms/hotmun';
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
export async function deviceLogin(
  opts: { issuer?: string; clientId?: string; scope?: string },
  onPrompt: (p: { url: string; userCode: string; verificationUri: string }) => void,
): Promise<DeviceTokens> {
  const issuer = (opts.issuer || DEFAULT_ISSUER).replace(/\/+$/, '');
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
  const start = (await startRes.json()) as DeviceAuthResponse;

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
