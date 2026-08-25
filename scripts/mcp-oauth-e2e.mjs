/**
 * Drive the WHOLE connector flow against a running server, the way claude.ai
 * does: sign a user up, register a client dynamically, authorize with PKCE,
 * exchange the code, then call tools with the resulting access token.
 *
 * WHY THIS IS A SCRIPT AND NOT A UNIT TEST. It needs a booted server with a real
 * Postgres, because an OAuth grant is rows in `oauthApplication` and
 * `oauthAccessToken`. routes/mcp.test.ts covers the route's own decisions, which
 * need neither.
 *
 * WHY IT EXISTS AT ALL. The endpoint shipped with a hole every manual check
 * passed: it resolved the caller's token, then handed that token to the tools as
 * their loopback credential, where middleware/auth.ts rejected it — an OAuth
 * access token is not a session token. The handshake worked; every tool call
 * answered 401. 401-without-a-token, 403-on-a-bad-origin, 405-on-GET and dynamic
 * client registration ALL passed throughout, because `initialize` and
 * `tools/list` touch no API.
 *
 * So step 6 is the point of the whole file: call a tool that actually reaches
 * /api and check the answer is not an auth failure. Everything before it is
 * setup.
 *
 *   BASE=http://127.0.0.1:5233 node scripts/mcp-oauth-e2e.mjs
 *
 * Run it against a throwaway server. It creates a user and an OAuth client.
 */
import { createHash, randomBytes } from 'node:crypto';

const B = process.env.BASE || 'http://127.0.0.1:5233';
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ok = (label, cond, extra = '') =>
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);

const email = `probe-${Date.now()}@example.test`;
const password = 'probe-password-0123456789';

// 1. Sign up. The bearer plugin returns the session token in a header.
const su = await fetch(`${B}/api/auth/sign-up/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: B },
  body: JSON.stringify({ email, password, name: 'Probe User' }),
});
const sessionToken = su.headers.get('set-auth-token');
ok('sign-up', su.ok && !!sessionToken, `http ${su.status}`);
if (!sessionToken) { console.log(await su.text()); process.exit(1); }

// 2. Dynamic client registration — exactly what claude.ai does first.
const reg = await fetch(`${B}/api/auth/mcp/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: B },
  body: JSON.stringify({
    client_name: 'e2e-probe',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }),
});
const client = await reg.json();
ok('dynamic client registration', reg.status === 201 && !!client.client_id, client.client_id);

// 3. Authorize with PKCE, carrying the session so no login page is needed.
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const authUrl = `${B}/api/auth/mcp/authorize?` + new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  response_type: 'code',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  scope: 'openid profile email offline_access',
});
const az = await fetch(authUrl, {
  redirect: 'manual',
  headers: { authorization: `Bearer ${sessionToken}`, origin: B },
});
const loc = az.headers.get('location') || '';
let code = null;
try { code = new URL(loc).searchParams.get('code'); } catch { /* not a URL */ }
ok('authorize returns a code', !!code, `http ${az.status} → ${loc.slice(0, 80)}`);
if (!code) process.exit(1);

// 4. Exchange the code. Public client, so PKCE is the proof.
const tk = await fetch(`${B}/api/auth/mcp/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: B },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    client_id: client.client_id,
    code_verifier: verifier,
  }),
});
const tok = await tk.json();
ok('token exchange', tk.ok && !!tok.access_token, `http ${tk.status}`);
if (!tok.access_token) { console.log(JSON.stringify(tok).slice(0, 300)); process.exit(1); }

// 5. Call /mcp with the access token.
const rpc = async (method, params) => {
  const r = await fetch(`${B}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tok.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await r.text();
  const line = text.split('\n').find((l) => l.startsWith('data: ')) ?? text;
  try { return { status: r.status, body: JSON.parse(line.replace(/^data: /, '')) }; }
  catch { return { status: r.status, body: text.slice(0, 300) }; }
};

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' },
});
ok('initialize (authenticated)', init.status === 200, JSON.stringify(init.body?.result?.serverInfo ?? init.body).slice(0, 90));

const list = await rpc('tools/list', {});
const tools = list.body?.result?.tools ?? [];
ok('tools/list', tools.length > 0, `${tools.length} tools`);
ok('local-only tools are NOT listed',
  !tools.some((t) => t.name === 'recall_index' || t.name === 'recall_code_index'));

// 6. THE test. recall_status hits /api/status over loopback with the OAuth
//    token — the exact call that answered 401 'login required' before the fix.
const status = await rpc('tools/call', { name: 'recall_status', arguments: {} });
const allText = (r) => (r.body?.result?.content ?? []).map((c) => c.text ?? '').join('\n') || JSON.stringify(r.body);
const text = allText(status);
const authFailed = /login required|HTTP 401|not logged in/i.test(text);
ok('AUTHENTICATED TOOL CALL reaches the API', status.status === 200 && !authFailed,
  text.replace(/\s+/g, ' ').slice(0, 150));

// 7. A local-only tool called BY NAME must be refused, not executed.
const idx = await rpc('tools/call', { name: 'recall_index', arguments: {} });
const idxText = allText(idx);
ok('recall_index refused by name (not executed)', /runs on YOUR machine/i.test(idxText),
  idxText.replace(/\s+/g, ' ').slice(0, 90));
