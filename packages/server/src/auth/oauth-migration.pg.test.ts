/**
 * The move of the MCP grants from better-auth 1.6 to 1.7, against Postgres.
 *
 * 1.6 kept clients in `oauthApplication` and plain tokens in `oauthAccessToken`;
 * 1.7 keeps clients in `oauthClient`, hashed refresh tokens in
 * `oauthRefreshToken`, and has its own, different `oauthAccessToken`. On
 * 2026-10-29 production held 61 clients and 23 live refresh tokens. A connector
 * that registered under 1.6 must refresh under 1.7 without connecting again,
 * so the last test sends a 1.6 refresh token to the 1.7 token endpoint and
 * checks the access token it gets back.
 *
 * Each run uses a schema of its own, so it never touches another test's tables.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { pgAdminUrl, pgTestUrl } from '@chat-recall/engine/test-support/pg-urls.js';
import { __setAuthKits } from '../util/auth-kit.js';
import {
  __auth, __resetAuth, copy16Grants, mcpResourceUrl, runAuthMigrations, setAside16Tables, storedHash, verifyMcpBearer,
} from './better-auth.js';

const url = pgTestUrl();
const BASE = 'https://chatrecall.example';
const CLIENT = 'dcr-client-from-1-6';
const USER = 'user-1';
const LIVE = 'live-refresh-token-of-1-6';
const EXPIRED = 'expired-refresh-token-of-1-6';
const DAY = 86_400_000;

const schema = `auth_mig_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
let admin: pg.Pool;
let pool: pg.Pool;
const saved = { url: process.env.DATABASE_URL, secret: process.env.BETTER_AUTH_SECRET, base: process.env.BETTER_AUTH_URL };

function inSchema(u: string): string {
  const x = new URL(u);
  x.searchParams.set('options', `-c search_path=${schema}`);
  return x.toString();
}

/** The 1.6 tables, with the columns production has. */
async function create16(): Promise<void> {
  await pool.query(`
    CREATE TABLE "oauthApplication" (id text PRIMARY KEY, name text, icon text, metadata text, "clientId" text UNIQUE,
      "clientSecret" text, "redirectUrls" text, type text, disabled boolean, "userId" text,
      "createdAt" timestamptz, "updatedAt" timestamptz);
    CREATE TABLE "oauthAccessToken" (id text PRIMARY KEY, "accessToken" text, "refreshToken" text,
      "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "clientId" text, "userId" text,
      scopes text, "createdAt" timestamptz, "updatedAt" timestamptz);
    CREATE TABLE "oauthConsent" (id text PRIMARY KEY, "clientId" text, "userId" text, scopes text,
      "createdAt" timestamptz, "updatedAt" timestamptz, "consentGiven" boolean);
  `);
  await pool.query(
    `INSERT INTO "oauthApplication" (id, name, "clientId", "clientSecret", "redirectUrls", type, disabled, "userId", "createdAt", "updatedAt")
     VALUES ('app-1', 'Claude', $1, '', 'https://claude.ai/api/mcp/auth_callback', 'public', false, NULL, now(), now())`,
    [CLIENT],
  );
  const now = Date.now();
  await pool.query(
    `INSERT INTO "oauthAccessToken" (id, "accessToken", "refreshToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "clientId", "userId", scopes, "createdAt", "updatedAt")
     VALUES ('t1', 'opaque-1', $1, $3, $4, $5, $6, 'openid profile email offline_access', now(), now()),
            ('t2', 'opaque-2', $2, $3, $7, $5, $6, 'openid offline_access', now(), now())`,
    [LIVE, EXPIRED, new Date(now - DAY), new Date(now + 30 * DAY), CLIENT, USER, new Date(now - DAY)],
  );
}

describe.skipIf(!url)('the 1.6 MCP grants move to the 1.7 tables', () => {
  beforeAll(async () => {
    // The test role may not create a schema; the admin creates it and hands it over.
    admin = new pg.Pool({ connectionString: pgAdminUrl() ?? url, max: 1 });
    const role = decodeURIComponent(new URL(url!).username);
    await admin.query(`CREATE SCHEMA ${schema} AUTHORIZATION "${role}"`);
    process.env.DATABASE_URL = inSchema(url!);
    process.env.BETTER_AUTH_SECRET = 'oauth-migration-test-secret-0123456789abcdef';
    process.env.BETTER_AUTH_URL = BASE;
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    // The self-host build: no kits. The settings are the server's own.
    __setAuthKits(null, null);
    await __resetAuth();
    await create16();
  });

  afterAll(async () => {
    await __resetAuth();
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
    for (const [k, v] of [['DATABASE_URL', saved.url], ['BETTER_AUTH_SECRET', saved.secret], ['BETTER_AUTH_URL', saved.base]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test('the 1.6 tables that share a name with 1.7 tables are set aside, once', async () => {
    expect(await setAside16Tables(pool)).toBe(true);
    const names = (await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1", [schema],
    )).rows.map((r) => r.table_name);
    expect(names).toEqual(['oauthAccessToken_v16', 'oauthApplication', 'oauthConsent_v16']);
    expect(await setAside16Tables(pool)).toBe(false);
  });

  test('the migrator creates the 1.7 tables, and the client and the live refresh token are copied once', async () => {
    const { getMigrations } = await import('better-auth/db/migration');
    const { runMigrations } = await getMigrations(__auth().options);
    await runMigrations();
    await pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, 'Ada', 'ada@example.com', true, now(), now())`,
      [USER],
    );

    expect(await copy16Grants(pool, mcpResourceUrl())).toEqual({ clients: 1, refreshTokens: 1 });
    const client = (await pool.query('SELECT "clientId", "clientSecret", "redirectUris", "tokenEndpointAuthMethod" FROM "oauthClient"')).rows;
    expect(client).toHaveLength(1);
    expect(client[0].clientId).toBe(CLIENT);
    expect(client[0].clientSecret).toBeNull();
    expect(client[0].tokenEndpointAuthMethod).toBe('none');
    // 1.7 issues a token for a resource only to a client linked to it.
    const links = (await pool.query('SELECT "clientId", "resourceId" FROM "oauthClientResource"')).rows;
    expect(links).toEqual([{ clientId: CLIENT, resourceId: mcpResourceUrl() }]);
    const tokens = (await pool.query('SELECT token, "userId", "clientId" FROM "oauthRefreshToken"')).rows;
    expect(tokens).toEqual([{ token: storedHash(LIVE), userId: USER, clientId: CLIENT }]);
    // The expired token is not copied, and nothing is stored in plain text.
    expect(JSON.stringify(tokens)).not.toContain(LIVE);

    expect(await copy16Grants(pool, mcpResourceUrl())).toEqual({ clients: 0, refreshTokens: 0 });
  });

  test('registration refuses a callback outside the MCP clients and loopback, and stores nothing', async () => {
    const register = (redirectUri: string) => __auth().handler(new Request(`${BASE}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'probe', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], response_types: ['code'],
      }),
    }));
    const count = async () => Number((await pool.query('SELECT count(*) FROM "oauthClient"')).rows[0].count);
    const before = await count();
    const refused = await register('https://attacker-alpha.example.com/cb');
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    expect(await count()).toBe(before);
    expect((await register('https://claude.ai/api/mcp/auth_callback')).status).toBe(201);
  });

  test('authorize refuses a stored client with a callback outside the list', async () => {
    await pool.query(
      `INSERT INTO "oauthClient" (id, "clientId", disabled, "createdAt", "updatedAt", name,
          "redirectUris", "tokenEndpointAuthMethod", "grantTypes", "responseTypes", "requirePKCE", scopes)
       VALUES ('rogue-1', 'rogue-client', false, now(), now(), 'Rogue', $1, 'none', $2, $3, true, $4)`,
      [
        JSON.stringify(['https://attacker-alpha.example.com/cb']), JSON.stringify(['authorization_code']),
        JSON.stringify(['code']), JSON.stringify(['openid']),
      ],
    );
    const q = new URLSearchParams({
      response_type: 'code', client_id: 'rogue-client', redirect_uri: 'https://attacker-alpha.example.com/cb',
      scope: 'openid', state: 's', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
    });
    const res = await __auth().handler(new Request(`${BASE}/api/auth/oauth2/authorize?${q}`, { redirect: 'manual' }));
    expect(res.status).toBe(400);
    expect(res.headers.get('location') ?? '').not.toContain('attacker-alpha.example.com');
  });

  test('a 1.6 refresh token gets a 1.7 access token, which verifies as the user', async () => {
    const res = await __auth().handler(new Request(`${BASE}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      // No `resource`: a 1.6 connector never sent one. The audience comes from the resources stored on the token.
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: LIVE, client_id: CLIENT }).toString(),
    }));
    const body = await res.json() as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.access_token?.split('.')).toHaveLength(3);
    expect(body.refresh_token).toBeTruthy();
    const grant = await verifyMcpBearer({ authorization: `Bearer ${body.access_token}` });
    expect(grant?.userId).toBe(USER);
    expect(grant?.scopes).toContain('offline_access');
    // Another bearer is not an MCP access token.
    expect(await verifyMcpBearer({ authorization: 'Bearer not-a-jwt' })).toBeNull();
  });

  test('a second boot finds nothing to move', async () => {
    expect(await runAuthMigrations()).toEqual({ clients: 0, refreshTokens: 0 });
  });
});
