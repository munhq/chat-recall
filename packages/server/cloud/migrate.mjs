// Migration runner — applied by the k8s migrate initContainer (and locally).
// Connects as a role with createrole (the CNPG `chat_recall` owner in the
// cluster, or a superuser locally).
//
// Run-once semantics via a `schema_migrations` ledger: 0001–0003 are written
// against the LEGACY column shapes (tenant_slug, timestamptz) and would fail
// if re-applied after 0004 renames those columns — so each file applies
// exactly once. The engine's own bootstrap (pg-schema.ts, run by the server
// on boot) stays idempotent and handles everything additive.
import pg from 'pg';
import { readFileSync } from 'fs';

const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('MIGRATE_DATABASE_URL required'); process.exit(1); }
const c = new pg.Client({ connectionString: url });
await c.connect();

await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);

const FILES = [
  './migrations/0001_init.sql',
  './migrations/0002_messages.sql',
  './migrations/0003_teams.sql',
  './migrations/0004_unified_server.sql',
  './migrations/0005_kg_junk_cleanup.sql',
  './migrations/0006_orphan_session_metadata.sql',
];

for (const f of FILES) {
  const done = await c.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
  if (done.rowCount > 0) { console.log(`skipped ${f} (already applied)`); continue; }
  await c.query(readFileSync(new URL(f, import.meta.url), 'utf8'));
  await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
  console.log(`applied ${f}`);
}

// NOTE: the server connects as the table-owning role (chat_recall in the
// cluster), which is NOBYPASSRLS and subject to FORCE RLS — so RLS is enforced
// without a separate app_user. We deliberately do NOT ALTER app_user's password
// here: in PG16 that needs ADMIN OPTION on the role, which a CREATEROLE migrator
// doesn't reliably hold, and it's unnecessary.
await c.end();
console.log('migration complete');
