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

  test('AUTH_PROVIDER is the multi-user gate: better-auth refuses to start unlicensed', async () => {
    // Multi-user needs distinct identities, identities need real auth, so the
    // provider is the boundary. This replaced a ceiling that counted rows in the
    // user table — which never fired on AUTH_PROVIDER=none, the exact configuration
    // the free tier ships with.
    const { validateAuthConfig } = await import('../middleware/auth.js');
    const prevProvider = process.env.AUTH_PROVIDER;
    const prevSecret = process.env.BETTER_AUTH_SECRET;
    try {
      process.env.AUTH_PROVIDER = 'better-auth';
      process.env.BETTER_AUTH_SECRET = 'x';   // so we fail on the licence, not the secret
      expect(() => validateAuthConfig()).toThrow(/licence including 'team'/);

      process.env.AUTH_PROVIDER = 'keycloak';
      expect(() => validateAuthConfig()).toThrow(/licence including 'sso'/);

      // The free configurations must start cleanly.
      process.env.AUTH_PROVIDER = 'none';
      expect(() => validateAuthConfig()).not.toThrow();
      process.env.AUTH_PROVIDER = 'static-token';
      expect(() => validateAuthConfig()).not.toThrow();
    } finally {
      if (prevProvider === undefined) delete process.env.AUTH_PROVIDER;
      else process.env.AUTH_PROVIDER = prevProvider;
      if (prevSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = prevSecret;
    }
  });

  test('CLOUD edition is exempt — the SaaS runs better-auth for every tenant', async () => {
    const { validateAuthConfig } = await import('../middleware/auth.js');
    const prev = { p: process.env.AUTH_PROVIDER, s: process.env.BETTER_AUTH_SECRET, e: process.env.CHAT_RECALL_EDITION };
    try {
      process.env.AUTH_PROVIDER = 'better-auth';
      process.env.BETTER_AUTH_SECRET = 'x';
      process.env.CHAT_RECALL_EDITION = 'cloud';
      expect(() => validateAuthConfig()).not.toThrow();
    } finally {
      for (const [k, v] of [['AUTH_PROVIDER', prev.p], ['BETTER_AUTH_SECRET', prev.s], ['CHAT_RECALL_EDITION', prev.e]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  test('a LICENCE unlocks better-auth on self-host — the point of option 1', async () => {
    // The former edition check refused better-auth off-cloud unconditionally, so a
    // paying self-hoster had no way to run per-person accounts at all. A signed
    // licence naming 'team' now permits it.
    const { validateAuthConfig } = await import('../middleware/auth.js');
    const { _resetLicenseForTests } = await import('../util/license.js');
    const { generateKeyPairSync, sign } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const b64url = (b: Buffer | string) =>
      Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const seg = b64url(JSON.stringify({
      holder: 'ACME', features: ['team'], iat: Math.floor(Date.now() / 1000),
    }));
    const key = `CR1.${seg}.${b64url(sign(null, Buffer.from(seg, 'utf8'), privateKey))}`;

    const prev = {
      p: process.env.AUTH_PROVIDER, s: process.env.BETTER_AUTH_SECRET,
      l: process.env.CHAT_RECALL_LICENSE, k: process.env.CHAT_RECALL_LICENSE_PUBKEY,
    };
    try {
      process.env.AUTH_PROVIDER = 'better-auth';
      process.env.BETTER_AUTH_SECRET = 'x';
      process.env.CHAT_RECALL_LICENSE_PUBKEY =
        publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      process.env.CHAT_RECALL_LICENSE = key;
      _resetLicenseForTests();
      expect(() => validateAuthConfig()).not.toThrow();
    } finally {
      for (const [k, v] of [['AUTH_PROVIDER', prev.p], ['BETTER_AUTH_SECRET', prev.s],
                            ['CHAT_RECALL_LICENSE', prev.l], ['CHAT_RECALL_LICENSE_PUBKEY', prev.k]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      _resetLicenseForTests();
    }
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

  test('the mount gate refuses unlicensed — this is what guards /api/tasks, /api/shares, /api/activity', async () => {
    // Those three carry the gate at their mount in server.ts rather than inside
    // the router, so the middleware is the honest unit to assert here.
    const { requireFeature } = await import('../util/billing.js');
    const probe = express();
    probe.use((req, _res, nx) => { (req as any).tenant = 'solo-co'; nx(); });
    probe.use('/gated', requireFeature('team'), (_req, res) => res.json({ reached: true }));
    const r = await request(probe).get('/gated');
    expect(r.status).toBe(402);
    expect(r.body.reached).toBeUndefined();
    expect(r.body.feature).toBe('team');
    expect(r.body.upgradeUrl).toMatch(/^https?:\/\//);
  });

  test('CLOUD: a TRIALING tenant with no plan is refused team — the leak this closes', async () => {
    // The regression that shipped: requireTeamFeature opened with
    // `if (billingEnabled()) return next()`, so on cloud it passed everything and
    // the only real check was requireEntitlement — which a trial passes. A trialing
    // tenant therefore reached the team board, shares and per-member activity.
    const { requireFeature, clearEntitlementCache } = await import('../util/billing.js');
    const { createControlPlane } = await import('../imports.js');
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';       // cloud
    clearEntitlementCache();
    const cp = await createControlPlane();
    try {
      await cp.setEntitlement('trial-co', { status: 'trialing', plan: null, currentPeriodEnd: Date.now() + 86_400_000 });
    } finally { await cp.close(); }

    const probe = express();
    probe.use((req, _res, nx) => { (req as any).tenant = 'trial-co'; nx(); });
    probe.use('/gated', requireFeature('team'), (_req, res) => res.json({ reached: true }));
    const r = await request(probe).get('/gated');
    expect(r.status).toBe(402);
    expect(r.body.reached).toBeUndefined();

    // And a real Team plan is admitted, so the gate is not simply closed.
    clearEntitlementCache();
    const cp2 = await createControlPlane();
    try {
      await cp2.setEntitlement('team-co', { status: 'active', plan: 'team-monthly', currentPeriodEnd: Date.now() + 86_400_000 });
    } finally { await cp2.close(); }
    const probe2 = express();
    probe2.use((req, _res, nx) => { (req as any).tenant = 'team-co'; nx(); });
    probe2.use('/gated', requireFeature('team'), (_req, res) => res.json({ reached: true }));
    expect((await request(probe2).get('/gated')).body.reached).toBe(true);

    delete process.env.STRIPE_SECRET_KEY;
    clearEntitlementCache();
  });
});
