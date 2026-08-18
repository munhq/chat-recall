/**
 * The commercial boundary: on self-host WITHOUT a team licence, a second member
 * cannot be invited.
 *
 * This is the test that matters. team-artifacts.test.ts mints itself a licence so
 * it can exercise multi-member behaviour, which means it would keep passing even
 * if the gate were deleted. This file asserts the refusal.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { _resetLicenseForTests } from '../util/license.js';

let prev: Record<string, string | undefined> = {};
let app: express.Express;

beforeAll(async () => {
  for (const k of ['CHAT_RECALL_DATA_DIR', 'AUTH_DEV_USER', 'CHAT_RECALL_LICENSE', 'STRIPE_SECRET_KEY']) {
    prev[k] = process.env[k];
  }
  process.env.CHAT_RECALL_DATA_DIR = mkdtempSync(join(tmpdir(), 'cr-lic-'));
  process.env.AUTH_DEV_USER = '1';
  // Self-host, unlicensed: no Stripe key (so billingEnabled() is false) and no
  // CHAT_RECALL_LICENSE. This is the default state of every free install.
  delete process.env.CHAT_RECALL_LICENSE;
  delete process.env.STRIPE_SECRET_KEY;
  _resetLicenseForTests();
  // Mount only the routers under test, the way team-artifacts.test.ts does —
  // importing server.js would boot the whole app (and its DB pool).
  const teamArtifactsRouter = (await import('./team-artifacts.js')).default;
  const teamsRouter = (await import('./teams.js')).default;
  app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/team', teamArtifactsRouter);
  app.use('/api', teamsRouter);
});

afterAll(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  _resetLicenseForTests();
});

const asUser = (r: request.Test) => r.set('x-dev-user', 'alice');

describe('team licence gate (self-host, unlicensed)', () => {
  let slug = '';

  test('a team can still be created — solo self-hosting is free', async () => {
    const r = await asUser(request(app).post('/api/teams')).send({ name: 'Solo Co' });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('owner');
    slug = r.body.slug;
  });

  test('inviting a second member is refused with 402 and a buying hint', async () => {
    // Owner of a real team, so the 403 ownership check passes and the licence
    // gate is what answers.
    const r = await asUser(request(app).post(`/api/team/${slug}/invite`)).send({});
    expect(r.status).toBe(402);
    expect(r.body.error).toMatch(/licence/i);
    expect(r.body.hint).toMatch(/free and unlimited/i);
    // No token must leak out alongside the refusal.
    expect(r.body.inviteToken).toBeUndefined();
  });

  test('requireTeamFeature itself refuses, which is what guards /api/tasks, /api/shares and /api/activity', async () => {
    // Those three carry the gate at their mount in server.ts rather than inside
    // the router, so the middleware is the honest unit to assert here.
    const { requireTeamFeature } = await import('../util/billing.js');
    const probe = express();
    probe.use('/gated', requireTeamFeature, (_req, res) => res.json({ reached: true }));
    const r = await request(probe).get('/gated');
    expect(r.status).toBe(402);
    expect(r.body.reached).toBeUndefined();
  });
});
