// Idempotent migration runner — applied by the k8s migrate Job (and locally).
// Connects as the superuser (MIGRATE_DATABASE_URL) since it creates roles + RLS.
import pg from 'pg';
import { readFileSync } from 'fs';

const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('MIGRATE_DATABASE_URL required'); process.exit(1); }
const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query(readFileSync(new URL('./migrations/0001_init.sql', import.meta.url), 'utf8'));
await c.end();
console.log('migration applied');
