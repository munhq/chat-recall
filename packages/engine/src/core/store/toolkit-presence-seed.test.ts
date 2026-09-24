/**
 * The bootstrap seeds toolkit_presence ONCE, in the boot that creates it.
 *
 * Every existing toolkit row gets presence for the devices recorded on it, so a
 * device that has not sent an inventory yet keeps its items. A seed on every
 * boot would put back presence that a device has since removed, and the row
 * would never be deleted. Runs on its own scratch database, because the seed
 * happens only where the table does not exist yet.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

import { PG_SCHEMA } from './pg-schema.js';
import { applySchemaWithRetry } from './pg-pool.js';
import { pgAdminUrl, pgTestUrl } from '../../test-support/pg-urls.js';

const PG_URL = pgTestUrl();
const DB = `cr_seed_probe_${process.pid}`;
let admin: pg.Pool;
let scratch: pg.Pool;
let scratchUrl = '';

/** One server boot: the bootstrap schema, applied as the app role. The store
 *  applies it once per process, and a real boot is a new process. */
const boot = async () => {
  const app = new pg.Client({ connectionString: scratchUrl });
  await app.connect();
  try { await applySchemaWithRetry((sql) => app.query(sql), PG_SCHEMA); } finally { await app.end(); }
};
const presence = async () =>
  (await scratch.query(`SELECT source_type, id, device FROM toolkit_presence ORDER BY 1, 2, 3`)).rows;

beforeAll(async () => {
  if (!PG_URL) return;
  admin = new pg.Pool({ connectionString: pgAdminUrl(), max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  // Owned by the role the store connects as, which is the production shape.
  const owner = decodeURIComponent(new URL(PG_URL).username);
  await admin.query(`CREATE DATABASE ${DB} OWNER "${owner}"`);
  const u = new URL(pgAdminUrl()!); u.pathname = `/${DB}`;
  const adminScratch = new pg.Pool({ connectionString: u.toString(), max: 1 });
  await adminScratch.query(`CREATE EXTENSION IF NOT EXISTS vector`).catch(() => {});
  await adminScratch.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`).catch(() => {});
  await adminScratch.query(`CREATE EXTENSION IF NOT EXISTS btree_gin`).catch(() => {});
  await adminScratch.end();
  const t = new URL(PG_URL); t.pathname = `/${DB}`;
  scratchUrl = t.toString();
  u.pathname = `/${DB}`;
  scratch = new pg.Pool({ connectionString: u.toString(), max: 1 });
}, 60_000);

afterAll(async () => {
  await scratch?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
});

const pgTest = PG_URL ? test : test.skip;

describe('toolkit_presence seed', () => {
  pgTest('the boot that creates the table seeds it, and a later boot does not', async () => {
    await boot();
    // Back to the state before this release: the item rows exist, the table not.
    await scratch.query(`DROP TABLE toolkit_presence`);
    await scratch.query(`INSERT INTO tenants (tenant, created_at) VALUES ('acme', 1) ON CONFLICT DO NOTHING`);
    await scratch.query(`INSERT INTO memory_metadata (tenant, id, source_type, title, indexed_at, author_device, extra_json) VALUES
      ('acme', 'claude_mcp_a', 'mcp', 'a', 1, 'laptop', '{"syncedDeviceId":"desktop"}'),
      ('acme', 'claude_skill_b', 'skill', 'b', 1, 'laptop', 'not json at all'),
      ('acme', 'plan_c', 'plan', 'c', 1, 'laptop', '{}')`);

    await boot();
    // Both recorded devices for the MCP row, the first uploader for the skill
    // row whose extra is not JSON, and nothing for a plan.
    expect(await presence()).toEqual([
      { source_type: 'mcp', id: 'claude_mcp_a', device: 'desktop' },
      { source_type: 'mcp', id: 'claude_mcp_a', device: 'laptop' },
      { source_type: 'skill', id: 'claude_skill_b', device: 'laptop' },
    ]);

    // A device removes its presence, then the server boots again.
    await scratch.query(`DELETE FROM toolkit_presence WHERE device = 'desktop'`);
    await boot();
    expect(await presence()).toEqual([
      { source_type: 'mcp', id: 'claude_mcp_a', device: 'laptop' },
      { source_type: 'skill', id: 'claude_skill_b', device: 'laptop' },
    ]);

    const policies = (await scratch.query(`SELECT policyname FROM pg_policies WHERE tablename = 'toolkit_presence'`)).rows;
    expect(policies.map((p: { policyname: string }) => p.policyname)).toContain('tenant_isolation');
  }, 60_000);
});
