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
// Surface RAISE NOTICE. A repair written as a DO block reports no rowCount, so
// the "N row(s) affected" line below prints 0 however much it changed — and this
// runner's whole warning is that a silent no-op is indistinguishable from
// success. node-postgres drops notices unless something listens.
c.on('notice', (n) => { if (n?.message) console.log(`  notice: ${n.message}`); });
await c.connect();

await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);

// EMPTY on purpose — see migrations/README.md. The bootstrap owns the schema, and
// the one-off repairs that used to live here have all been applied and removed.
// Add a file here only for something the bootstrap cannot express, and delete it
// again once it has run everywhere.
const FILES = [
  // One-off repair. DELETE THIS FILE AND THIS ENTRY once it has run everywhere —
  // see migrations/README.md. It removes auto-filed cards that closed themselves
  // because a finding's id shifted, not because anything was fixed.
  // The './migrations/' prefix is REQUIRED. Entries resolve against
  // import.meta.url, which is this file — not the migrations directory — so a
  // bare filename resolves to /app/0009_….sql and the initContainer dies with
  // ENOENT. It did: the rollout sat in Init:CrashLoopBackOff (no outage, because
  // Kubernetes kept the previous pods serving) until this prefix was restored.
  './migrations/0009_drop_phantom_autoclosed_tasks.sql',
  // One-off repair. DELETE THIS FILE AND THIS ENTRY once it has run everywhere.
  // Moves cards the machine closed out of 'done', which they were never entitled
  // to: 'done' requires the session that did the work, and these had none.
  './migrations/0010_machine_closures_are_not_done.sql',
  // One-off repair. DELETE THIS FILE AND THIS ENTRY once it has run everywhere.
  // Stamps an owner on rows written before attribution existed. A NULL author is
  // read as "legacy, visible to the whole tenant", which is the one thing a new
  // member can see on the day they join.
  './migrations/0011_backfill_author_sub.sql',
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
