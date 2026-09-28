/**
 * The funnel's address, end to end through a real better-auth instance.
 *
 * funnel.test.ts proves the middleware keeps what `noteAttemptedEmail` hands it.
 * This proves the hand-off itself: better-auth builds its own Fetch Request from
 * the Node one, so the only link between its after-hook and the middleware's
 * `finish` listener is the async context. If a better-auth upgrade ran the hooks
 * outside that context, every failure would lose its address again, and only a
 * test that runs the real handler would notice.
 *
 * The instance uses the memory adapter so the suite needs no Postgres. The hook
 * is the one the product registers.
 */
import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Server } from 'node:http';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { toNodeHandler } from 'better-auth/node';
import { bearer, deviceAuthorization, emailOTP } from 'better-auth/plugins';

const sent = vi.hoisted(() => ({ calls: [] as Array<{ event: string; props: { extra: Record<string, unknown> } }> }));
vi.mock('../util/growth.js', () => ({
  growth: (event: string, props: { extra: Record<string, unknown> }) => { sent.calls.push({ event, props }); },
}));

const { funnelTelemetry } = await import('./funnel.js');
const { funnelAfterHook } = await import('../auth/better-auth.js');

const ORIGIN = 'http://127.0.0.1';
const auth = betterAuth({
  baseURL: ORIGIN,
  basePath: '/api/auth',
  secret: 'funnel-auth-test-secret-with-enough-length-0123456789',
  database: memoryAdapter({ user: [], session: [], account: [], verification: [], deviceCode: [] }),
  emailAndPassword: { enabled: true },
  hooks: { after: funnelAfterHook },
  plugins: [
    bearer(),
    emailOTP({ sendVerificationOTP: async () => {} }),
    deviceAuthorization({ verificationUri: '/device' }),
  ],
  logger: { disabled: true },
});

const app = express();
app.all('/api/auth/*', funnelTelemetry, toNodeHandler(auth));
let server: Server;
let token = '';

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return request(server).post(`/api/auth${path}`).set('origin', ORIGIN).set(headers).send(body as object);
}

/** The event the middleware emitted for the one request just made. */
function only() {
  expect(sent.calls).toHaveLength(1);
  return sent.calls[0]!;
}

beforeAll(async () => {
  server = app.listen(0);
  const res = await post('/sign-up/email', { email: 'member@example.com', password: 'correct-horse-9', name: 'M' });
  expect(res.status).toBe(200);
  token = String(res.headers['set-auth-token'] ?? '');
  expect(token).not.toBe('');
});

afterAll(() => { server.close(); });

beforeEach(() => { sent.calls = []; });

describe('a failed auth step names the address it was about', () => {
  test('a wrong password on an existing account', async () => {
    const res = await post('/sign-in/email', { email: 'Member@Example.com', password: 'wrong-password-1' });
    expect(res.status).toBe(401);
    const e = only();
    expect(e.event).toBe('funnel_fail');
    expect(e.props.extra).toEqual({ step: 'signin', status: 401, email: 'member@example.com' });
    expect(JSON.stringify(e)).not.toContain('wrong-password-1');
  });

  test('a sign-in for an address with no account', async () => {
    await post('/sign-in/email', { email: 'nobody@example.com', password: 'wrong-password-1' });
    expect(only().props.extra.email).toBe('nobody@example.com');
  });

  test('a sign-up for an address that already has an account', async () => {
    const res = await post('/sign-up/email', { email: 'member@example.com', password: 'correct-horse-9', name: 'M' });
    expect(res.status).toBe(422);
    expect(only().props.extra).toMatchObject({ step: 'signup', status: 422, email: 'member@example.com' });
  });

  test('a wrong verification code, without the code', async () => {
    const res = await post('/email-otp/verify-email', { email: 'member@example.com', otp: '918273' });
    expect(res.status).toBe(400);
    const e = only();
    expect(e.props.extra.email).toBe('member@example.com');
    expect(JSON.stringify(e)).not.toContain('918273');
  });

  test('a refused CLI approval takes the address of the signed-in account', async () => {
    const res = await post('/device/approve', { userCode: 'NOPE-NOPE' }, { authorization: `Bearer ${token}` });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(only().props.extra).toMatchObject({ step: 'cli_login_approved', email: 'member@example.com' });
  });
});

describe('a success names nobody', () => {
  test('a correct sign-in carries only the step and the status', async () => {
    const res = await post('/sign-in/email', { email: 'member@example.com', password: 'correct-horse-9' });
    expect(res.status).toBe(200);
    const e = only();
    expect(e.event).toBe('funnel');
    expect(e.props.extra).toEqual({ step: 'signin', status: 200 });
  });
});
