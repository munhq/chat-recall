/**
 * Pluggable tenant auth. Selects a provider via AUTH_PROVIDER:
 *
 *   none          (default) — self-host single-tenant. No token; tenant='default'.
 *   static-token            — self-host multi-user. Bearer token → tenant via the
 *                             CHAT_RECALL_TOKENS env (JSON: {"<token>":"<tenant>"}).
 *   keycloak                — cloud. Verify a Keycloak JWT (JWKS) → tenant via
 *                             team membership (control plane). The client sends
 *                             `x-team: <slug>` to pick a team; with exactly one
 *                             membership the header is optional.
 *
 * In every provider, a Bearer token starting with `ct_` is treated as an
 * AGENT (device) token and resolved through the control plane — this is how
 * the local binary and the MCP remote mode authenticate without a browser.
 *
 * Whatever the provider, the resolved tenant is made ambient for the whole
 * request via runWithTenant(), so the engine store factories scope to it with
 * no per-call-site changes. Fail-closed: an invalid/missing token is 401 in any
 * provider that requires one.
 */
import type { Request, Response, NextFunction } from 'express';
import { runWithTenant, createControlPlane } from '../imports.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: string;
      userId?: string;
    }
  }
}

type Provider = 'none' | 'static-token' | 'keycloak';

function provider(): Provider {
  const p = (process.env.AUTH_PROVIDER || 'none').toLowerCase();
  return p === 'static-token' || p === 'keycloak' ? p : 'none';
}

let tokenMap: Record<string, string> | null = null;
function staticTokens(): Record<string, string> {
  if (tokenMap) return tokenMap;
  try { tokenMap = JSON.parse(process.env.CHAT_RECALL_TOKENS || '{}'); }
  catch { tokenMap = {}; }
  return tokenMap!;
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/.exec(req.get('authorization') || '');
  return m ? m[1] : null;
}

// ── Keycloak JWT verification (lazy jose + remote JWKS, cached) ─────────
let _jwks: ReturnType<typeof import('jose').createRemoteJWKSet> | null = null;
let _jwtVerify: typeof import('jose').jwtVerify | null = null;

async function verifyKeycloakJwt(token: string): Promise<{ sub: string; email: string | null; roles: string[] } | null> {
  const jwksUrl = process.env.OIDC_JWKS_URL;
  if (!jwksUrl) return null;
  if (!_jwks || !_jwtVerify) {
    const jose = await import('jose');
    _jwks = jose.createRemoteJWKSet(new URL(jwksUrl));
    _jwtVerify = jose.jwtVerify;
  }
  try {
    const { payload } = await _jwtVerify(
      token,
      _jwks,
      process.env.OIDC_ISSUER ? { issuer: process.env.OIDC_ISSUER } : {},
    );
    if (typeof payload.sub !== 'string') return null;
    // Audience pinning: accept only tokens minted FOR our client — not any
    // valid token from the realm (another app's SPA token would otherwise
    // pass). Keycloak puts the requesting client id in `azp`; audience
    // mappers may also add it to `aud`. Set OIDC_ALLOWED_AZP=* to disable
    // (self-host realms with exotic client setups).
    const allowedAzp = process.env.OIDC_ALLOWED_AZP || 'chat-recall-web';
    if (allowedAzp !== '*') {
      const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
      if (payload.azp !== allowedAzp && !aud.includes(allowedAzp)) return null;
    }
    const email = (payload.email || payload.preferred_username) as string | undefined;
    // Keycloak realm roles live in `realm_access.roles`. Used by requireAdmin
    // to gate platform-operator endpoints on the `chat-recall-admin` role.
    const realmAccess = payload.realm_access as { roles?: unknown } | undefined;
    const roles = Array.isArray(realmAccess?.roles)
      ? (realmAccess!.roles as unknown[]).filter((r): r is string => typeof r === 'string')
      : [];
    return { sub: payload.sub, email: email ?? null, roles };
  } catch {
    return null;
  }
}

/** Realm role that marks a Keycloak user as a chat-recall platform operator. */
export const ADMIN_ROLE = 'chat-recall-admin';

/**
 * Gate a route for platform operators (cross-tenant, mounted BEFORE tenantAuth).
 *
 *   keycloak provider → the Bearer JWT must carry the `chat-recall-admin` realm
 *                        role (`AUTH_DEV_USER=1` + `x-dev-admin: 1` is a local
 *                        escape hatch, same pattern as requireUser()).
 *   any other provider → x-admin-key must equal ADMIN_KEY. Unset ADMIN_KEY ⇒
 *                        the endpoint is disabled (fail-closed), mirroring the
 *                        team-bootstrap admin guard in routes/teams.ts.
 *
 * Returns true when allowed; otherwise sends 401/403 and returns false.
 */
export async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  if (provider() === 'keycloak') {
    if (process.env.AUTH_DEV_USER === '1' && req.get('x-dev-admin') === '1') return true;
    const tok = bearer(req);
    const user = tok ? await verifyKeycloakJwt(tok) : null;
    if (!user) { res.status(401).json({ error: 'login required' }); return false; }
    if (!user.roles.includes(ADMIN_ROLE)) {
      res.status(403).json({ error: `requires the '${ADMIN_ROLE}' realm role` });
      return false;
    }
    return true;
  }
  const key = process.env.ADMIN_KEY;
  if (!key) { res.status(403).json({ error: 'admin endpoints disabled (ADMIN_KEY not set)' }); return false; }
  if ((req.get('x-admin-key') || '') !== key) { res.status(401).json({ error: 'admin key required' }); return false; }
  return true;
}

/** Resolve a Keycloak user (JWT) for routes that need identity, not a tenant
 *  (team create/join). Returns null after sending a 401. */
export async function requireUser(req: Request, res: Response): Promise<{ sub: string; email: string | null } | null> {
  // Local/dev: AUTH_DEV_USER=1 lets `x-dev-user: <id>` stand in for a login.
  if (process.env.AUTH_DEV_USER === '1') {
    const u = req.get('x-dev-user');
    if (u) return { sub: u, email: `${u}@dev.local` };
  }
  const tok = bearer(req);
  const user = tok ? await verifyKeycloakJwt(tok) : null;
  if (!user) { res.status(401).json({ error: 'login required' }); return null; }
  return user;
}

/**
 * Resolve an agent (device) token → tenant, or null.
 *
 * Positive results are cached for 30s: ct_ tokens authenticate EVERY data-plane
 * request (sync uploads, MCP remote), and opening a control-plane handle per
 * request is the hot-path cost. Positive-only — a freshly minted token must
 * never be shadowed by a cached miss. The TTL bounds revocation latency to 30s
 * per server replica (each replica has its own cache), which is acceptable for
 * a manual "revoke device" action.
 */
const AGENT_TOKEN_TTL_MS = 30_000;
const agentTokenCache = new Map<string, { tenant: string; userId: string; expires: number }>();

async function resolveAgentToken(tok: string): Promise<{ tenant: string; userId: string } | null> {
  const hit = agentTokenCache.get(tok);
  if (hit && hit.expires > Date.now()) return { tenant: hit.tenant, userId: hit.userId };
  const cp = await createControlPlane();
  try {
    const info = await cp.resolveAgentToken(tok);
    if (!info) return null;
    const entry = { tenant: info.tenant, userId: `device:${info.deviceId}`, expires: Date.now() + AGENT_TOKEN_TTL_MS };
    // Crude size cap — a scan of garbage tokens must not grow this unbounded.
    // (Garbage never lands here — negatives aren't cached — but tenants with
    // thousands of devices are.) Clearing rebuilds within one TTL window.
    if (agentTokenCache.size >= 5000) agentTokenCache.clear();
    agentTokenCache.set(tok, entry);
    return { tenant: entry.tenant, userId: entry.userId };
  } finally {
    await cp.close();
  }
}

/** Resolve { tenant, userId } or null (a 401 has been sent). */
async function resolve(req: Request, res: Response): Promise<{ tenant: string; userId: string } | null> {
  const tok = bearer(req);

  // Agent tokens work in EVERY provider — they're how the binary and the
  // MCP remote mode talk to the server.
  if (tok && tok.startsWith('ct_')) {
    const agent = await resolveAgentToken(tok);
    if (agent) return agent;
    res.status(401).json({ error: 'invalid agent token' });
    return null;
  }

  switch (provider()) {
    case 'none':
      return { tenant: 'default', userId: 'local' };
    case 'static-token': {
      const tenant = tok ? staticTokens()[tok] : undefined;
      if (!tenant) { res.status(401).json({ error: 'invalid or missing token' }); return null; }
      return { tenant, userId: tok!.slice(0, 8) };
    }
    case 'keycloak': {
      const user = tok ? await verifyKeycloakJwt(tok) : null;
      if (!user) {
        // Dev-header escape hatch mirrors requireUser().
        if (process.env.AUTH_DEV_USER === '1') {
          const u = req.get('x-dev-user');
          if (u) return resolveTenantForUser(req, res, { sub: u, email: null });
        }
        res.status(401).json({ error: 'login required' });
        return null;
      }
      return resolveTenantForUser(req, res, user);
    }
  }
}

/** Map a verified user to a tenant via team membership (+ x-team header). */
async function resolveTenantForUser(
  req: Request,
  res: Response,
  user: { sub: string; email: string | null },
): Promise<{ tenant: string; userId: string } | null> {
  const cp = await createControlPlane();
  try {
    const memberships = await cp.listMemberships(user.sub);
    const wanted = req.get('x-team');
    if (wanted) {
      if (!memberships.some((m) => m.team_slug === wanted)) {
        res.status(403).json({ error: `not a member of team '${wanted}'` });
        return null;
      }
      return { tenant: wanted, userId: user.sub };
    }
    if (memberships.length === 1) return { tenant: memberships[0].team_slug, userId: user.sub };
    if (memberships.length === 0) {
      res.status(403).json({ error: 'no team yet — create one via POST /api/teams' });
      return null;
    }
    res.status(400).json({
      error: 'multiple teams — pass the x-team header',
      teams: memberships.map((m) => m.team_slug),
    });
    return null;
  } finally {
    await cp.close();
  }
}

export function tenantAuth(req: Request, res: Response, next: NextFunction): void {
  resolve(req, res)
    .then((r) => {
      if (!r) return; // 401/403 already sent
      req.tenant = r.tenant;
      req.userId = r.userId;
      runWithTenant(r.tenant, () => next());
    })
    .catch(next);
}
