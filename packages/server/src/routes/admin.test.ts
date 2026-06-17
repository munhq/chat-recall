/**
 * Auth-gating tests for /api/admin (P1-10). The requireAdmin gate runs BEFORE
 * any DB access, so these assert the 401/403 short-circuits deterministically
 * without a Postgres. The "gate opens" cases assert only that auth did NOT block
 * (status is not 401/403) — the DB query behind it isn't exercised here.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import adminRouter from './admin.js';

let app: Express;
const orig = { ADMIN_KEY: process.env.ADMIN_KEY, AUTH_PROVIDER: process.env.AUTH_PROVIDER, AUTH_DEV_USER: process.env.AUTH_DEV_USER };

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
});
afterAll(() => {
  process.env.ADMIN_KEY = orig.ADMIN_KEY;
  process.env.AUTH_PROVIDER = orig.AUTH_PROVIDER;
  process.env.AUTH_DEV_USER = orig.AUTH_DEV_USER;
});
beforeEach(() => {
  delete process.env.ADMIN_KEY;
  delete process.env.AUTH_PROVIDER;
  delete process.env.AUTH_DEV_USER;
});

describe('GET /api/admin/metrics — self-host (ADMIN_KEY) gate', () => {
  test('disabled (fail-closed) when ADMIN_KEY is unset', async () => {
    const res = await request(app).get('/api/admin/metrics');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/disabled/i);
  });

  test('401 when ADMIN_KEY is set but the header is missing or wrong', async () => {
    process.env.ADMIN_KEY = 'sekret';
    expect((await request(app).get('/api/admin/metrics')).status).toBe(401);
    expect((await request(app).get('/api/admin/metrics').set('x-admin-key', 'nope')).status).toBe(401);
  });

  test('correct ADMIN_KEY opens the gate (not blocked by auth)', async () => {
    process.env.ADMIN_KEY = 'sekret';
    const res = await request(app).get('/api/admin/metrics').set('x-admin-key', 'sekret');
    expect([401, 403]).not.toContain(res.status); // auth passed; DB layer may 200/500
  });
});

describe('GET /api/admin/metrics — keycloak (realm role) gate', () => {
  test('401 without a token', async () => {
    process.env.AUTH_PROVIDER = 'keycloak';
    const res = await request(app).get('/api/admin/metrics');
    expect(res.status).toBe(401);
  });

  test('dev escape hatch (x-dev-admin) opens the gate', async () => {
    process.env.AUTH_PROVIDER = 'keycloak';
    process.env.AUTH_DEV_USER = '1';
    const res = await request(app).get('/api/admin/metrics').set('x-dev-admin', '1');
    expect([401, 403]).not.toContain(res.status);
  });
});
