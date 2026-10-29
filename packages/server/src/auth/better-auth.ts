/**
 * Better Auth instance for AUTH_PROVIDER=better-auth — the embedded auth
 * provider of the hosted service and of a self-host install.
 *
 * Identity contract: the better-auth `user.id` plays the role the Keycloak
 * `sub` played everywhere else (teams.owner_sub, memberships.user_sub,
 * agent_tokens.user_sub, author_sub attribution). Migrated Keycloak users are
 * imported with their ORIGINAL sub as the user id, so no data row changes owner.
 *
 * Transport: the web SPA and the CLI both send `Authorization: Bearer
 * <session token>` — the bearer() plugin resolves it. The CLI obtains its
 * session token via the device-authorization plugin (RFC 8628: POST
 * /api/auth/device/code → user approves at /device in the web app → POST
 * /api/auth/device/token), then trades it for a long-lived ct_ device token.
 *
 * The fleet settings come from `@munhq/auth` and `@munhq/mcp-kit` when the
 * build carries them (util/auth-kit.ts). A self-host build carries neither,
 * and `localCore`, `localDevice`, `localMcp`, `localCimd` and the guard of
 * auth/mcp-redirects.ts give it the same settings. The kits were written from
 * this file, so the two agree.
 *
 * Remote MCP: better-auth 1.7 is the OAuth 2.1 authorization server
 * (`@better-auth/mcp` on `@better-auth/oauth-provider`). Access tokens are JWTs
 * with the MCP resource as audience, signed with the key of `jwt()` and checked
 * against the key set of the instance (`verifyMcpBearer`). Clients registered
 * under 1.6 keep working: `setAside16Tables` and `copy16Grants` move them and
 * their live refresh tokens around better-auth's own migration.
 *
 * Tables are created by better-auth's own migrator at boot (runAuthMigrations),
 * in the same Postgres database as the control plane. They carry no tenant
 * column, so the RLS loop in pg-schema.ts never touches them.
 */
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { bearer, deviceAuthorization, emailOTP, jwt, twoFactor } from 'better-auth/plugins';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { verifyJwsAccessToken } from 'better-auth/oauth2';
import { mcp, type McpOptions } from '@better-auth/mcp';
import { cimd, type CimdOptions } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcpRedirectGuard as localRedirectGuard } from './mcp-redirects.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sendMail, resetPasswordMail, verifyOtpMail } from './mailer.js';
import { funnelKit } from '../util/product-kit.js';
import { authKit, mcpKit } from '../util/auth-kit.js';

/** How long a reset link stays valid. One hour: long enough to survive a slow
 *  mail relay and a user who reads mail on a different device, short enough
 *  that a link sitting in an inbox is not a standing credential. */
const RESET_TOKEN_TTL_SECONDS = 60 * 60;

/** The scopes an MCP connector asks for. `offline_access` gives the refresh token. */
export const MCP_SCOPES = ['openid', 'profile', 'email', 'offline_access'];

/** Where the remote MCP endpoint is mounted (routes/mcp.ts). */
const MCP_PATH = '/mcp';

/** The role of an operator: an address in ADMIN_EMAILS. middleware/auth.ts checks it. */
const OPERATOR_ROLE = 'chat-recall-admin';

/**
 * Social providers, each enabled only when BOTH its id and secret are present.
 *
 * The chart mounts these keys optional and the ansible task creates them empty,
 * so an unconfigured provider is the normal state of a fresh install. A provider
 * with an empty clientId makes better-auth advertise a button that fails at the
 * IdP with an opaque error, hence the pair check.
 */
function socialProviders(): Record<string, { clientId: string; clientSecret: string }> {
  const out: Record<string, { clientId: string; clientSecret: string }> = {};
  const pairs = {
    google: [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET],
    github: [process.env.GITHUB_CLIENT_ID, process.env.GITHUB_CLIENT_SECRET],
  } as const;
  for (const [name, [id, secret]] of Object.entries(pairs)) {
    if (id && secret) out[name] = { clientId: id, clientSecret: secret };
  }
  return out;
}

/** Which social providers are live, for the client to render buttons for. */
export function enabledSocialProviders(): string[] {
  return Object.keys(socialProviders());
}

/** Where the reset link lands in the SPA after better-auth consumes the token. */
export const RESET_CALLBACK_PATH = '/app?view=reset';

/**
 * Build the password-reset link that goes in the email.
 *
 * better-auth hands us `url` against its own basePath —
 * `/api/auth/reset-password/<token>?callbackURL=…` — and that GET consumes the
 * token and redirects the browser to the callback.
 *
 * better-auth ALWAYS emits its own `?callbackURL=`, blank when the caller passed
 * no redirectTo. Appending a second one made the endpoint parse an array and
 * answer VALIDATION_ERROR, so every emailed link rendered raw JSON. Setting the
 * parameter on a parsed URL keeps exactly one. `@munhq/auth` has the same
 * function, which its `resetCallbackPath` uses on a kit build.
 */
export function resetLinkFor(url: string): string {
  const kit = authKit();
  if (kit) return kit.resetLinkFor(url, RESET_CALLBACK_PATH);
  const u = new URL(url);
  u.searchParams.set('callbackURL', RESET_CALLBACK_PATH);
  return u.toString();
}

/** Client id the CLI presents on the device flow. Not a secret (a public
 *  client) — validateClient pins it so garbage client ids fail loudly instead
 *  of minting codes. */
export const CLI_CLIENT_ID = 'chat-recall-cli';

/** The kit's funnel plugin, or none. `loadProductKit()` runs at boot, before
 *  the first `getAuth()`, so the answer is fixed by the time this is read. */
function funnelPlugins() {
  const f = funnelKit();
  return f ? [f.funnel()] : [];
}

function baseURL(): string {
  const url = process.env.BETTER_AUTH_URL || process.env.APP_URL || `http://127.0.0.1:${process.env.PORT || 5000}`;
  return url.replace(/\/+$/, '');
}

/** The canonical MCP resource: the origin plus the endpoint path. Tokens carry it as their audience. */
export function mcpResourceUrl(): string {
  return `${new URL(baseURL()).origin}${MCP_PATH}`;
}

/** The `iss` of the access tokens: what `jwt()` uses with no issuer of its own. */
export function authIssuer(): string {
  return `${baseURL()}/api/auth`;
}

function trustedOrigins(): string[] {
  const extra = (process.env.TRUSTED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([baseURL(), ...extra])];
}

/**
 * The core settings of a self-host build: what `fleetAuth` of `@munhq/auth`
 * gives a kit build, with this server's own mails.
 *
 * - The confirmation mail is sent, and an UNCONFIRMED user can still sign in.
 *   The gate is the trial grant (util/trial.ts ensureTrial): one failed SMTP
 *   send locked a new invisiprompt user out of the account they had just made.
 * - The confirmation is a 6-digit CODE (the emailOTP plugin below). Corporate
 *   mail scanners GET every link and spend the token before the human clicks,
 *   and a link opened on a phone lands in a different session.
 * - Sessions last 7 days, rolling: `updateAge` refreshes a session older than a
 *   day, so anyone who uses the product in a week is never signed out.
 * - The cookie is httpOnly, SameSite=Lax (the CLI device flow opens /device
 *   from a terminal, a top-level cross-site navigation that Strict signs out),
 *   and Secure exactly when the base URL is https.
 * - A social sign-in links to the existing account with the same VERIFIED
 *   email (both providers return a primary verified address), never across
 *   different emails: the identity contract keys every owned row on user.id,
 *   and a second account would split ownership of synced data.
 */
function localCore(database: pg.Pool): BetterAuthOptions {
  return {
    appName: 'chat-recall',
    baseURL: baseURL(),
    basePath: '/api/auth',
    secret: process.env.BETTER_AUTH_SECRET,
    database,
    trustedOrigins: trustedOrigins(),
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
    },
    emailAndPassword: {
      enabled: true,
      // The length `@munhq/auth` sets, so the sign-up form states one rule for both builds.
      minPasswordLength: 12,
      requireEmailVerification: false,
      resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_SECONDS,
      // Without this, /forget-password answers 400 and a forgotten password is
      // unrecoverable: there is no other credential path.
      sendResetPassword: async ({ user, url }) => {
        await sendMail(resetPasswordMail(user.email, resetLinkFor(url), RESET_TOKEN_TTL_SECONDS / 60));
      },
    },
    socialProviders: socialProviders(),
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google', 'github'],
        allowDifferentEmails: false,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      useSecureCookies: baseURL().startsWith('https://'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip'] },
    },
  };
}

/** The 6-digit code, stored hashed, for 15 minutes: a sign-up on a laptop read on a phone is routinely slower than the 5-minute default. */
function localEmailOTP() {
  return emailOTP({
    sendVerificationOnSignUp: true,
    expiresIn: 900,
    storeOTP: 'hashed',
    sendVerificationOTP: async ({ email, otp, type }) => {
      await sendMail(verifyOtpMail(email, otp, type));
    },
  });
}

/** The CLI device login (RFC 8628), with the client id pinned. */
function localDevice() {
  return {
    expiresIn: '10m' as const,
    interval: '5s' as const,
    verificationUri: '/device',
    validateClient: (clientId: string) => clientId === CLI_CLIENT_ID,
  };
}

/**
 * The MCP authorization server. A connector registers before anybody signs in
 * (claude.ai and ChatGPT do), so open dynamic registration needs both flags.
 * The login page is the SPA's /app, which replays the authorize request once a
 * session exists (client/src/utils/oauth-resume.ts). 1.7 builds the redirect as
 * `<page>?<signed query>`, so each page is a path with no query of its own.
 */
function localMcp(): McpOptions {
  return {
    resource: mcpResourceUrl(),
    loginPage: '/app',
    consentPage: '/consent',
    scopes: MCP_SCOPES,
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
  };
}

/** A client_id that is an https URL is fetched, checked and stored (Smithery connects this way). */
function localCimd(): CimdOptions {
  return { fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' };
}

/** The options of the instance: the kits when the build carries them, else the local settings. */
export function authOptions(database: pg.Pool) {
  const a = authKit();
  const m = mcpKit();
  const core: BetterAuthOptions = a
    ? a.fleetAuth({
      appName: 'chat-recall',
      database,
      baseURL: baseURL(),
      trustedOrigins: trustedOrigins(),
      brand: { name: 'chat-recall' },
      resetCallbackPath: RESET_CALLBACK_PATH,
      extend: { socialProviders: socialProviders() },
    })
    : localCore(database);
  const mcpOptions = m
    ? m.fleetMcp({ baseURL: baseURL(), resourcePath: MCP_PATH, loginPage: '/app', consentPage: '/consent', scopes: MCP_SCOPES })
    : localMcp();
  return {
    ...core,
    // Counted in the database, so the replicas share one limit.
    ...(a && { rateLimit: a.fleetRateLimit('database') }),
    plugins: [
      bearer(),
      // Every auth step as a funnel event (@munhq/product-kit). Absent on a build without the kit.
      ...funnelPlugins(),
      a ? a.fleetEmailOTP() : localEmailOTP(),
      // TOTP only, no SMS: an authenticator app costs nothing to run, and SIM swap defeats SMS.
      twoFactor(a ? a.fleetTwoFactor('chat-recall') : { issuer: 'chat-recall' }),
      deviceAuthorization(a ? a.fleetDevice(CLI_CLIENT_ID) : localDevice()),
      // Signs the MCP access tokens; /api/auth/jwks serves the key set.
      jwt(),
      mcp(mcpOptions),
      cimd(m ? m.fleetCimd() : localCimd()),
      // Registration is open, so only the callbacks of the known MCP clients and loopback are accepted.
      m ? m.mcpRedirectGuard() : localRedirectGuard(),
    ],
  } satisfies BetterAuthOptions;
}

function createAuth() {
  if (!process.env.BETTER_AUTH_SECRET) {
    // validateAuthConfig() already refuses to boot without it; this guard
    // keeps the invariant if getAuth() is ever reached another way.
    throw new Error('BETTER_AUTH_SECRET must be set when AUTH_PROVIDER=better-auth');
  }
  // Own small pool, separate from the engine's pg-pool: the auth surface must
  // never compete with the data plane for the engine pool's connections.
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL,
    max: Number(process.env.AUTH_PG_POOL_MAX) || 5,
  });
  return betterAuth(authOptions(pool));
}

let _auth: ReturnType<typeof createAuth> | null = null;
function getAuth(): ReturnType<typeof createAuth> {
  if (!_auth) _auth = createAuth();
  return _auth;
}

/** The auth instance, for the MCP endpoint of `@munhq/mcp-kit` (routes/mcp.ts). */
export function mcpAuthInstance(): ReturnType<typeof createAuth> {
  return getAuth();
}

/** TESTS ONLY: drop the instance, so the next call builds it from the current kits and environment. */
export async function __resetAuth(): Promise<void> {
  const pool = _auth ? (_auth.options as { database: pg.Pool }).database : null;
  _auth = null;
  await pool?.end().catch(() => {});
}

/** TESTS ONLY: the instance, for a test that drives better-auth's API directly. */
export function __auth(): ReturnType<typeof createAuth> {
  return getAuth();
}

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

/** Express/Node adapter for every /api/auth/* route. */
export function authHandler(): NodeHandler {
  return toNodeHandler(getAuth()) as NodeHandler;
}

/**
 * The 1.6 paths of the MCP authorization server, to the 1.7 paths.
 *
 * A connector learns the token endpoint once, at connect time, and refreshes
 * against it for as long as it stays connected. Each connector of a 1.6 server
 * holds `/api/auth/mcp/token`, so that path must keep answering.
 */
export const LEGACY_MCP_PATHS: Record<string, string> = {
  '/api/auth/mcp/authorize': '/api/auth/oauth2/authorize',
  '/api/auth/mcp/token': '/api/auth/oauth2/token',
  '/api/auth/mcp/register': '/api/auth/oauth2/register',
  '/api/auth/mcp/userinfo': '/api/auth/oauth2/userinfo',
  '/api/auth/mcp/jwks': '/api/auth/jwks',
};

/**
 * The OAuth discovery documents at the origin root (RFC 9728, RFC 8414, OIDC).
 *
 * A client gets one URL, https://<host>/mcp, and finds the rest at fixed
 * well-known paths on that origin. better-auth serves each document under
 * /api/auth; this maps every root alias to it, so each document has one source.
 * `wellKnownRoutes` of `@munhq/mcp-kit` holds the same map.
 */
export const WELL_KNOWN_ROUTES: Record<string, string> = {
  '/.well-known/oauth-authorization-server': '/.well-known/oauth-authorization-server/api/auth',
  '/.well-known/oauth-authorization-server/api/auth': '/.well-known/oauth-authorization-server/api/auth',
  '/.well-known/openid-configuration': '/api/auth/.well-known/openid-configuration',
  '/.well-known/openid-configuration/api/auth': '/api/auth/.well-known/openid-configuration',
  '/api/auth/.well-known/openid-configuration': '/api/auth/.well-known/openid-configuration',
  '/.well-known/oauth-protected-resource': '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp': '/.well-known/oauth-protected-resource/mcp',
};

/** A Node handler for the discovery documents; it answers 404 for a path it does not know. */
export function wellKnownNodeHandler(): NodeHandler {
  const auth = getAuth();
  const m = mcpKit();
  const handler = m
    ? m.wellKnownHandler({ handler: auth.handler, options: { basePath: '/api/auth' } }, { resourcePath: MCP_PATH })
    : async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const target = WELL_KNOWN_ROUTES[url.pathname.replace(/\/+$/, '')];
      if (!target) return new Response('Not Found', { status: 404 });
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
      const res = await auth.handler(new Request(new URL(target, url), { method: request.method, headers: request.headers }));
      // A browser-based client (the MCP inspector, a web IDE) reads these cross-origin. They are public.
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    };
  return toNodeHandler(handler) as NodeHandler;
}

type HeaderSource = Record<string, string | string[] | undefined>;

function bearerOf(headers: HeaderSource): string | null {
  const raw = headers.authorization ?? headers.Authorization;
  const h = Array.isArray(raw) ? raw[0] : raw;
  const m = /^Bearer\s+(.+)$/i.exec(h ?? '');
  return m ? m[1].trim() : null;
}

/** An MCP access token that verified: its user, its client and its scopes. */
export interface McpGrant {
  userId: string;
  clientId: string | null;
  scopes: string[];
  token: string;
}

/**
 * Check the bearer of a request as an MCP access token: a JWT signed with the
 * key of `jwt()`, issued by this server, for the MCP resource, and not expired.
 * Null for any other bearer (a session token, a ct_ token), so a caller can
 * try this after its other checks.
 */
export async function verifyMcpBearer(headers: HeaderSource): Promise<McpGrant | null> {
  const token = bearerOf(headers);
  if (!token || token.split('.').length !== 3) return null;
  const auth = getAuth();
  try {
    const payload = await verifyJwsAccessToken(token, {
      // The keys come from the instance itself: no HTTP round trip to our own /jwks.
      jwksFetch: async () => (await auth.api.getJwks()) as never,
      jwksCacheKey: auth,
      verifyOptions: { issuer: authIssuer(), audience: mcpResourceUrl() },
    });
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    const claims = payload as { scope?: unknown; azp?: unknown; client_id?: unknown };
    const client = claims.azp ?? claims.client_id;
    return {
      userId: payload.sub,
      clientId: typeof client === 'string' ? client : null,
      scopes: typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [],
      token,
    };
  } catch {
    return null;
  }
}

function authPool(): pg.Pool {
  return (getAuth().options as { database: pg.Pool }).database;
}

/** Operators: the addresses in ADMIN_EMAILS, case ignored. `@munhq/auth` has the same check. */
function rolesFor(email: string | null): string[] {
  const kit = authKit();
  if (kit) return kit.isAdminEmail(email) ? [OPERATOR_ROLE] : [];
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return email && admins.includes(email.trim().toLowerCase()) ? [OPERATOR_ROLE] : [];
}

/**
 * The user behind an MCP access token, in the shape of `getSessionUser`.
 *
 * The remote MCP endpoint's tools call back through /api with the caller's
 * access token, so middleware/auth.ts accepts it too.
 */
export async function mcpTokenUser(headers: HeaderSource): Promise<{ sub: string; email: string | null; roles: string[] } | null> {
  const grant = await verifyMcpBearer(headers);
  if (!grant) return null;
  let email: string | null = null;
  try {
    const { rows } = await authPool().query<{ email: string | null }>('SELECT email FROM "user" WHERE id = $1 LIMIT 1', [grant.userId]);
    email = rows[0]?.email ?? null;
  } catch {
    // The grant is valid; a failed lookup only costs the operator role.
  }
  return { sub: grant.userId, email, roles: rolesFor(email) };
}

/**
 * The user of the session that the cookie or the bearer session token names,
 * with the operator role when the address is in ADMIN_EMAILS. Null when there
 * is no live session.
 */
export async function getSessionUser(headers: HeaderSource): Promise<{ sub: string; email: string | null; roles: string[] } | null> {
  const session = await getAuth().api.getSession({ headers: fromNodeHeaders(headers) });
  if (!session?.user?.id) return null;
  const email = session.user.email ?? null;
  return { sub: session.user.id, email, roles: rolesFor(email) };
}

/** SHA-256, base64url with no padding: how @better-auth/oauth-provider stores a client secret and a token. */
export function storedHash(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

async function columnExists(client: pg.PoolClient, table: string, column: string): Promise<boolean> {
  const r = await client.query(
    'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
    [table, column],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Step 1 of the move from the 1.6 `mcp()` plugin: set its tables aside.
 *
 * 1.6 and 1.7 both name a table `oauthAccessToken` and `oauthConsent`, with
 * other columns. better-auth's migrator only adds columns to a table that
 * exists, so it would bolt the 1.7 columns onto the 1.6 rows. The 1.6 tables
 * get the suffix `_v16` first, and the migrator then creates the 1.7 tables.
 * Runs only while the 1.6 shape is there; a second boot finds nothing to do.
 */
export async function setAside16Tables(pool: pg.Pool): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('chat-recall:oauth-16-to-17'))");
    let moved = false;
    if (await columnExists(client, 'oauthAccessToken', 'accessToken')) {
      await client.query('ALTER TABLE "oauthAccessToken" RENAME TO "oauthAccessToken_v16"');
      moved = true;
    }
    if (await columnExists(client, 'oauthConsent', 'consentGiven')) {
      await client.query('ALTER TABLE "oauthConsent" RENAME TO "oauthConsent_v16"');
      moved = true;
    }
    await client.query('COMMIT');
    return moved;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Step 2: copy the 1.6 clients and their live refresh tokens into the 1.7 tables.
 *
 * - Each `oauthApplication` row becomes an `oauthClient` row with the same
 *   client id, so a connector that registered under 1.6 is still known, and
 *   is linked to the MCP resource. A client secret is stored hashed, as 1.7
 *   stores it.
 * - Each refresh token that has not expired becomes an `oauthRefreshToken` row,
 *   hashed, bound to the MCP resource. The connector's next refresh then gets a
 *   1.7 access token, and nobody has to connect again.
 *
 * Idempotent: a client id or a token that is there already is skipped. A token
 * of a user who is gone is skipped, and a client keeps its owner only while that
 * user exists: both columns reference "user". Runs after better-auth's
 * migrator, which creates the 1.7 tables.
 */
export async function copy16Grants(pool: pg.Pool, resource: string): Promise<{ clients: number; refreshTokens: number }> {
  const client = await pool.connect();
  try {
    if (!(await columnExists(client, 'oauthApplication', 'redirectUrls'))) return { clients: 0, refreshTokens: 0 };
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('chat-recall:oauth-16-to-17'))");
    const apps = await client.query<{
      id: string; name: string | null; icon: string | null; clientId: string; clientSecret: string | null;
      redirectUrls: string | null; disabled: boolean | null; userId: string | null;
      createdAt: Date | null; updatedAt: Date | null;
    }>('SELECT id, name, icon, "clientId", "clientSecret", "redirectUrls", disabled, "userId", "createdAt", "updatedAt" FROM "oauthApplication"');
    // The MCP resource, as better-auth seeds it on its first lookup. A copied
    // client is linked to it below, and 1.7 issues a token for a resource only
    // to a client linked to it ("invalid_target" otherwise).
    await client.query(
      `INSERT INTO "oauthResource" (id, identifier, name, "dpopBoundAccessTokensRequired", disabled, "policyVersion", "createdAt", "updatedAt")
       VALUES ($1, $2, $2, false, false, 1, now(), now()) ON CONFLICT (identifier) DO NOTHING`,
      [randomUUID(), resource],
    );
    let clients = 0;
    for (const a of apps.rows) {
      const redirectUris = (a.redirectUrls ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const secret = a.clientSecret ? storedHash(a.clientSecret) : null;
      const r = await client.query(
        `INSERT INTO "oauthClient" (id, "clientId", "clientSecret", disabled, "userId", "createdAt", "updatedAt", name, icon,
            "redirectUris", "tokenEndpointAuthMethod", "grantTypes", "responseTypes", "requirePKCE", scopes)
         SELECT $1, $2, $3, $4, (SELECT id FROM "user" WHERE id = $5), $6, $7, $8, $9, $10, $11, $12, $13, true, $14
          WHERE NOT EXISTS (SELECT 1 FROM "oauthClient" WHERE "clientId" = $2)`,
        [
          a.id, a.clientId, secret, a.disabled ?? false, a.userId, a.createdAt ?? new Date(), a.updatedAt ?? new Date(),
          a.name, a.icon, JSON.stringify(redirectUris), secret ? 'client_secret_basic' : 'none',
          JSON.stringify(['authorization_code', 'refresh_token']), JSON.stringify(['code']), JSON.stringify(MCP_SCOPES),
        ],
      );
      clients += r.rowCount ?? 0;
      await client.query(
        `INSERT INTO "oauthClientResource" (id, "clientId", "resourceId", "createdAt")
         SELECT $1, $2, $3, now()
          WHERE EXISTS (SELECT 1 FROM "oauthClient" WHERE "clientId" = $2)
            AND NOT EXISTS (SELECT 1 FROM "oauthClientResource" WHERE "clientId" = $2 AND "resourceId" = $3)`,
        [randomUUID(), a.clientId, resource],
      );
    }
    let refreshTokens = 0;
    if (await columnExists(client, 'oauthAccessToken_v16', 'refreshToken')) {
      const live = await client.query<{
        refreshToken: string; refreshTokenExpiresAt: Date; clientId: string; userId: string; scopes: string | null; createdAt: Date | null;
      }>(
        `SELECT "refreshToken", "refreshTokenExpiresAt", "clientId", "userId", scopes, "createdAt" FROM "oauthAccessToken_v16"
          WHERE "refreshToken" IS NOT NULL AND "refreshTokenExpiresAt" > now()
            AND "clientId" IN (SELECT "clientId" FROM "oauthClient")
            AND "userId" IN (SELECT id FROM "user")`,
      );
      for (const t of live.rows) {
        const scopes = (t.scopes ?? '').split(/[\s,]+/).filter(Boolean);
        const r = await client.query(
          `INSERT INTO "oauthRefreshToken" (id, token, "clientId", "userId", resources, "expiresAt", "createdAt", scopes)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8
            WHERE NOT EXISTS (SELECT 1 FROM "oauthRefreshToken" WHERE token = $2)`,
          [
            storedHash(`v16:${t.refreshToken}`).slice(0, 32), storedHash(t.refreshToken), t.clientId, t.userId,
            JSON.stringify([resource]), t.refreshTokenExpiresAt, t.createdAt ?? new Date(),
            JSON.stringify(scopes.length ? scopes : MCP_SCOPES),
          ],
        );
        refreshTokens += r.rowCount ?? 0;
      }
    }
    await client.query('COMMIT');
    return { clients, refreshTokens };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Create or upgrade the auth tables at boot, and move the grants of a 1.6 server. */
export async function runAuthMigrations(): Promise<{ clients: number; refreshTokens: number }> {
  const auth = getAuth();
  await setAside16Tables(authPool());
  const { getMigrations } = await import('better-auth/db/migration');
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  return copy16Grants(authPool(), mcpResourceUrl());
}
