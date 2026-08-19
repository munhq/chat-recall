// Migration runner — applied by the k8s migrate initContainer (and locally).
// Connects as a role with createrole (the CNPG `chat_recall` owner in the
// cluster, or a superuser locally).
//
// THE SCHEMA IS NOT OWNED HERE. engine/src/core/store/pg-schema.ts creates every
// table, enables and FORCEs RLS, and installs every policy — idempotently, on
// every server boot. A fresh database gets its whole structure from there, which
// is why this directory needs only two files: a legacy-v1 upgrade and the one-off
// data repairs.
//
// Both are IDEMPOTENT, so the `schema_migrations` ledger is a courtesy (it skips
// work already done) rather than a correctness requirement. That matters: the
// ledger being the only guard is precisely what made two earlier no-op
// migrations permanent — see 0002's header.
//
// Databases migrated before the consolidation carry the old 0001–0008 filenames
// in the ledger. Those rows are left alone: the new files are idempotent, so
// re-running them there is a no-op, and rewriting history to match a renamed file
// would be worse than a stale row.
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
  './migrations/0001_legacy_v1_upgrade.sql',
  './migrations/0002_data_repairs.sql',
];

// REPORT ROWS AFFECTED. A data migration against a tenant-scoped table is
// silently a NO-OP unless it handles RLS: `tenant_isolation` compares tenant to
// current_setting('app.tenant', true), a migration sets no tenant context, and
// `tenant = NULL` is NULL — so every row fails the check, zero rows match, and
// nothing errors. 0006 and 0007 were both lost this way and marked applied,
// which the ledger then makes permanent. Printing the counts is what turns that
// from invisible into obvious in the initContainer log. See 0008's header.
for (const f of FILES) {
  const done = await c.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
  if (done.rowCount > 0) { console.log(`skipped ${f} (already applied)`); continue; }
  const res = await c.query(readFileSync(new URL(f, import.meta.url), 'utf8'));
  // A multi-statement query returns one Result per statement.
  const results = Array.isArray(res) ? res : [res];
  const touched = results.reduce((n, r) => n + (r?.rowCount ?? 0), 0);
  const changed = results
    .filter((r) => r?.rowCount)
    .map((r) => `${r.command ?? '?'} ${r.rowCount}`)
    .join(', ');
  await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
  console.log(`applied ${f} — ${touched} row(s) affected${changed ? ` [${changed}]` : ''}`);
}

// NOTE: the server connects as the table-owning role (chat_recall in the
// cluster), which is NOBYPASSRLS and subject to FORCE RLS — so RLS is enforced
// without a separate app_user. We deliberately do NOT ALTER app_user's password
// here: in PG16 that needs ADMIN OPTION on the role, which a CREATEROLE migrator
// doesn't reliably hold, and it's unnecessary.
await c.end();
console.log('migration complete');
