/**
 * POST /api/sync, end to end, as a role that row-level security applies to.
 *
 * From 2026-09-16 every production sync returned HTTP 500:
 *
 *   new row violates row-level security policy "author_write_insert" for table "memory_metadata"
 *   new row violates row-level security policy "author_visibility" for table "memory_links"
 *
 * The route writes one batch in one transaction, as the device's named author.
 * The store tests could not see the fault, because they connected as the
 * bootstrap superuser and PostgreSQL skips RLS for it. vitest.global-setup.ts
 * now points DATABASE_URL at a role without SUPERUSER or BYPASSRLS that owns
 * the tables, which is the production shape.
 *
 * This drives the real route over HTTP with a device token minted for a named
 * user, and checks that every kind of row lands and carries that user's sub.
 * The admin connection only reads the rows back past RLS and cleans up.
 *
 * Gated on DATABASE_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { pgAdminUrl, pgTestUrl } from '@chat-recall/engine/test-support/pg-urls.js';

const PG_URL = pgTestUrl();
const TENANT = `sync_rls_${process.pid}`;
const AUTHOR = 'sync-rls-author';
const DEVICE = 'sync-rls-laptop';
const SESSION = '00000000-5555-6666-7777-888888888888';
const PLAN = 'plan-not-in-this-batch';
const MTIME = 1750000000000;

(PG_URL ? describe : describe.skip)('POST /api/sync as a named device author (RLS enforced)', () => {
  const saved = {
    storage: process.env.CHAT_RECALL_STORAGE,
    auth: process.env.AUTH_PROVIDER,
  };
  let admin: pg.Pool;
  let app: express.Express;
  let token: string;

  /** Delete this tenant's rows from every table that has a tenant column. */
  async function clean(): Promise<void> {
    const tables = (await admin.query(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant' AND t.table_type = 'BASE TABLE'`,
    )).rows.map((r: { table_name: string }) => r.table_name);
    for (const t of tables) {
      await admin.query(`DELETE FROM "${t.replace(/"/g, '""')}" WHERE tenant = $1`, [TENANT]);
    }
  }

  beforeAll(async () => {
    process.env.CHAT_RECALL_STORAGE = 'postgres';
    process.env.AUTH_PROVIDER = 'keycloak';
    admin = new pg.Pool({ connectionString: pgAdminUrl(), max: 2 });

    const { createControlPlane } = await import('../imports.js');
    const syncRouter = (await import('./sync.js')).default;
    app = express();
    app.use(express.json({ limit: '16mb' }));
    app.use('/api/sync', syncRouter);

    // The token lives in a tenant-keyed table too, so clean before minting it.
    await clean();
    const cp = await createControlPlane();
    try { token = await cp.mintAgentToken(TENANT, DEVICE, AUTHOR); }
    finally { await cp.close(); }
  }, 60000);

  afterAll(async () => {
    try { await clean(); } finally { await admin?.end(); }
    if (saved.storage === undefined) delete process.env.CHAT_RECALL_STORAGE;
    else process.env.CHAT_RECALL_STORAGE = saved.storage;
    if (saved.auth === undefined) delete process.env.AUTH_PROVIDER;
    else process.env.AUTH_PROVIDER = saved.auth;
  });

  test('the connection really is subject to RLS', async () => {
    // Without this, a DATABASE_URL that names a superuser makes every
    // assertion below pass for the wrong reason.
    const probe = new pg.Client({ connectionString: PG_URL });
    await probe.connect();
    try {
      const me = (await probe.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      )).rows[0];
      expect(me).toEqual({ rolsuper: false, rolbypassrls: false });
    } finally {
      await probe.end();
    }
  });

  test('a session with chunks, a link to an absent plan, compute rows and a finding lands, stamped with its author', async () => {
    const res = await request(app)
      .post('/api/sync')
      .set('authorization', `Bearer ${token}`)
      .send({
        conversations: [{
          session_id: SESSION,
          tool: 'claude',
          project_path: 'p_abcdef123456',
          mtime: MTIME,
          first_prompt: 'rebuild the zorbofrang coil',
          turns: [
            { role: 'user', text: 'rebuild the zorbofrang coil', ts: MTIME - 2000 },
            { role: 'assistant', text: 'Decided: the coil gets a new winding.', ts: MTIME - 1000 },
            { role: 'user', text: 'and test it', ts: MTIME },
          ],
          meta: { inputTokens: 100, outputTokens: 20 },
        }],
        // The plan is in neither this batch nor the database.
        links: [{
          source_type: 'session', source_id: SESSION,
          target_type: 'plan', target_id: PLAN,
          link_type: 'session_plan', confidence: 1,
        }],
        derived: [{
          session_id: SESSION,
          mtime: MTIME,
          compute: [
            { kind: 'markers', mtime: MTIME, data: { sessionId: SESSION, prompts: [], summary: { total: 0 } } },
            { kind: 'diff', mtime: MTIME, data: { files: [] } },
          ],
          outcome_row: { tool: 'claude', status: 'completed', reason: 'test', fileMtime: MTIME, isFull: true },
        }],
        findings: [{ session_id: SESSION, detector: 'gitleaks', rule: 'aws-key', line: 2, preview: '****ABCD' }],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ conv: 1, link: 1, find: 1, der: 3 });
    expect(res.body.chunks).toBeGreaterThan(0);

    const authors = async (table: string, key = 'session_id') => (await admin.query(
      `SELECT DISTINCT author_sub FROM ${table} WHERE tenant = $1 AND ${key} LIKE $2`,
      [TENANT, `${SESSION}%`],
    )).rows.map((r: { author_sub: string | null }) => r.author_sub);

    expect(await authors('memory_metadata', 'id')).toEqual([AUTHOR]);
    expect(await authors('memory_chunks', 'item_id')).toEqual([AUTHOR]);
    expect(await authors('session_metadata')).toEqual([AUTHOR]);
    expect(await authors('secret_findings')).toEqual([AUTHOR]);

    // The outcome row is visible through its session (pg-schema.ts), so the
    // ingest does not stamp an author on it. It must still land.
    const outcomes = (await admin.query(
      `SELECT status FROM session_outcome_cache WHERE tenant = $1 AND session_id = $2`, [TENANT, SESSION],
    )).rows.map((r: { status: string }) => r.status);
    expect(outcomes).toEqual(['completed']);

    const chunks = (await admin.query(
      `SELECT count(*)::int AS n FROM memory_chunks WHERE tenant = $1 AND item_id = $2`, [TENANT, SESSION],
    )).rows[0].n;
    expect(chunks).toBe(res.body.chunks);

    const compute = (await admin.query(
      `SELECT kind FROM compute_cache WHERE tenant = $1 AND session_id = $2 ORDER BY kind`, [TENANT, SESSION],
    )).rows.map((r: { kind: string }) => r.kind);
    expect(compute).toEqual(['diff', 'markers']);

    const links = (await admin.query(
      `SELECT source_id, target_type, target_id FROM memory_links WHERE tenant = $1`, [TENANT],
    )).rows;
    expect(links).toEqual([{ source_id: SESSION, target_type: 'plan', target_id: PLAN }]);
  }, 60000);
});
