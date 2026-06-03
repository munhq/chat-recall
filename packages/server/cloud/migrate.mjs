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
for (const f of ['./migrations/0001_init.sql', './migrations/0002_messages.sql']) {
  await c.query(readFileSync(new URL(f, import.meta.url), 'utf8'));
  console.log(`applied ${f}`);
}
// Optionally rotate the app_user password away from the migration default.
if (process.env.APP_DB_PASSWORD) {
  await c.query(`ALTER ROLE app_user PASSWORD '${process.env.APP_DB_PASSWORD.replace(/'/g, "''")}'`);
  console.log('app_user password set from APP_DB_PASSWORD');
}
await c.end();
console.log('migration complete');
