// Rehearsal scaffolding (test-only): apply the LEGACY migrations the way the
// live DB got them (pre-ledger), then seed legacy-shaped rows.
import pg from 'pg';
import { readFileSync } from 'fs';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
for (const f of ['./migrations/0001_init.sql','./migrations/0002_messages.sql','./migrations/0003_teams.sql']) {
  await c.query(readFileSync(new URL(f, import.meta.url), 'utf8'));
  console.log('legacy applied', f);
}
await c.query("INSERT INTO tenants(slug, display_name) VALUES ('hotmun','Hotmun')");
await c.query("INSERT INTO agent_tokens(tenant_slug, device_id, token_hash) VALUES ('hotmun','laptop','abc123')");
await c.query("INSERT INTO teams(slug,name,owner_sub) VALUES ('hotmun','Hotmun','sub-1')");
await c.query("INSERT INTO memberships(user_sub,team_slug,role,email) VALUES ('sub-1','hotmun','owner','a@b.c')");
await c.end();
console.log('seeded');
