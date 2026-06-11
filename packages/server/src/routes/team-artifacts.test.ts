/**
 * Team toolkit round-trip against the team-client.ts contract:
 * create team → publish → list → pull (since=0 and since=now) →
 * version bump on re-publish → revoke shows up in `removed`.
 * Membership boundaries: a non-member 403s; hook publish is owner-only.
 *
 * Uses AUTH_DEV_USER=1 + x-dev-user (the auth middleware's dev escape
 * hatch) so no Keycloak is needed; isolated CHAT_RECALL_DATA_DIR.
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
  dataDir = mkdtempSync(join(tmpdir(), 'cr-team-test-'));
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

describe('/api/team toolkit library', () => {
  test('publish → list → pull → version bump → revoke; membership enforced', async () => {
    const teamArtifactsRouter = (await import('./team-artifacts.js')).default;
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/team', teamArtifactsRouter);

    const owner = (r: request.Test) => r.set('x-dev-user', 'alice');
    const stranger = (r: request.Test) => r.set('x-dev-user', 'mallory');

    // Create a team as alice.
    const created = await owner(request(app).post('/api/team')).send({ name: 'Acme' });
    expect(created.status).toBe(200);
    const teamId = created.body.team.id as string;
    expect(teamId).toMatch(/^acme-/);

    // /me reflects the membership in the client's shape.
    const me = await owner(request(app).get('/api/team/me'));
    expect(me.body.memberships).toEqual([
      expect.objectContaining({ teamId, role: 'owner', plan: 'team' }),
    ]);

    // Publish a skill.
    const body = Buffer.from('# Deploy checklist\n1. test\n2. ship\n').toString('base64');
    const pub = await owner(request(app).post(`/api/team/${teamId}/publish`))
      .send({ type: 'skill', tool: 'cross_tool', name: 'deploy-checklist', bodyB64: body });
    expect(pub.status).toBe(200);
    expect(pub.body.artifact.version).toBe(1);
    const artifactId = pub.body.artifact.id as string;

    // Non-member can't list or publish.
    expect((await stranger(request(app).get(`/api/team/${teamId}/list`))).status).toBe(403);
    expect((await stranger(request(app).post(`/api/team/${teamId}/publish`))
      .send({ type: 'skill', tool: 'claude', name: 'x', bodyB64: body })).status).toBe(403);

    // List + full pull return it.
    const list = await owner(request(app).get(`/api/team/${teamId}/list`));
    expect(list.body.artifacts).toHaveLength(1);
    const pull = await owner(request(app).get(`/api/team/${teamId}/pull?since=0`));
    expect(pull.body.pulled).toHaveLength(1);
    expect(pull.body.pulled[0].bodyB64).toBe(body);
    expect(typeof pull.body.serverNow).toBe('number');

    // Incremental pull after serverNow → empty.
    const pull2 = await owner(request(app).get(`/api/team/${teamId}/pull?since=${pull.body.serverNow}`));
    expect(pull2.body.pulled).toHaveLength(0);
    expect(pull2.body.removed).toHaveLength(0);

    // Re-publish bumps the version, same id.
    const pub2 = await owner(request(app).post(`/api/team/${teamId}/publish`))
      .send({ type: 'skill', tool: 'cross_tool', name: 'deploy-checklist', bodyB64: body });
    expect(pub2.body.artifact.version).toBe(2);
    expect(pub2.body.artifact.id).toBe(artifactId);

    // Member (joined via invite) can publish commands but NOT hooks.
    const invite = await owner(request(app).post(`/api/team/${teamId}/invite`)).send({});
    expect(invite.body.inviteToken).toMatch(/^inv_/);
    const joined = await request(app).post('/api/team/join')
      .set('x-dev-user', 'bob').send({ inviteToken: invite.body.inviteToken });
    expect(joined.body.team.id).toBe(teamId);
    const bobHook = await request(app).post(`/api/team/${teamId}/publish`)
      .set('x-dev-user', 'bob')
      .send({ type: 'hook', tool: 'claude', name: 'pre-push', bodyB64: body });
    expect(bobHook.status).toBe(403);
    const bobCmd = await request(app).post(`/api/team/${teamId}/publish`)
      .set('x-dev-user', 'bob')
      .send({ type: 'command', tool: 'claude', name: 'release', bodyB64: body });
    expect(bobCmd.status).toBe(200);

    // Revoke (owner-only) and see it in the next incremental pull.
    const sinceBeforeRevoke = Date.now() - 1;
    expect((await request(app).delete(`/api/team/${teamId}/artifacts/${artifactId}`)
      .set('x-dev-user', 'bob')).status).toBe(403);
    const rev = await owner(request(app).delete(`/api/team/${teamId}/artifacts/${artifactId}`));
    expect(rev.body.revoked.id).toBe(artifactId);
    const pull3 = await owner(request(app).get(`/api/team/${teamId}/pull?since=${sinceBeforeRevoke}`));
    expect(pull3.body.removed).toContain(artifactId);
    const list2 = await owner(request(app).get(`/api/team/${teamId}/list`));
    expect(list2.body.artifacts.map((a: any) => a.id)).not.toContain(artifactId);
  });
});
