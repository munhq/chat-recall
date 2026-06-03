/**
 * Pluggable tenant auth. Selects a provider via AUTH_PROVIDER:
 *
 *   none          (default) — self-host single-tenant. No token; tenant='default'.
 *   static-token            — self-host multi-user. Bearer token → tenant via the
 *                             CHAT_RECALL_TOKENS env (JSON: {"<token>":"<tenant>"}).
 *   keycloak                — cloud. Verify a Keycloak JWT (JWKS) → tenant via
 *                             membership. Stubbed until the cloud phase wires it.
 *
 * Whatever the provider, the resolved tenant is made ambient for the whole
 * request via runWithTenant(), so the engine store factories scope to it with
 * no per-call-site changes. Fail-closed: an invalid/missing token is 401 in any
 * provider that requires one.
 */
import type { Request, Response, NextFunction } from 'express';
import { runWithTenant } from '../imports.js';

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

/** Resolve { tenant, userId } or null (a 401 has been sent). */
async function resolve(req: Request, res: Response): Promise<{ tenant: string; userId: string } | null> {
  switch (provider()) {
    case 'none':
      return { tenant: 'default', userId: 'local' };
    case 'static-token': {
      const tok = bearer(req);
      const tenant = tok ? staticTokens()[tok] : undefined;
      if (!tenant) { res.status(401).json({ error: 'invalid or missing token' }); return null; }
      return { tenant, userId: tok!.slice(0, 8) };
    }
    case 'keycloak':
      // Cloud phase: verify the JWT against Keycloak's JWKS, then map the
      // user's `sub` → team via the memberships table. Not wired yet.
      res.status(501).json({ error: 'keycloak auth not configured' });
      return null;
  }
}

export function tenantAuth(req: Request, res: Response, next: NextFunction): void {
  resolve(req, res)
    .then((r) => {
      if (!r) return; // 401/501 already sent
      req.tenant = r.tenant;
      req.userId = r.userId;
      runWithTenant(r.tenant, () => next());
    })
    .catch(next);
}
