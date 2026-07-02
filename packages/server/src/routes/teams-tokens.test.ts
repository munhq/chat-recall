/**
 * Device sync-token lifecycle over /api/teams/:slug/tokens — the API behind
 * the connect-your-machine onboarding:
 *   create team → mint (raw token shown once) → list devices (metadata only,
 *   never hashes) → revoke → list reflects it; membership is enforced on all
 *   three verbs.
 *
 * Uses AUTH_DEV_USER=1 + x-dev-user (the auth middleware's dev escape hatch)
 * so no Keycloak is needed; isolated CHAT_RECALL_DATA_DIR.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let prevDataDir: string | undefined;
let prevDevUser: string | undefined;

beforeAll(() => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  prevDevUser = process.env.AUTH_DEV_USER;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-tokens-test-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  process.env.AUTH_DEV_USER = '1';
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  if (prevDevUser === undefined) delete process.env.AUTH_DEV_USER;
  else process.env.AUTH_DEV_USER = prevDevUser;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('/api/teams/:slug/tokens device lifecycle', () => {
  test('mint → list → revoke → list; non-members 403 everywhere', async () => {
    const teamsRouter = (await import('./teams.js')).default;
    const app = express();
    app.use(express.json());
    app.use('/api', teamsRouter);

    const owner = (r: request.Test) => r.set('x-dev-user', 'alice');
    const stranger = (r: request.Test) => r.set('x-dev-user', 'mallory');

    const created = await owner(request(app).post('/api/teams')).send({ name: 'Tokens Inc' });
    expect(created.status).toBe(200);
    const slug = created.body.slug as string;

    // Mint — the raw token comes back exactly once.
    const mint = await owner(request(app).post(`/api/teams/${slug}/tokens`)).send({ device_id: 'work-laptop' });
    expect(mint.status).toBe(200);
    expect(mint.body.token).toMatch(/^ct_[a-f0-9]{48}$/);
    expect(mint.body.device_id).toBe('work-laptop');

    // List — metadata only: deviceId + createdAt + revoked, never the token.
    const list1 = await owner(request(app).get(`/api/teams/${slug}/tokens`));
    expect(list1.status).toBe(200);
    expect(list1.body.devices).toEqual([
      expect.objectContaining({ deviceId: 'work-laptop', revoked: false }),
    ]);
    expect(JSON.stringify(list1.body)).not.toContain(mint.body.token);
    expect(JSON.stringify(list1.body)).not.toMatch(/hash/i);

    // Revoke → reflected in the list.
    const rev = await owner(request(app).delete(`/api/teams/${slug}/tokens/work-laptop`));
    expect(rev.status).toBe(200);
    const list2 = await owner(request(app).get(`/api/teams/${slug}/tokens`));
    expect(list2.body.devices).toEqual([
      expect.objectContaining({ deviceId: 'work-laptop', revoked: true }),
    ]);

    // Revoking an already-revoked device is a clean 404, not a 500.
    const rev2 = await owner(request(app).delete(`/api/teams/${slug}/tokens/work-laptop`));
    expect(rev2.status).toBe(404);

    // Membership boundary: a stranger can't mint, list, or revoke.
    expect((await stranger(request(app).post(`/api/teams/${slug}/tokens`)).send({ device_id: 'evil' })).status).toBe(403);
    expect((await stranger(request(app).get(`/api/teams/${slug}/tokens`))).status).toBe(403);
    expect((await stranger(request(app).delete(`/api/teams/${slug}/tokens/work-laptop`))).status).toBe(403);
  });
});
