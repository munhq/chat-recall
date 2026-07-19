/**
 * Per-project sharing over the DATA-PLANE /api/shares (Phase 4 convergence).
 *
 * These routes run AFTER tenantAuth, so this also exercises the multi-team
 * `x-team` resolution: a member creates a team, then shares/lists/unshares
 * with `x-team` selecting the tenant and owner_sub forced to the caller. A
 * non-member is 403 at tenantAuth (can't even resolve the tenant).
 *
 * Auth: AUTH_PROVIDER=keycloak + AUTH_DEV_USER=1 + `x-dev-user` (the middleware
 * dev escape hatch), isolated CHAT_RECALL_DATA_DIR + sqlite control plane.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
const prev: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ['CHAT_RECALL_DATA_DIR', 'AUTH_DEV_USER', 'AUTH_PROVIDER']) prev[k] = process.env[k];
  dataDir = mkdtempSync(join(tmpdir(), 'cr-shares-test-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  process.env.AUTH_DEV_USER = '1';
  process.env.AUTH_PROVIDER = 'keycloak';   // enables the x-dev-user → tenant path
});

afterAll(() => {
  for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('/api/shares data-plane sharing (+ x-team resolution)', () => {
  test('create team → share (x-team) → list mine → unshare; non-member 403 at tenantAuth', async () => {
    const teamsRouter = (await import('./teams.js')).default;
    const sharesRouter = (await import('./shares.js')).default;
    const { tenantAuth } = await import('../middleware/auth.js');
    const app = express();
    app.use(express.json());
    app.use('/api', teamsRouter);              // team CRUD (requireUser, pre-tenantAuth)
    app.use('/api', tenantAuth);               // resolves req.tenant/authorSub from x-dev-user + x-team
    app.use('/api/shares', sharesRouter);

    const alice = (r: request.Test) => r.set('x-dev-user', 'alice');
    const mallory = (r: request.Test) => r.set('x-dev-user', 'mallory');

    const created = await alice(request(app).post('/api/teams')).send({ name: 'Shares Inc' });
    expect(created.status).toBe(200);
    const slug = created.body.slug as string;

    // Share (x-team selects the tenant; owner_sub is forced to alice).
    const shared = await alice(request(app).post('/api/shares')).set('x-team', slug).send({ project_id: 'git:h/o/r' });
    expect(shared.status).toBe(200);
    expect(shared.body).toMatchObject({ ok: true, project_id: 'git:h/o/r', scope: 'full' });

    // Mine lists it.
    const mine = await alice(request(app).get('/api/shares')).set('x-team', slug);
    expect(mine.status).toBe(200);
    expect(mine.body.shares).toEqual([expect.objectContaining({ ownerSub: 'alice', projectId: 'git:h/o/r', scope: 'full' })]);

    // Unshare → empty.
    const removed = await alice(request(app).delete('/api/shares')).set('x-team', slug).send({ project_id: 'git:h/o/r' });
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBe(true);
    expect((await alice(request(app).get('/api/shares')).set('x-team', slug)).body.shares).toHaveLength(0);

    // A non-member can't even resolve the tenant → 403 at tenantAuth.
    expect((await mallory(request(app).get('/api/shares')).set('x-team', slug)).status).toBe(403);
    expect((await mallory(request(app).post('/api/shares')).set('x-team', slug).send({ project_id: 'x' })).status).toBe(403);
  });
});
