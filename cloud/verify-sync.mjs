// End-to-end: create 2 tenants, push redacted data with each token, prove each
// token only reads its own data through the live API. Server must be running.
const API = 'http://localhost:8080';
const ADMIN = { 'x-admin-key': 'dev-admin', 'content-type': 'application/json' };
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); process.exitCode = 1; };

const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

async function mkTenant(slug) {
  await fetch(`${API}/api/tenants`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ slug, display_name: slug }) });
  const { body } = await j(await fetch(`${API}/api/tenants/${slug}/tokens`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ device_id: 'laptop-1' }) }));
  return body.token;
}

const tokA = await mkTenant('dogfood');
const tokB = await mkTenant('rival');
ok('two tenants created + tokens issued');

const bearer = (t) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

// dogfood pushes a redacted conversation + a masked finding
const push = await j(await fetch(`${API}/api/sync`, { method: 'POST', headers: bearer(tokA), body: JSON.stringify({
  conversations: [{ session_id: 's1', tool: 'claude', project_path: '/home/user/code/personal/chat-recall', redacted_text: 'deploy k8s; aws key=*****QVGY', mtime: Date.now() }],
  findings: [{ session_id: 's1', detector: 'trufflehog', rule: 'AWS', line: 3, preview: '*****QVGY', project_path: '/home/user/code/personal/chat-recall', verified_at: new Date().toISOString() }],
}) }));
if (push.body.ok && push.body.conv === 1 && push.body.find === 1) ok('dogfood pushed 1 conversation + 1 finding'); else bad('push failed: ' + JSON.stringify(push.body));

// rival pushes its own
await fetch(`${API}/api/sync`, { method: 'POST', headers: bearer(tokB), body: JSON.stringify({
  conversations: [{ session_id: 'r1', tool: 'gemini', project_path: '/rival/secret-project', redacted_text: 'rival stuff', mtime: Date.now() }],
}) });
ok('rival pushed its own conversation');

// dogfood reads back — sees only its own
const a = await j(await fetch(`${API}/api/conversations`, { headers: bearer(tokA) }));
const aSlugs = a.body.conversations.map(c => c.session_id);
if (aSlugs.length === 1 && aSlugs[0] === 's1') ok('dogfood reads only its own conversation (s1)'); else bad('dogfood leak: ' + JSON.stringify(aSlugs));

// rival reads back — sees only its own, NOT dogfood's s1
const b = await j(await fetch(`${API}/api/conversations`, { headers: bearer(tokB) }));
const bSlugs = b.body.conversations.map(c => c.session_id);
if (bSlugs.length === 1 && bSlugs[0] === 'r1') ok('rival reads only its own (r1) — cannot see dogfood s1'); else bad('cross-tenant leak: ' + JSON.stringify(bSlugs));

// the security dashboard rollup, tenant-scoped
const roll = await j(await fetch(`${API}/api/findings/by-project`, { headers: bearer(tokA) }));
const p = roll.body.projects?.[0];
if (p && Number(p.live) === 1) ok(`dogfood by-project rollup: ${p.project_path.split('/').pop()} → ${p.distinct_secrets} secret, ${p.live} live`); else bad('rollup wrong: ' + JSON.stringify(roll.body));

// bad token rejected
const noauth = await fetch(`${API}/api/sync`, { method: 'POST', headers: bearer('ct_bogus'), body: '{}' });
if (noauth.status === 401) ok('invalid token rejected (401)'); else bad('auth bypass: ' + noauth.status);

console.log(process.exitCode ? '\nFAILED' : '\nSYNC API VERIFIED (auth + tenant isolation + ingest + rollup)');
