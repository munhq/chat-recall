// Idempotent migration runner — applied by the k8s migrate initContainer (and
// locally). Connects as a role with createrole (the CNPG `chat_recall` owner in
// the cluster, or a superuser locally) since it creates the `app_user` login
// role + RLS policies. The server then connects as `app_user` (NOBYPASSRLS) so
// RLS is enforced.
import pg from 'pg';
import { readFileSync } from 'fs';

const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('MIGRATE_DATABASE_URL required'); process.exit(1); }
const c = new pg.Client({ connectionString: url });
await c.connect();
for (const f of ['./migrations/0001_init.sql', './migrations/0002_messages.sql', './migrations/0003_teams.sql']) {
  await c.query(readFileSync(new URL(f, import.meta.url), 'utf8'));
  console.log(`applied ${f}`);
}
// NOTE: the server connects as the table-owning role (chat_recall in the
// cluster), which is NOBYPASSRLS and subject to FORCE RLS — so RLS is enforced
// without a separate app_user. We deliberately do NOT ALTER app_user's password
// here: in PG16 that needs ADMIN OPTION on the role, which a CREATEROLE migrator
// doesn't reliably hold, and it's unnecessary.
await c.end();
console.log('migration complete');
