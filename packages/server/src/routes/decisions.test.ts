/**
 * Integration tests for /api/decisions — the cascade, and the reversal.
 *
 * The reversal case is the one this whole feature exists for, and it is the one
 * that silently did nothing before areas existed: a free-text subject meant
 * "auth" and "authentication" were different facts, so recording a new auth
 * decision never closed the old one and both stayed live forever.
 *
 * These run against the sqlite driver on a temp home, like the kv/diary route
 * tests, so they assert behaviour rather than a Postgres plan.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import decisionsRouter from './decisions.js';
import { createKnowledgeGraph } from '@chat-recall/engine/core/store/knowledge-graph.js';
import { homeEnvSnapshot, restoreHomeEnv, useHomeDir } from '@chat-recall/engine/test-support/home-env.js';

let tmpHome: string;
const origHome = homeEnvSnapshot();
let app: Express;

/** One indexed project, so the canonical-key resolution has something to resolve. */
const PROJ_PATH = '/home/user/code/personal/example-app';
const PROJ_ID = 'git:github.com/owner/example-app';

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'decisions-route-'));
  useHomeDir(tmpHome);
  app = express();
  app.use(express.json());
  app.use('/api/decisions', decisionsRouter);

  const { createStore } = await import('@chat-recall/engine/core/store/index.js');
  const store = await createStore();
  try {
    await store.setItem({
      id: 'sess-example', sourceType: 'session', title: 'a session',
      projectPath: PROJ_PATH, projectId: PROJ_ID, filePath: `${PROJ_PATH}/t.jsonl`, mtime: 1,
    });
  } finally { await store.close(); }
});
afterAll(() => {
  restoreHomeEnv(origHome);
  rmSync(tmpHome, { recursive: true, force: true });
});

const post = (body: Record<string, unknown>) => request(app).post('/api/decisions').send(body);
const get = (qs = '') => request(app).get(`/api/decisions${qs}`);

describe('recording a decision', () => {
  test('an area is required — a decision with no key supersedes nothing', async () => {
    const r = await post({ value: 'BetterAuth' });
    expect(r.status).toBe(400);
  });

  test('a value is required', async () => {
    const r = await post({ area: 'auth' });
    expect(r.status).toBe(400);
  });

  test('a recorded decision says when it was decided', async () => {
    // A slug area, so this never fills one of the canonical gaps the gap test reads.
    const r = await post({ area: 'queueing', value: 'NATS' });
    expect(r.status).toBe(201);
    const list = await get();
    const row = list.body.decisions.find((d: { area: string }) => d.area === 'queueing');
    expect(row.since).toBe(new Date().toISOString().slice(0, 10));
  });

  test('a decision stored before dates were stamped still reports one', async () => {
    // The 41 rows already in the register have a null valid_from, because
    // neither write path passed one. They read their date from the row's own
    // write time instead of coming back with since: null forever.
    const kg = await createKnowledgeGraph();
    await kg.addTriple('*:caching', 'decided', 'Dragonfly', { confidence: 1 } as never);
    await kg.close();

    const list = await get();
    const row = list.body.decisions.find((d: { area: string }) => d.area === 'caching');
    expect(row.since).toBe(new Date().toISOString().slice(0, 10));
  });

  test('the area is canonicalised, so spellings do not split the key', async () => {
    const r = await post({ area: 'Authentication', value: 'BetterAuth' });
    expect(r.status).toBe(201);
    expect(r.body.area).toBe('auth');
    expect(r.body.subject).toBe('*:auth');
  });
});

describe('THE REVERSAL — the case the feature exists for', () => {
  test('a later decision on the same area closes the earlier one', async () => {
    await post({ area: 'database', value: 'Keycloak-era Postgres', reason: 'first call' });
    await post({ area: 'database', value: 'SQLite', reason: 'changed our minds' });

    const r = await get();
    const db = r.body.decisions.find((d: { area: string }) => d.area === 'database');
    expect(db.value).toBe('SQLite');

    // The old value is history, not a second live answer.
    const replaced = db.history.filter((h: { current: boolean }) => !h.current);
    expect(replaced.map((h: { value: string }) => h.value)).toContain('Keycloak-era Postgres');
    expect(db.history.filter((h: { current: boolean }) => h.current)).toHaveLength(1);
  });

  test('a reversal in one area does not touch another', async () => {
    const r = await get();
    const auth = r.body.decisions.find((d: { area: string }) => d.area === 'auth');
    // `auth` was decided before the database reversals above and must survive
    // them — superseding on (project, area) rather than on the project alone is
    // exactly what stops one decision closing every unrelated one.
    expect(auth.value).toBe('BetterAuth');
  });

  test('a differently-spelled area still supersedes, because the key is canonical', async () => {
    await post({ area: 'sign-in', value: 'Passkeys' });
    const r = await get();
    const auth = r.body.decisions.find((d: { area: string }) => d.area === 'auth');
    expect(auth.value).toBe('Passkeys');
    expect(auth.history.filter((h: { current: boolean }) => !h.current).map((h: { value: string }) => h.value))
      .toContain('BetterAuth');
  });
});

describe('the cascade', () => {
  test('a project with no opinion inherits the account decision', async () => {
    const r = await get('?project=example-app');
    const auth = r.body.decisions.find((d: { area: string }) => d.area === 'auth');
    expect(auth.inherited).toBe(true);
    expect(auth.override).toBe(false);
    expect(auth.value).toBe('Passkeys');
  });

  test('a project decision beats the account, and is flagged as an override', async () => {
    await post({ area: 'auth', value: 'Keycloak', project: 'acme', reason: 'client mandates it' });

    const r = await get('?project=acme');
    const auth = r.body.decisions.find((d: { area: string }) => d.area === 'auth');
    expect(auth.value).toBe('Keycloak');
    expect(auth.override).toBe(true);
    expect(auth.inherited).toBe(false);
    expect(auth.scope).toBe('project');
  });

  test('one project overriding does not change what another project sees', async () => {
    const r = await get('?project=example-app');
    const auth = r.body.decisions.find((d: { area: string }) => d.area === 'auth');
    expect(auth.value).toBe('Passkeys');
    expect(auth.override).toBe(false);
  });

  test('the account view is unaffected by a project override', async () => {
    const r = await get();
    const auth = r.body.decisions.find((d: { area: string }) => d.area === 'auth');
    expect(auth.value).toBe('Passkeys');
  });
});

describe('the workspace tier — a folder group of repositories', () => {
  test('a repository in the group inherits the group decision, not the account one', async () => {
    await post({ area: 'deploy', value: 'Fly.io' });                       // account
    await post({ area: 'deploy', value: 'k3s + ArgoCD', workspace: 'personal' });

    const r = await get('?project=example-app&workspace=personal');
    const deploy = r.body.decisions.find((d: { area: string }) => d.area === 'deploy');
    expect(deploy.value).toBe('k3s + ArgoCD');
    expect(deploy.scope).toBe('workspace');
    expect(deploy.scope_key).toBe('ws:personal');
    expect(deploy.inherited).toBe(true);   // example-app did not decide it
    expect(deploy.override).toBe(true);    // but the group overrides the account
  });

  test('a repository outside the group still sees the account decision', async () => {
    const r = await get('?project=billing&workspace=acme');
    const deploy = r.body.decisions.find((d: { area: string }) => d.area === 'deploy');
    expect(deploy.value).toBe('Fly.io');
    expect(deploy.scope).toBe('account');
  });

  test('the repository beats its own group', async () => {
    await post({ area: 'deploy', value: 'Railway', project: 'example-app' });
    const r = await get('?project=example-app&workspace=personal');
    const deploy = r.body.decisions.find((d: { area: string }) => d.area === 'deploy');
    expect(deploy.value).toBe('Railway');
    expect(deploy.scope).toBe('project');
    expect(deploy.override).toBe(true);
    expect(deploy.inherited).toBe(false);
  });

  test('a sibling repository in the group is untouched by that override', async () => {
    const r = await get('?project=other-app&workspace=personal');
    const deploy = r.body.decisions.find((d: { area: string }) => d.area === 'deploy');
    expect(deploy.value).toBe('k3s + ArgoCD');
    expect(deploy.scope).toBe('workspace');
  });

  test('the account register is unchanged by either', async () => {
    const r = await get();
    const deploy = r.body.decisions.find((d: { area: string }) => d.area === 'deploy');
    expect(deploy.value).toBe('Fly.io');
    expect(deploy.scope).toBe('account');
  });

  test('the response names the chain it resolved through', async () => {
    const r = await get('?project=example-app&workspace=personal');
    // The canonical key first, then the spelling that was asked for, then the
    // broader tiers. Both project keys are tried before the group.
    expect(r.body.chain).toEqual([PROJ_ID, 'example-app', 'ws:personal', '*']);
    expect(r.body.workspace).toBe('personal');
  });
});

describe('one repository, one register, whatever it is called', () => {
  // The two surfaces name a project differently: the dashboard passes the
  // project_id it resolved, an agent passes whatever the user typed. Both must
  // reach the same rows, or a decision recorded in the browser is invisible to
  // the agent and each half of the register looks complete.

  test('a decision recorded by NAME is found when the dashboard asks by ID', async () => {
    await post({ area: 'frontend', value: 'Svelte', project: 'example-app' });
    const r = await get(`?project=${encodeURIComponent(PROJ_ID)}`);
    expect(r.body.decisions.find((d: { area: string }) => d.area === 'frontend').value).toBe('Svelte');
  });

  test('and when asked by path, and by the name again', async () => {
    for (const spelling of [PROJ_PATH, 'example-app']) {
      const r = await get(`?project=${encodeURIComponent(spelling)}`);
      const row = r.body.decisions.find((d: { area: string }) => d.area === 'frontend');
      expect(row.value, `asked as ${spelling}`).toBe('Svelte');
    }
  });

  test('every write lands on the canonical key, whatever spelling was used', async () => {
    const r = await post({ area: 'observability', value: 'Grafana Cloud', project: 'example-app' });
    expect(r.body.subject).toBe(`${PROJ_ID}:observability`);
  });

  test('the response names the key writes will use', async () => {
    const r = await get('?project=example-app');
    expect(r.body.project_key).toBe(PROJ_ID);
  });

  test('THE UPGRADE: a decision written under the OLD key still answers', async () => {
    // Recorded straight into the graph under the bare name, which is what every
    // decision recorded before canonicalisation looks like. Nobody has to
    // migrate anything: the chain reads the canonical key first, then the
    // spellings that came before it.
    const kg = await createKnowledgeGraph();
    await kg.addTriple('example-app:vector-store', 'decided', 'pgvector', { confidence: 1 } as never);
    await kg.close();

    const r = await get(`?project=${encodeURIComponent(PROJ_ID)}`);
    expect(r.body.chain[0]).toBe(PROJ_ID);
    expect(r.body.chain).toContain('example-app');
    const row = r.body.decisions.find((d: { area: string }) => d.area === 'vector-store');
    expect(row.value).toBe('pgvector');
    expect(row.scope_key).toBe('example-app');
  });

  test('and the canonical key wins as soon as that area is decided again', async () => {
    await post({ area: 'vector-store', value: 'Qdrant', project: PROJ_ID });
    const r = await get('?project=example-app');
    const row = r.body.decisions.find((d: { area: string }) => d.area === 'vector-store');
    expect(row.value).toBe('Qdrant');
    expect(row.scope_key).toBe(PROJ_ID);
  });
});

describe('a write must know which scope it meant', () => {
  test('a workspace write with no workspace named is refused, not widened', async () => {
    // Widening is how eight rows reached the account register and every
    // project inherited one repository's stack.
    const r = await post({ area: 'auth', value: 'Auth0', scope: 'workspace' });
    expect(r.status).toBe(400);
  });

  test('a project write with no project named is refused', async () => {
    const r = await post({ area: 'auth', value: 'Auth0', scope: 'project' });
    expect(r.status).toBe(400);
  });

  test('naming both, with no scope, binds the narrower one', async () => {
    // The project, canonicalised — the group is the broader of the two.
    const r = await post({ area: 'testing', value: 'Vitest', project: 'example-app', workspace: 'personal' });
    expect(r.body.subject).toBe(`${PROJ_ID}:testing`);
  });

  test('a workspace alone binds the group', async () => {
    const r = await post({ area: 'api', value: 'Hono', workspace: 'personal' });
    expect(r.body.subject).toBe('ws:personal:api');
  });

  test('an explicit account scope is still available for something true everywhere', async () => {
    const r = await post({ area: 'licensing', value: 'Elastic-2.0', project: 'example-app', scope: 'account' });
    expect(r.body.subject).toBe('*:licensing');
  });
});

describe('gaps', () => {
  test('a canonical area nobody decided is reported as a gap', async () => {
    const r = await get();
    const areas = r.body.gaps.map((g: { area: string }) => g.area);
    expect(areas).toContain('observability');
    expect(areas).not.toContain('auth');
  });

  test('a decided area leaves the gap list', async () => {
    await post({ area: 'observability', value: 'Grafana + Loki' });
    const r = await get();
    expect(r.body.gaps.map((g: { area: string }) => g.area)).not.toContain('observability');
  });

  test('an invented slug area is not treated as a gap everywhere else owes an answer for', async () => {
    await post({ area: 'Package Pinning', value: 'exact versions' });
    const r = await get();
    const decided = r.body.decisions.map((d: { area: string }) => d.area);
    expect(decided).toContain('package-pinning');
    // It is decided, but it never appears in `gaps` for anyone — gaps are the
    // canonical set only, or one team's local habit becomes everybody's debt.
    expect(r.body.gaps.map((g: { area: string }) => g.area)).not.toContain('package-pinning');
  });
});

describe('rationale', () => {
  test('the reason recorded with a decision comes back with it', async () => {
    await post({ area: 'payments', value: 'Stripe', reason: 'only rail that bills per seat' });
    const r = await get();
    const pay = r.body.decisions.find((d: { area: string }) => d.area === 'payments');
    expect(pay.why).toBe('only rail that bills per seat');
  });

  test('a new reason does not close the old decision — only a new value does', async () => {
    await post({ area: 'payments', value: 'Stripe', reason: 'and it handles VAT' });
    const r = await get();
    const pay = r.body.decisions.find((d: { area: string }) => d.area === 'payments');
    expect(pay.value).toBe('Stripe');
  });
});

describe('resolving a candidate', () => {
  test('confirm needs an area it can actually key on', async () => {
    const r = await request(app).post('/api/decisions/candidates/resolve')
      .send({ value: 'the second option', action: 'confirm' });
    expect(r.status).toBe(400);
  });

  test('an unknown action is refused', async () => {
    const r = await request(app).post('/api/decisions/candidates/resolve')
      .send({ value: 'Redis', action: 'maybe' });
    expect(r.status).toBe(400);
  });

  test('confirm infers the area from the value when none is given', async () => {
    const r = await request(app).post('/api/decisions/candidates/resolve')
      .send({ value: 'Redis', action: 'confirm' });
    expect(r.status).toBe(200);
    expect(r.body.area).toBe('database');

    const list = await get();
    const db = list.body.decisions.find((d: { area: string }) => d.area === 'database');
    expect(db.value).toBe('Redis');
  });

  test('an explicit area beats the inferred one', async () => {
    const r = await request(app).post('/api/decisions/candidates/resolve')
      .send({ value: 'Firebase', action: 'confirm', area: 'deploy' });
    expect(r.status).toBe(200);
    // inferArea('Firebase') says auth; the caller said deploy and wins.
    expect(r.body.area).toBe('deploy');
  });

  test('a confirmed guess keeps the conversation it came from', async () => {
    // The extractor's guess carries the session it read the value out of. The
    // dashboard has none, so without the inheritance the decision would land
    // with no conversation behind it.
    const kg = await createKnowledgeGraph();
    await kg.addTriple('example-app', 'chose', 'Fastify', {
      confidence: 0.8, sourceSession: 'sess-from-the-guess', validFrom: '2026-03-02',
    } as never);
    await kg.close();

    const r = await request(app).post('/api/decisions/candidates/resolve')
      .send({ value: 'Fastify', action: 'confirm', area: 'framework' });
    expect(r.status).toBe(200);

    const list = await get();
    const row = list.body.decisions.find((d: { area: string }) => d.area === 'framework');
    expect(row.source_session).toBe('sess-from-the-guess');
  });

  test('discard retires the guess without recording a decision', async () => {
    const before = await get();
    const r = await request(app).post('/api/decisions/candidates/resolve')
      .send({ value: 'Nothing Anyone Chose', action: 'discard' });
    expect(r.status).toBe(200);
    expect(r.body.area).toBeNull();

    const after = await get();
    // No new decision appeared from a discard.
    expect(after.body.decisions.length).toBe(before.body.decisions.length);
  });
});

describe('the guard — POST /check', () => {
  const check = (body: Record<string, unknown>) =>
    request(app).post('/api/decisions/check').send(body);

  test('nothing named is allowed without touching the graph', async () => {
    const r = await check({ names: [] });
    expect(r.body.verdict).toBe('allow');
    expect(r.body.findings).toEqual([]);
  });

  test('a name nobody has an opinion about is allowed', async () => {
    const r = await check({ names: ['left-pad'] });
    expect(r.body.verdict).toBe('allow');
  });

  test('THE POINT: reaching for the loser of a decision is flagged', async () => {
    // Record the shape the extractor writes for "X over Y".
    await request(app).post('/api/decisions').send({ area: 'auth', value: 'BetterAuth' });
    const r = await check({ names: ['betterauth'] });
    // The winner itself is never flagged.
    expect(r.body.verdict).toBe('allow');
  });

  test('a different answer in a decided area is flagged, with what was decided', async () => {
    await request(app).post('/api/decisions').send({ area: 'database', value: 'Postgres' });
    const r = await check({ names: ['mysql'] });
    expect(r.body.verdict).toBe('warn');
    const f = r.body.findings.find((x: { name: string }) => x.name === 'mysql');
    expect(f.area).toBe('database');
    expect(f.instead).toBe('Postgres');
    expect(f.reason).toContain('database is decided');
  });

  test('a name in an UNdecided area is not flagged', async () => {
    // stripe is payments; nothing has decided payments in this scope yet.
    const r = await check({ names: ['stripe'] });
    expect(r.body.findings.some((f: { name: string }) => f.name === 'stripe')).toBe(false);
  });

  test('a project override is what its agents are held to', async () => {
    await request(app).post('/api/decisions')
      .send({ area: 'database', value: 'SQLite', project: 'edge-app' });
    // Inside that project, Postgres is now the one that disagrees.
    const r = await check({ names: ['postgres'], project: 'edge-app' });
    expect(r.body.verdict).toBe('warn');
    expect(r.body.findings[0].instead).toBe('SQLite');
  });

  test('the verdict is warn, never deny — a wrong block costs the user a turn', async () => {
    const r = await check({ names: ['mysql'] });
    expect(r.body.verdict).toBe('warn');
    expect(r.body.verdict).not.toBe('deny');
  });

  test('an unparseable body is allowed rather than blocking work', async () => {
    const r = await check({ names: 'not-an-array' });
    expect(r.status).toBe(200);
    expect(r.body.verdict).toBe('allow');
  });
});
