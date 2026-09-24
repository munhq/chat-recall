/**
 * POST /api/sync against Postgres: everything the ingest writes commits or
 * rolls back with its one transaction.
 *
 * The outcome badges, the knowledge graph and the tool titles were written
 * through their own drivers, each on a pooled connection of its own that
 * committed at once. So a request that failed after them returned 500 and kept
 * them, and a tool title for a session the same request rewrote waited on the
 * row lock that the ingest transaction held until COMMIT, which came only after
 * the title was written.
 *
 * The route connects as the role in DATABASE_URL, which vitest.global-setup.ts
 * makes a role that row-level security applies to, as in production. The
 * admin connection only reads rows back past RLS. Postgres-gated: skipped when
 * DATABASE_URL is not set.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { pgAdminUrl, pgTestUrl } from '@chat-recall/engine/test-support/pg-urls.js';
import { PgStore } from '@chat-recall/engine/core/store/pg.js';

const PG_URL = pgTestUrl();
const MTIME = 1750000000000;
const MEMBER = 'sync-tx-member';

(PG_URL ? describe : describe.skip)('POST /api/sync — one transaction (postgres)', () => {
  const tenant = `sync_tx_${process.pid}`;
  const orig = {
    dbUrl: process.env.DATABASE_URL, storage: process.env.CHAT_RECALL_STORAGE, auth: process.env.AUTH_PROVIDER,
  };
  let admin: any;
  let app: express.Express;
  let token: string;

  beforeAll(async () => {
    const pg = (await import('pg')).default;
    admin = new pg.Pool({ connectionString: pgAdminUrl(), max: 2 });
    // A lock wait that cannot end would hang this suite. With a timeout it
    // fails as an error the assertions can see. The option is on this file's
    // URL only, so no other connection gets it.
    const url = new URL(PG_URL!);
    url.searchParams.set('options', '-c lock_timeout=5s');
    process.env.DATABASE_URL = url.toString();
    process.env.CHAT_RECALL_STORAGE = 'postgres';
    process.env.AUTH_PROVIDER = 'keycloak';

    const { createControlPlane } = await import('../imports.js');
    const syncRouter = (await import('./sync.js')).default;
    app = express();
    app.use(express.json({ limit: '16mb' }));
    app.use('/api/sync', syncRouter);
    const cp = await createControlPlane();
    try { token = await cp.mintAgentToken(tenant, 'sync-tx-laptop', MEMBER); }
    finally { await cp.close(); }
  }, 60000);

  afterEach(() => { vi.restoreAllMocks(); });

  afterAll(async () => {
    await admin?.end();
    for (const [k, v] of [['DATABASE_URL', orig.dbUrl], ['CHAT_RECALL_STORAGE', orig.storage], ['AUTH_PROVIDER', orig.auth]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/sync').set('authorization', `Bearer ${token}`).send(body);

  const conversation = (sessionId: string, text: string) => ({
    session_id: sessionId,
    tool: 'claude',
    project_path: 'p_abcdef123456',
    mtime: MTIME,
    first_prompt: text,
    turns: [
      { role: 'user', text, ts: MTIME - 1000 },
      { role: 'assistant', text: `answer to ${text}`, ts: MTIME },
    ],
    meta: { inputTokens: 10, outputTokens: 5 },
  });

  const rows = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows;

  test('a request that fails after the write keeps no outcome, triple or tool title', async () => {
    const stored = '10000000-0000-0000-0000-000000000001';
    const fresh = '10000000-0000-0000-0000-000000000002';
    const seeded = await post({ conversations: [conversation(stored, 'seed the stored session')] });
    expect(seeded.status).toBe(200);

    // The last step of the ingest fails, after every other write has run.
    vi.spyOn(PgStore.prototype, 'upsertSecretRule').mockRejectedValue(new Error('rule write failed'));
    const res = await post({
      conversations: [conversation(fresh, 'a session this request adds')],
      derived: [{
        session_id: fresh, mtime: MTIME,
        outcome_row: { tool: 'claude', status: 'completed', reason: 'test', fileMtime: MTIME, isFull: true },
      }],
      kg_entities: [{ name: 'rolled-back-entity', type: 'tool' }],
      kg_triples: [{ subject: 'rolled-back-entity', predicate: 'uses', object: 'postgres' }],
      fields: [{ session_id: stored, field: 'tool_title', value: 'title that must not land' }],
      custom_rules: [{ name: 'acme-token', regex: 'acme_[a-z0-9]{8}', severity: 'low' }],
    });
    expect(res.status).toBe(500);

    expect(await rows(`SELECT id FROM memory_metadata WHERE tenant=$1 AND id=$2`, [tenant, fresh])).toEqual([]);
    expect(await rows(`SELECT session_id FROM session_outcome_cache WHERE tenant=$1`, [tenant])).toEqual([]);
    expect(await rows(`SELECT id FROM kg_triples WHERE tenant=$1`, [tenant])).toEqual([]);
    expect(await rows(`SELECT id FROM kg_entities WHERE tenant=$1 AND id='rolled-back-entity'`, [tenant])).toEqual([]);
    expect(await rows(`SELECT tool_title FROM session_metadata WHERE tenant=$1 AND session_id=$2`, [tenant, stored]))
      .toEqual([{ tool_title: null }]);
  });

  test('a tool title for a session the same request rewrites lands with it', async () => {
    const id = '10000000-0000-0000-0000-000000000003';
    expect((await post({ conversations: [conversation(id, 'first version')] })).status).toBe(200);

    // The re-sync rewrites the session's metadata rows, which locks them until
    // COMMIT, and sets its tool title in the same request.
    const res = await post({
      conversations: [conversation(id, 'second version, rewritten')],
      fields: [{ session_id: id, field: 'tool_title', value: 'native title' }],
      derived: [{
        session_id: id, mtime: MTIME,
        outcome_row: { tool: 'claude', status: 'shipped', reason: 'test', fileMtime: MTIME, isFull: false },
      }],
      kg_triples: [{ subject: 'example-app', predicate: 'uses', object: 'postgres' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.fielded).toBe(1);
    expect(res.body.kgT).toBe(1);
    expect(await rows(`SELECT tool_title, author_sub FROM session_metadata WHERE tenant=$1 AND session_id=$2`, [tenant, id]))
      .toEqual([{ tool_title: 'native title', author_sub: MEMBER }]);
    expect(await rows(`SELECT status FROM session_outcome_cache WHERE tenant=$1 AND session_id=$2`, [tenant, id]))
      .toEqual([{ status: 'shipped' }]);
  });
});
