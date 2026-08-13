/**
 * Better Auth instance for AUTH_PROVIDER=better-auth — the embedded auth
 * provider that replaces Keycloak for the cloud deployment.
 *
 * Identity contract: the better-auth `user.id` plays the role the Keycloak
 * `sub` played everywhere else (teams.owner_sub, memberships.user_sub,
 * agent_tokens.user_sub, author_sub attribution). Migrated Keycloak users are
 * imported with their ORIGINAL sub as the user id (scripts/
 * import-keycloak-users.mjs), so no data row changes owner.
 *
 * Transport: the web SPA and the CLI both send `Authorization: Bearer
 * <session token>` — the bearer() plugin resolves it, so the server never
 * depends on cookies (the SPA kept its localStorage model from the Keycloak
 * era). The CLI obtains its session token via the device-authorization plugin
 * (RFC 8628: POST /api/auth/device/code → user approves at /device in the web
 * app → POST /api/auth/device/token returns the session token), then trades it
 * for a long-lived ct_ device token exactly as before — nothing downstream of
 * login changed.
 *
 * Tables (user/session/account/verification/deviceCode) are created by
 * better-auth's own migrator at boot (runAuthMigrations), in the same Postgres
 * database as the control plane. They carry no tenant column, so the RLS loop
 * in pg-schema.ts never touches them.
 */
import { betterAuth } from 'better-auth';
import { bearer, deviceAuthorization } from 'better-auth/plugins';
import pg from 'pg';

/** Client id the CLI presents on the device flow. Not a secret (a public
 *  client, like chat-recall-web was in Keycloak) — validateClient pins it so
 *  garbage client ids fail loudly instead of minting codes. */
export const CLI_CLIENT_ID = 'chat-recall-cli';

function baseURL(): string {
  const url = process.env.BETTER_AUTH_URL || process.env.APP_URL || `http://127.0.0.1:${process.env.PORT || 5000}`;
  return url.replace(/\/+$/, '');
}

function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    // validateAuthConfig() already refuses to boot without it; this guard
    // keeps the invariant if getAuth() is ever reached another way.
    throw new Error('BETTER_AUTH_SECRET must be set when AUTH_PROVIDER=better-auth');
  }
  // Own small pool, separate from the engine's pg-pool: better-auth's kysely
  // adapter holds the pool for the process lifetime, and the auth surface must
  // never compete with the data plane for the engine pool's connections.
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL,
    max: Number(process.env.AUTH_PG_POOL_MAX) || 5,
  });
  return betterAuth({
    baseURL: baseURL(),
    basePath: '/api/auth',
    secret,
    database: pool,
    trustedOrigins: (process.env.TRUSTED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    emailAndPassword: {
      enabled: true,
      // No SMTP is configured for chat-recall yet, so email verification must
      // stay off — requiring it with no mail path locks every new user out
      // (the exact invisiprompt bug this line exists to not repeat).
      requireEmailVerification: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days, matching the ct_ token culture
    },
    plugins: [
      bearer(),
      deviceAuthorization({
        expiresIn: '10m',
        interval: '5s',
        // Resolved against baseURL → https://<host>/device, served by the SPA
        // fallback; the web app renders the approve/deny view there.
        verificationUri: '/device',
        validateClient: (clientId: string) => clientId === CLI_CLIENT_ID,
      }),
    ],
  });
}

let _auth: ReturnType<typeof createAuth> | null = null;

export function getAuth(): ReturnType<typeof createAuth> {
  if (!_auth) _auth = createAuth();
  return _auth;
}

/** Create/upgrade the better-auth tables. Called once at boot (server.ts),
 *  before the HTTP handler is mounted — same fail-fast contract as
 *  ensurePgSchema(). */
export async function runAuthMigrations(): Promise<void> {
  const { getMigrations } = await import('better-auth/db/migration');
  const { runMigrations } = await getMigrations(getAuth().options);
  await runMigrations();
}

/** Resolve the better-auth session (cookie or Bearer) on an Express request.
 *  Returns the identity in the exact shape verifyKeycloakJwt returned, so the
 *  middleware treats both providers identically. */
export async function getSessionUser(
  reqHeaders: Record<string, string | string[] | undefined>,
): Promise<{ sub: string; email: string | null; roles: string[] } | null> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const session = await getAuth().api.getSession({ headers });
  if (!session?.user?.id) return null;
  const email = session.user.email ?? null;
  // Operator role: Keycloak had the `chat-recall-admin` realm role; the
  // embedded provider grants it to the ADMIN_EMAILS allowlist instead
  // (comma-separated, case-insensitive) — same mechanism invisiprompt uses.
  const admins = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const roles = email && admins.includes(email.toLowerCase()) ? ['chat-recall-admin'] : [];
  return { sub: session.user.id, email, roles };
}
