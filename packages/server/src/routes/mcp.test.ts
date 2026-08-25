/**
 * The remote MCP endpoint's contract.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * The endpoint shipped with a hole that every manual check passed: it resolved
 * the caller's OAuth token correctly, then handed that token to the tools as
 * their loopback credential, where `resolve()` in middleware/auth.ts rejected it
 * — an OAuth access token is not a session token, and better-auth's core session
 * path never looks in `oauthAccessToken`. So the handshake worked and every tool
 * call answered 401 'login required'.
 *
 * It passed 401-without-a-token, 403-on-a-bad-origin, 405-on-GET and dynamic
 * client registration, because `initialize` and `tools/list` touch no API at
 * all. Two independent reviews had to find it by reading the code.
 *
 * The lesson these tests encode: on this endpoint, AUTHENTICATION SUCCEEDING
 * PROVES NOTHING. What matters is whether an authenticated call reaches the API,
 * and whether the credential it carries is one the API accepts.
 *
 * ── What is covered here, and what is not ─────────────────────────────────
 *
 * These are unit tests over the route's own decisions — the ones that need no
 * database: the origin guard, the 401 envelope and its discovery header, method
 * handling, and the Accept split that keeps the docs page reachable. The auth
 * resolution itself is mocked, because a real OAuth grant needs Postgres.
 *
 * The full chain — sign-up, dynamic client registration, PKCE authorize, code
 * exchange, tools/call reaching the API — is driven by scripts/oauth-e2e.mjs
 * against a booted server. That script is what actually proves the bug above is
 * fixed; this file is what stops the route's own decisions regressing quietly.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const authState = vi.hoisted(() => ({
  session: null as { userId: string; accessToken: string } | null,
}));

// The auth resolution needs Postgres; the route's decisions do not.
vi.mock('../auth/better-auth.js', () => ({
  mcpSessionFor: async () => authState.session,
}));

// The engine's tool surface spins up an MCP server; none of these tests get far
// enough to need one, and importing it for real would pull in the whole engine.
vi.mock('@chat-recall/engine/mcp/tools.js', () => ({
  createMcpServer: () => ({ connect: async () => {}, close: async () => {} }),
  setServerVersion: () => {},
  setMultiTenantMode: () => {},
  withCredentials: (_creds: unknown, fn: () => unknown) => fn(),
}));

const ORIGIN = 'https://chatrecall.dev';

async function app() {
  process.env.TRUSTED_ORIGINS = ORIGIN;
  process.env.BETTER_AUTH_URL = ORIGIN;
  const mcpRouter = (await import('./mcp.js')).default;
  const a = express();
  a.use('/mcp', express.json(), mcpRouter);
  // Stands in for express.static, so a fall-through is observable.
  a.use((_req, res) => res.status(200).type('html').send('<h1>docs</h1>'));
  return a;
}

const rpc = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

beforeEach(() => { authState.session = null; });

describe('POST /mcp — authentication', () => {
  test('no token → 401 carrying the discovery header', async () => {
    const res = await request(await app()).post('/mcp').send(rpc);
    expect(res.status).toBe(401);
    // RFC 9728 §5.1. Without this a client that gets a 401 has nowhere to go,
    // and the connector fails to connect with nothing to diagnose.
    expect(res.headers['www-authenticate'])
      .toContain('resource_metadata="https://chatrecall.dev/.well-known/oauth-protected-resource"');
    // A JSON-RPC error envelope, not an HTML error page — the client parses it.
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.error.code).toBe(-32001);
  });

  test('the 401 body never leaks why the token failed', async () => {
    const res = await request(await app()).post('/mcp').send(rpc);
    expect(JSON.stringify(res.body)).not.toMatch(/token|expired|revoked|database/i);
  });
});

describe('POST /mcp — the origin guard', () => {
  test('an unrecognised Origin is refused before auth is even attempted', async () => {
    // Set a valid session: proving the 403 wins shows the check runs first, and
    // that a browser cannot drive someone's tools from another page.
    authState.session = { userId: 'u1', accessToken: 'tok' };
    const res = await request(await app())
      .post('/mcp').set('origin', 'https://evil.example').send(rpc);
    expect(res.status).toBe(403);
  });

  test('a trusted Origin passes the guard and reaches auth', async () => {
    const res = await request(await app())
      .post('/mcp').set('origin', ORIGIN).send(rpc);
    expect(res.status).toBe(401);   // refused by auth, NOT by the origin check
  });

  test('a MISSING Origin is allowed — every real MCP client sends none', async () => {
    // The guard exists for browsers. Refusing a missing Origin would refuse
    // every non-browser client, i.e. all of them.
    const res = await request(await app()).post('/mcp').send(rpc);
    expect(res.status).not.toBe(403);
  });
});

describe('GET /mcp — the docs page must survive the endpoint', () => {
  test('a browser falls through to the documentation page', async () => {
    // README.md links https://chatrecall.dev/mcp/ and that README ships to npm.
    // Mounting this router above express.static turned a published URL into a
    // JSON-RPC 405.
    const res = await request(await app()).get('/mcp').set('accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('docs');
  });

  test('an MCP client asking for a stream gets 405 and is told to POST', async () => {
    const res = await request(await app()).get('/mcp').set('accept', 'text/event-stream');
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
    expect(res.body.error.message).toMatch(/POST/);
  });

  test('DELETE answers 405 rather than 404 — there is no session to end', async () => {
    // 404 reads as "no endpoint here" and sends a working client away.
    const res = await request(await app()).delete('/mcp');
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });
});
