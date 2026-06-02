import pg from 'pg';
import { readFileSync } from 'fs';

const SUPER = { host: 'localhost', port: 5456, user: 'postgres', password: 'dev', database: 'chat-recall' };
const APP   = { host: 'localhost', port: 5456, user: 'app_user', password: 'app', database: 'chat-recall' };

const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); process.exitCode = 1; };

// Run a query inside a tx scoped to a tenant (set_config local=true).
async function asTenant(client, slug, fn) {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.tenant_slug', $1, true)", [slug]);
  try { return await fn(); } finally { await client.query('COMMIT'); }
}

const sup = new pg.Client(SUPER); await sup.connect();
await sup.query(readFileSync(new URL('./migrations/0001_init.sql', import.meta.url), 'utf8'));
await sup.query("INSERT INTO tenants(slug,display_name) VALUES ('acme','Acme'),('globex','Globex') ON CONFLICT DO NOTHING");
ok('migration applied + 2 tenants seeded');

const app = new pg.Client(APP); await app.connect();

// acme inserts its data
await asTenant(app, 'acme', async () => {
  await app.query("INSERT INTO conversations(tenant_slug,session_id,redacted_text) VALUES ('acme','s1','deploy k8s, key=*****QVGY') ON CONFLICT DO NOTHING");
  await app.query("INSERT INTO secret_findings(tenant_slug,session_id,detector,rule,line,preview) VALUES ('acme','s1','trufflehog','AWS',3,'*****QVGY') ON CONFLICT DO NOTHING");
});
// globex inserts its data
await asTenant(app, 'globex', async () => {
  await app.query("INSERT INTO conversations(tenant_slug,session_id,redacted_text) VALUES ('globex','s9','refactor billing') ON CONFLICT DO NOTHING");
});
ok('both tenants inserted via app_user (RLS WITH CHECK allowed own rows)');

// acme sees only acme
await asTenant(app, 'acme', async () => {
  const r = await app.query('SELECT tenant_slug FROM conversations');
  const slugs = [...new Set(r.rows.map(x => x.tenant_slug))];
  if (r.rows.length === 1 && slugs[0] === 'acme') ok(`acme sees only its own rows (${r.rows.length})`);
  else bad(`acme saw cross-tenant rows: ${JSON.stringify(slugs)}`);
});
// globex sees only globex
await asTenant(app, 'globex', async () => {
  const r = await app.query('SELECT tenant_slug FROM conversations');
  if (r.rows.length === 1 && r.rows[0].tenant_slug === 'globex') ok('globex sees only its own row');
  else bad(`globex isolation broken: ${JSON.stringify(r.rows)}`);
});

// acme CANNOT write a row stamped for globex (WITH CHECK blocks it)
await asTenant(app, 'acme', async () => {
  try {
    await app.query("INSERT INTO conversations(tenant_slug,session_id,redacted_text) VALUES ('globex','evil','steal')");
    bad('acme was able to insert a globex-stamped row (WITH CHECK FAILED)');
  } catch (e) { ok('acme blocked from inserting globex-stamped row (WITH CHECK)'); }
});

// No tenant context set -> zero rows (fail closed)
{
  const r = await app.query('SELECT count(*)::int n FROM conversations');
  if (r.rows[0].n === 0) ok('no app.tenant_slug set -> 0 rows (fail closed)');
  else bad(`fail-open: saw ${r.rows[0].n} rows with no tenant context`);
}

await app.end(); await sup.end();
console.log(process.exitCode ? '\nFAILED' : '\nISOLATION VERIFIED');
