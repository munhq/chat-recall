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
import {
  bearer, deviceAuthorization, mcp, oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata,
} from 'better-auth/plugins';
import { toNodeHandler } from 'better-auth/node';
import type { IncomingMessage, ServerResponse } from 'node:http';
import pg from 'pg';
import { sendMail, resetPasswordMail, verifyEmailMail } from './mailer.js';

/** How long a reset link stays valid. One hour: long enough to survive a slow
 *  mail relay and a user who reads mail on a different device, short enough
 *  that a link sitting in an inbox is not a standing credential. */
const RESET_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * Social providers, each enabled only when BOTH its id and secret are present.
 *
 * Same shape as the SMTP config: the chart mounts these keys optional and the
 * ansible task creates them empty, so an unconfigured provider is the normal
 * state of a fresh install. Passing a provider with an empty clientId makes
 * better-auth advertise a button that fails at the IdP with an opaque error,
 * which is worse than not offering it at all — hence the pair check rather
 * than a truthy check on one variable.
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
 * token and redirects the browser to the callback, so the SPA gets a normal page
 * load and never parses a token out of a path.
 *
 * We must SET callbackURL, never APPEND it. better-auth ALWAYS emits its own
 * `?callbackURL=`, blank when the caller passed no redirectTo, so appending
 * produced two of them:
 *
 *   …/reset-password/TOK?callbackURL=&callbackURL=%2Fapp%3Fview%3Dreset
 *
 * The endpoint parses that as an array and answers VALIDATION_ERROR
 * ("[query.callbackURL] Invalid input: expected string, received array"), so the
 * emailed link rendered raw JSON instead of a password form — for every user,
 * unconditionally. Setting the parameter on a parsed URL makes a duplicate
 * impossible rather than merely absent today.
 *
 * Exported solely so this is covered by a test; nothing else should call it.
 */
export function resetLinkFor(url: string): string {
  const u = new URL(url);
  u.searchParams.set('callbackURL', RESET_CALLBACK_PATH);
  return u.toString();
}

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
    // Send the confirmation mail, and let an UNCONFIRMED user still sign in.
    //
    // The gate is on the trial, not the login (see util/trial.ts ensureTrial):
    // requireEmailVerification below would block the first login, so one flaky
    // SMTP send locks a new user out of an account they just created. Withholding
    // the trial instead costs an unconfirmed visitor nothing visible while
    // withholding the only thing that spends money — ingest, embeddings and
    // summaries — which is what stops a bot signup being expensive.
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendMail(verifyEmailMail(user.email, url));
      },
    },
    emailAndPassword: {
      enabled: true,
      // Still false, and deliberately. Verification gates the FIRST login, so a
      // transient SMTP failure would lock a new user out of an account they just
      // created (the exact invisiprompt bug this line exists to not repeat). The
      // confirmation is enforced where it actually matters instead — the trial
      // grant in util/trial.ts — so an unconfirmed address can sign in and see
      // the product but cannot cost us ingest.
      requireEmailVerification: false,
      resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_SECONDS,
      // Without this, better-auth's /forget-password answers 400 and every
      // account whose password is forgotten is unrecoverable — there is no
      // other credential path and no admin UI to fix it by hand.
      sendResetPassword: async ({ user, url }) => {
        await sendMail(
          resetPasswordMail(user.email, resetLinkFor(url), RESET_TOKEN_TTL_SECONDS / 60),
        );
      },
    },
    socialProviders: socialProviders(),
    account: {
      accountLinking: {
        // Link a social sign-in to the EXISTING account with the same email
        // instead of creating a second one. This is not cosmetic here: the
        // identity contract ties teams.owner_sub, memberships.user_sub,
        // agent_tokens.user_sub and author_sub to user.id, so a duplicate
        // account splits ownership of synced data — half the history under one
        // id, half under another, with no UI to merge them.
        enabled: true,
        // Both providers return a PRIMARY VERIFIED address (better-auth's
        // github provider reads the verified list rather than the profile
        // field), so matching on email is safe. Adding a provider that returns
        // an unverified email to this list would let someone claim an account
        // by setting that address at the IdP.
        trustedProviders: ['google', 'github'],
        // Left at the default (false) deliberately, and stated because the
        // default is the security-relevant choice: true would link accounts
        // whose emails do NOT match, which is account takeover by design.
        allowDifferentEmails: false,
      },
    },
    session: {
      // 7 days, rolling. Was a flat 30 days "matching the ct_ token culture",
      // but a ct_ device token and a browser session are not the same risk: the
      // device token lives in a 600 file on a developer's own machine, the
      // browser session rides in a cookie on whatever laptop was last used.
      //
      // Rolling, so this is not a usability tax: updateAge refreshes the session
      // on any request older than a day, meaning anyone who uses the product in
      // a given week is never logged out, while an abandoned session dies in
      // seven days instead of a month.
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      // Explicit rather than inherited. better-auth already defaults these to
      // safe values, but the whole point of the change that introduced this
      // block is that the session stops being readable by JavaScript, and a
      // security property that matters should be stated where it is read, not
      // inferred from a library's defaults across an upgrade.
      //
      // Secure is conditional on the deployment actually being https: pinning it
      // true unconditionally means the cookie is silently never set over plain
      // http, which is exactly how local development breaks with no error.
      useSecureCookies: baseURL().startsWith('https://'),
      defaultCookieAttributes: {
        httpOnly: true,
        // Lax, not Strict: the CLI device flow sends the browser to /device from
        // a terminal-opened tab, and Strict withholds the cookie on that
        // top-level cross-site navigation, so the approve page would render
        // logged out. Lax still blocks the cross-site POSTs that CSRF needs.
        sameSite: 'lax',
        path: '/',
      },
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
      // OAuth 2.1 authorization server for the REMOTE MCP endpoint (/mcp).
      //
      // This is what lets a client that cannot run our CLI — claude.ai, ChatGPT,
      // a browser IDE — connect with one click instead of a device code. It
      // brings dynamic client registration (RFC 7591), authorization_code with
      // PKCE S256, refresh tokens, and the two discovery documents the spec
      // requires. Every one of those is a thing we would otherwise write and
      // then own; better-auth already carries them, keyed on the same user rows
      // the dashboard and the CLI device flow use, so an MCP identity IS the
      // account identity and no third credential store appears.
      //
      // `loginPage` is where an unauthenticated authorize request is sent. It
      // must be a page that can also SIGN SOMEONE UP: the whole point of the
      // connector is a user who arrives from claude.ai having never seen the
      // dashboard, and a login-only page dead-ends them. /app renders sign-in
      // and sign-up together, with Google and GitHub, and a social sign-in marks
      // the address verified — which is what lets ensureTrial grant the trial on
      // the spot rather than waiting for an inbox.
      //
      // `resource` is the canonical identifier of the protected resource; it is
      // what the protected-resource metadata advertises and what a client audits
      // its token against, so it must equal the real /mcp URL.
      mcp({
        loginPage: '/app?view=signin',
        resource: `${baseURL()}/mcp`,
      }),
    ],
  });
}

let _auth: ReturnType<typeof createAuth> | null = null;

/**
 * The auth instance. NOT exported, and that is load-bearing.
 *
 * Its inferred type names better-auth's internal `MCPOptions`, which the package
 * does not export. Exporting anything typed by it makes this package's
 * declaration emit fail with TS4058 ("has or is using name 'MCPOptions' from
 * external module"), and the whole server stops building.
 *
 * Casting the plugin to `BetterAuthPlugin` "fixes" that by erasing the MCP
 * endpoints from the instance — which then breaks oAuthDiscoveryMetadata and
 * oAuthProtectedResourceMetadata, both of which require them. So the instance
 * stays fully typed and stays internal, and this module exports READY-MADE
 * HANDLERS instead, whose signatures name only Node's own types.
 */
function getAuth(): ReturnType<typeof createAuth> {
  if (!_auth) _auth = createAuth();
  return _auth;
}

/** A Node request handler, in the shape Express accepts at `app.all`/`app.get`.
 *  Named here so no exported signature below has to name a better-auth type. */
type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

/** Everything under `/api/auth/*` — sign-in/up/out, get-session, the RFC 8628
 *  device flow, and the OAuth authorize/token/register endpoints the MCP
 *  plugin adds. */
export function authHandler(): NodeHandler {
  return toNodeHandler(getAuth()) as NodeHandler;
}

/**
 * The two OAuth discovery documents, for mounting at the ORIGIN ROOT.
 *
 * An MCP client is given one URL (`https://<host>/mcp`) and finds everything
 * else at spec-fixed well-known paths on that origin. It never guesses that our
 * authorization server lives under `/api/auth`, so these must not be served only
 * there — see the mounts in server.ts.
 */
export function oauthAuthorizationServerHandler(): NodeHandler {
  return toNodeHandler(oAuthDiscoveryMetadata(getAuth())) as NodeHandler;
}

export function oauthProtectedResourceHandler(): NodeHandler {
  return toNodeHandler(oAuthProtectedResourceMetadata(getAuth())) as NodeHandler;
}

/**
 * Resolve an OAuth ACCESS TOKEN (the credential an MCP client holds) to its
 * grant, or null.
 *
 * Distinct from getSessionUser below, which resolves a SESSION token — the thing
 * the dashboard and the CLI device flow carry. They are different credentials
 * with different lifetimes, and the /mcp endpoint only ever sees the first kind.
 *
 * Returns the raw grant rather than a user shape because the caller needs the
 * token string back: the tool surface presents it again on its own loopback
 * calls, so the request arrives at tenantAuth as the same identity.
 */
export async function mcpSessionFor(
  reqHeaders: Record<string, string | string[] | undefined>,
): Promise<{ userId: string; accessToken: string } | null> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const grant = await getAuth().api.getMcpSession({ headers });
  if (!grant?.userId) return null;
  return { userId: grant.userId, accessToken: grant.accessToken };
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
