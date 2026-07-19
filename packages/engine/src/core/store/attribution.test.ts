/**
 * Author attribution (team collaboration, Phase 0).
 *
 * Two layers:
 *  1. The ambient author context (runWithAuthor/currentAuthor) — pure, always
 *     runs. This is what the server auth middleware / sync route wrap requests
 *     in, and what PgStore reads at write time.
 *  2. (pg-gated on DATABASE_URL) The store actually stamps author_sub /
 *     author_device onto memory_metadata + memory_chunks from that context,
 *     and a NULL context leaves them NULL (legacy/solo).
 */
import { describe, test, expect, afterAll, beforeAll } from 'vitest';
import { runWithAuthor, currentAuthor, runWithTenant } from './tenant-context.js';
import { tenantQuery } from './pg-pool.js';
import pg from 'pg';

describe('ambient author context', () => {
  test('defaults to a null author outside any context', () => {
    expect(currentAuthor()).toEqual({ sub: null, device: null });
  });

  test('runWithAuthor sets the author for the enclosed async work', async () => {
    await runWithAuthor({ sub: 'user-alice', device: 'laptop-1' }, async () => {
      expect(currentAuthor()).toEqual({ sub: 'user-alice', device: 'laptop-1' });
      // Survives an await boundary (AsyncLocalStorage propagation).
      await Promise.resolve();
      expect(currentAuthor()).toEqual({ sub: 'user-alice', device: 'laptop-1' });
    });
    // Restored to the null default once the scope exits.
    expect(currentAuthor()).toEqual({ sub: null, device: null });
  });

  test('nests independently of the tenant context', async () => {
    await runWithTenant('team-acme', () =>
      runWithAuthor({ sub: 'user-bob', device: 'ci-runner' }, async () => {
        expect(currentAuthor()).toEqual({ sub: 'user-bob', device: 'ci-runner' });
      }),
    );
  });
});

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;

(PG_URL ? describe : describe.skip)('PgStore stamps attribution from the ambient author', () => {
  const TENANT = 'attr_test';
  let closers: Array<() => Promise<void>> = [];

  afterAll(async () => { for (const c of closers) await c().catch(() => {}); });

  async function withStore<T>(author: { sub: string | null; device: string | null } | null, fn: (s: any) => Promise<T>): Promise<T> {
    const { createStore } = await import('./index.js');
    const run = async () => {
      const s = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: TENANT } as any);
      closers.push(() => s.close());
      return fn(s);
    };
    return runWithTenant(TENANT, () => (author ? runWithAuthor(author, run) : run()));
  }

  test('setItem + addChunksFTS carry author_sub / author_device', async () => {
    const now = Date.now();
    await withStore({ sub: 'user-alice', device: 'laptop-1' }, async (s) => {
      await s.setItem({ id: 'attr-sess-1', sourceType: 'session', title: 'T', projectPath: '/p', projectId: 'git:h/o/r', filePath: '', mtime: now, contentPreview: '' });
      await s.addChunksFTS([{ chunkId: 'attr-sess-1:0', itemId: 'attr-sess-1', sourceType: 'session', title: 'T', text: 'hello world', chunkType: '', projectPath: '/p', projectId: 'git:h/o/r', filePath: '', mtime: now }]);
    });
    // Read back through a fresh (author-less) store — attribution is durable.
    const rows = await withStore(null, (s) => (s as any).qr
      ? (s as any).qr(`SELECT author_sub, author_device FROM memory_metadata WHERE tenant=$1 AND id=$2 AND source_type='session'`, [TENANT, 'attr-sess-1'])
      : Promise.resolve([]));
    expect(rows[0]).toMatchObject({ author_sub: 'user-alice', author_device: 'laptop-1' });
  });

  test('a null author (solo/legacy) leaves attribution NULL', async () => {
    const now = Date.now();
    await withStore(null, async (s) => {
      await s.setItem({ id: 'attr-sess-2', sourceType: 'session', title: 'T2', projectPath: '/p', projectId: 'git:h/o/r', filePath: '', mtime: now, contentPreview: '' });
    });
    const rows = await withStore(null, (s) => (s as any).qr(
      `SELECT author_sub, author_device FROM memory_metadata WHERE tenant=$1 AND id=$2 AND source_type='session'`, [TENANT, 'attr-sess-2']));
    expect(rows[0]).toMatchObject({ author_sub: null, author_device: null });
  });
});

const VIS_TENANT = 'vis_test';
const VIS_ROLE = 'cr_vis_test';
const VIS_PASS = 'vispass';

/**
 * The security guarantee is the RLS policy, and RLS is only binding under a
 * NOBYPASSRLS role (a superuser — which POSTGRES_USER is — silently bypasses
 * it). So: SEED as the superuser store (real author stamping + schema), then
 * READ as a restricted role through the REAL tenantQuery path (which sets
 * app.tenant + app.viewer via setScopeGucs from the ambient author context).
 * This exercises the exact plumbing every store read uses, with the policy
 * actually enforced.
 */
(PG_URL ? describe : describe.skip)('per-project visibility — Postgres RLS (restricted role)', () => {
  const closers: Array<() => Promise<void>> = [];
  let restricted: any;

  beforeAll(async () => {
    const { createStore } = await import('./index.js');
    const { createControlPlane } = await import('./control-plane.js');
    const now = Date.now();

    // Seed under the superuser store — stamps author from the ambient context.
    const seedRow = (id: string, project: string, author: { sub: string | null; device: string | null } | null) =>
      runWithTenant(VIS_TENANT, () => {
        const run = async () => {
          const s = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant: VIS_TENANT } as any);
          closers.push(() => s.close());
          await s.setItem({ id, sourceType: 'session', title: id, projectPath: '/' + project, projectId: project, filePath: '', mtime: now, contentPreview: '' });
          await s.addChunksFTS([{ chunkId: id + ':0', itemId: id, sourceType: 'session', title: id, text: 'searchable widget text', chunkType: '', projectPath: '/' + project, projectId: project, filePath: '', mtime: now }]);
          await s.replaceSecretFindings(id, [{ detector: 'test', rule: 'r', line: 1, preview: '***' + id }]);
          await s.putRawSession(id, 'claude', now, Buffer.from('rawgz-' + id), 8);
        };
        return author ? runWithAuthor(author, run) : run();
      });
    await seedRow('a-alpha', 'proj:alpha', { sub: 'alice', device: 'd1' });
    await seedRow('a-beta', 'proj:beta', { sub: 'alice', device: 'd1' });
    await seedRow('b-alpha', 'proj:alpha', { sub: 'bob', device: 'd2' });
    await seedRow('legacy', 'proj:alpha', null);
    const cp = await createControlPlane({ backend: 'postgres', databaseUrl: PG_URL } as any);
    closers.push(() => cp.close());
    await cp.setShare(VIS_TENANT, 'bob', 'proj:alpha', 'full');   // bob shares proj:alpha

    // A KG triple authored by alice with NO source session — must stay private
    // to alice (MEDIUM-2: unsourced facts were previously team-visible).
    const { createKnowledgeGraph } = await import('./knowledge-graph.js');
    await runWithTenant(VIS_TENANT, () => runWithAuthor({ sub: 'alice', device: 'd1' }, async () => {
      const kg = await createKnowledgeGraph({ backend: 'postgres', databaseUrl: PG_URL, tenant: VIS_TENANT } as any);
      closers.push(() => kg.close());
      await kg.addTriple('AlicePrivateEntity', 'relates_to', 'AlicePrivateThing', {});
    }));

    // Restricted, RLS-subject role + a pool that connects as it.
    const sudo = new pg.Pool({ connectionString: PG_URL });
    await sudo.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${VIS_ROLE}') THEN CREATE ROLE ${VIS_ROLE} LOGIN PASSWORD '${VIS_PASS}' NOBYPASSRLS; END IF; END $$;`);
    await sudo.query(`GRANT USAGE ON SCHEMA public TO ${VIS_ROLE}`);
    await sudo.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${VIS_ROLE}`);
    await sudo.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${VIS_ROLE}`);
    await sudo.end();
    const u = new URL(PG_URL!); u.username = VIS_ROLE; u.password = VIS_PASS;
    restricted = new pg.Pool({ connectionString: u.toString() });
    closers.push(async () => { await restricted.end(); });
  }, 60000);

  afterAll(async () => { for (const c of closers) await c().catch(() => {}); });

  // Read through the REAL tenantQuery (sets app.tenant + app.viewer from the
  // ambient author) against the restricted pool → RLS binds.
  async function idsAs(viewer: string | null | undefined, sql: string, params: unknown[] = []): Promise<string[]> {
    const run = async () => (await tenantQuery(restricted, VIS_TENANT, sql, params)).rows.map((r: any) => r.id ?? r.item_id ?? r.session_id).sort();
    return viewer === undefined ? run() : runWithAuthor({ sub: viewer, device: null }, run);
  }

  const FEED = `SELECT id FROM memory_metadata WHERE source_type='session'`;
  const CHUNKS = `SELECT DISTINCT item_id FROM memory_chunks WHERE text LIKE '%widget%'`;
  const FINDINGS = `SELECT DISTINCT session_id FROM secret_findings`;
  const RAW = `SELECT session_id FROM raw_sessions`;

  test('memory_metadata feed: alice sees own + shared + legacy', async () => {
    const ids = await idsAs('alice', FEED);
    expect(ids).toEqual(['a-alpha', 'a-beta', 'b-alpha', 'legacy']);
  });

  test('memory_metadata feed: bob sees only own + legacy (alice shared nothing)', async () => {
    const ids = await idsAs('bob', FEED);
    expect(ids).toContain('b-alpha');
    expect(ids).toContain('legacy');
    expect(ids).not.toContain('a-alpha');
    expect(ids).not.toContain('a-beta');
  });

  test('memory_chunks (search) inherits visibility — no leak via chunk text', async () => {
    const ids = await idsAs('bob', CHUNKS);
    expect(ids).toContain('b-alpha');
    expect(ids).toContain('legacy');
    expect(ids).not.toContain('a-alpha');
    expect(ids).not.toContain('a-beta');
  });

  test('secret_findings inherit session visibility — no secrets leak (C2)', async () => {
    const ids = await idsAs('bob', FINDINGS);
    expect(ids).toContain('b-alpha');
    expect(ids).not.toContain('a-alpha');
    expect(ids).not.toContain('a-beta');
  });

  test('raw_sessions inherit session visibility — no raw-transcript leak (re-review #1)', async () => {
    // raw_sessions must have RLS ENABLED for its author_visibility policy to
    // bind (the bug: a policy on a table without RLS enabled is inert).
    const ids = await idsAs('bob', RAW);
    expect(ids).toContain('b-alpha');
    expect(ids).toContain('legacy');
    expect(ids).not.toContain('a-alpha');
    expect(ids).not.toContain('a-beta');
  });

  test('teamActivity rollup respects RLS — bob\'s rollup excludes alice\'s unshared work (Phase 2)', async () => {
    // The Phase-2 activity endpoint groups memory_metadata by (author, project)
    // under the viewer's RLS, so a teammate who shared nothing never appears.
    const r = await runWithAuthor({ sub: 'bob', device: null }, () =>
      tenantQuery(restricted, VIS_TENANT,
        `SELECT author_sub, project_id, COUNT(*)::int AS sessions FROM memory_metadata
         WHERE tenant=$1 AND source_type='session' GROUP BY author_sub, project_id`, [VIS_TENANT]));
    const subs = (r.rows as any[]).map((x) => x.author_sub);
    expect(subs).toContain('bob');       // own
    expect(subs).not.toContain('alice'); // alice shared nothing → excluded
  });

  test('fetch-by-id of an unshared session returns no row for bob', async () => {
    expect(await idsAs('bob', `${FEED} AND id='a-beta'`)).toEqual([]);
    expect(await idsAs('bob', `${FEED} AND id='b-alpha'`)).toEqual(['b-alpha']);
    expect(await idsAs('alice', `${FEED} AND id='b-alpha'`)).toEqual(['b-alpha']); // shared
  });

  test('no viewer (worker: no author context) sees everything — app.viewer unset', async () => {
    const ids = await idsAs(undefined, FEED);
    expect(ids).toEqual(['a-alpha', 'a-beta', 'b-alpha', 'legacy']);
  });

  test('unsourced KG triples are private to their author (MEDIUM-2)', async () => {
    const countAs = async (viewer: string) => Number((await runWithAuthor({ sub: viewer, device: null }, () =>
      tenantQuery(restricted, VIS_TENANT, `SELECT COUNT(*)::int AS n FROM kg_triples WHERE author_sub='alice'`, []))).rows[0].n);
    expect(await countAs('alice')).toBe(1);   // author sees her own fact
    expect(await countAs('bob')).toBe(0);     // teammate does NOT (no source session, not shared)
  });

  test('a null-sub request (self-host, app.viewer=empty) sees only legacy + team-shared, never a teammate\'s private rows', async () => {
    // A request that authenticated but has no user id must NOT see attributed
    // PRIVATE teammate rows (a-alpha/a-beta). It sees legacy (NULL author) and
    // anything shared into the team (b-alpha, shared by bob) — fail-closed on
    // the private rows, which is the guarantee that matters.
    const ids = await idsAs(null, FEED);
    expect(ids).toEqual(['b-alpha', 'legacy']);
    expect(ids).not.toContain('a-alpha');
    expect(ids).not.toContain('a-beta');
  });
});

(PG_URL ? describe : describe.skip)('collaborative team tasks (Phase 3)', () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => { for (const c of closers) await c().catch(() => {}); });

  async function storeFor(tenant: string) {
    const { createStore } = await import('./index.js');
    const s = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant } as any);
    closers.push(() => s.close());
    return s as any;
  }

  test('create → list → filter → update → comment → get', async () => {
    await runWithTenant('tasks_test', async () => {
      const s = await storeFor('tasks_test');
      const t = await s.createTeamTask({ title: 'Fix auth', createdBy: 'alice', projectId: 'git:x/y', assigneeSub: 'bob' });
      expect(t.id).toMatch(/^t_/);
      expect(t.status).toBe('todo');
      expect(t.assigneeSub).toBe('bob');

      const all = await s.listTeamTasks({});
      expect(all.map((x: any) => x.id)).toContain(t.id);
      expect((await s.listTeamTasks({ assigneeSub: 'bob' })).length).toBeGreaterThanOrEqual(1);
      expect((await s.listTeamTasks({ status: 'done' })).find((x: any) => x.id === t.id)).toBeUndefined();

      const upd = await s.updateTeamTask(t.id, { status: 'in_progress', assigneeSub: 'carol' });
      expect(upd.status).toBe('in_progress');
      expect(upd.assigneeSub).toBe('carol');

      const c = await s.addTeamTaskComment(t.id, 'carol', 'on it');
      expect(c.body).toBe('on it');

      const got = await s.getTeamTask(t.id);
      expect(got.task.status).toBe('in_progress');
      expect(got.comments).toHaveLength(1);
      expect(got.comments[0].authorSub).toBe('carol');
    });
  }, 30000);

  test('tasks are tenant-isolated', async () => {
    await runWithTenant('tasks_A', async () => {
      const s = await storeFor('tasks_A');
      await s.createTeamTask({ title: 'A-only task', createdBy: 'a' });
    });
    const bTasks = await runWithTenant('tasks_B', async () => {
      const s = await storeFor('tasks_B');
      return s.listTeamTasks({});
    });
    expect(bTasks).toHaveLength(0);
  }, 30000);
});
