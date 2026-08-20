/**
 * GET /api/licence/for-session and POST /api/licence/resend — how a self-host
 * buyer actually gets their serial.
 *
 * These exist because email was the only delivery channel and the webhook that
 * sends it swallows its own failures, so a bounced message left a paying
 * customer with nothing and no self-service recovery. The tests pin the three
 * properties that make the replacement safe to expose without an account:
 *
 *   1. The Checkout Session id is the ONLY credential, and it is shape-checked
 *      before any Stripe call, so this is not a probe endpoint.
 *   2. A missing licence answers 202 (the webhook may still be in flight), never
 *      404 — the client must wait rather than tell someone their purchase failed.
 *   3. Resend can only ever mail the address already on the subscription. It
 *      never accepts an address from the caller, which would make it an
 *      enumeration oracle and a way to have someone else's serial mailed to you.
 */
import { describe, test, expect, beforeEach, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const ORIG_KEY = process.env.STRIPE_SECRET_KEY;

/** What Stripe and the control plane return, per test. */
const state: {
  session: any;
  licence: any;
  sent: Array<{ to: string; serial: string }>;
  stripeThrows: boolean;
} = { session: null, licence: null, sent: [], stripeThrows: false };

vi.mock('stripe', () => ({
  default: class {
    checkout = {
      sessions: {
        retrieve: async () => {
          if (state.stripeThrows) throw new Error('stripe unreachable');
          return state.session;
        },
      },
    };
    subscriptions = { retrieve: async () => ({ status: 'active' }) };
  },
}));

vi.mock('../imports.js', () => ({
  createControlPlane: async () => ({
    findLicenceBySubscription: async (subId: string) =>
      (state.licence && state.licence.stripeSubscriptionId === subId ? state.licence : null),
    findLicence: async () => null,
    upsertLicence: async () => {},
    recordLicenceInstance: async () => {},
    close: async () => {},
  }),
}));

vi.mock('../auth/mailer.js', () => ({
  sendMail: async (mail: { to: string; subject: string; text?: string }) => {
    state.sent.push({ to: mail.to, serial: mail.text || '' });
  },
  licenceSerialMail: (to: string, serial: string) => ({ to, subject: 'licence', text: serial }),
}));

async function makeApp(): Promise<Express> {
  const { default: router } = await import('./licence.js');
  const app = express();
  app.use('/api/licence', router);
  return app;
}

const GOOD_SESSION = 'cs_test_a1b2c3d4e5f6g7h8i9j0';

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  state.session = { id: GOOD_SESSION, subscription: 'sub_123', metadata: { plan: 'selfhost-team-monthly' } };
  state.licence = {
    serial: 'CR1S-8H2K-4QM7-XT91', seats: 3, email: 'buyer@example.com',
    features: 'team,toolkit', status: 'active', stripeSubscriptionId: 'sub_123',
  };
  state.sent = [];
  state.stripeThrows = false;
});
afterAll(() => { process.env.STRIPE_SECRET_KEY = ORIG_KEY; });

describe('GET /api/licence/for-session', () => {
  test('hands back the serial for the session that bought it', async () => {
    const res = await request(await makeApp()).get(`/api/licence/for-session?session_id=${GOOD_SESSION}`);
    expect(res.status).toBe(200);
    expect(res.body.serial).toBe('CR1S-8H2K-4QM7-XT91');
    expect(res.body.seats).toBe(3);
    // Echoed so the buyer can see WHERE the copy went — a different email at
    // checkout is the commonest reason a serial appears to be missing.
    expect(res.body.email).toBe('buyer@example.com');
    expect(res.body.features).toEqual(['team', 'toolkit']);
  });

  test('rejects anything that is not a checkout session id, without calling Stripe', async () => {
    const app = await makeApp();
    for (const bad of ['', 'sub_123', 'cs_', '../../etc/passwd', 'cs_' + 'x'.repeat(400)]) {
      const res = await request(app).get(`/api/licence/for-session?session_id=${encodeURIComponent(bad)}`);
      expect(res.status, `for ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  test('answers 202 while the webhook is still in flight, not 404', async () => {
    // Payment done, serial not yet issued. The client must wait and retry; a 404
    // here would tell a paying customer their purchase went nowhere.
    state.licence = null;
    const res = await request(await makeApp()).get(`/api/licence/for-session?session_id=${GOOD_SESSION}`);
    expect(res.status).toBe(202);
    expect(res.body.pending).toBe(true);
  });

  test('404s a purchase that bought no subscription', async () => {
    state.session = { id: GOOD_SESSION, subscription: null };
    const res = await request(await makeApp()).get(`/api/licence/for-session?session_id=${GOOD_SESSION}`);
    expect(res.status).toBe(404);
  });

  test('503s when billing is not configured, so a client retries instead of despairing', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await request(await makeApp()).get(`/api/licence/for-session?session_id=${GOOD_SESSION}`);
    expect(res.status).toBe(503);
  });

  test('502s when Stripe is unreachable and leaks nothing', async () => {
    state.stripeThrows = true;
    const res = await request(await makeApp()).get(`/api/licence/for-session?session_id=${GOOD_SESSION}`);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toMatch(/stripe unreachable/);
  });
});

describe('POST /api/licence/resend', () => {
  test('mails the address on the subscription', async () => {
    const res = await request(await makeApp())
      .post('/api/licence/resend').send({ session_id: GOOD_SESSION });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('buyer@example.com');
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].to).toBe('buyer@example.com');
    expect(state.sent[0].serial).toContain('CR1S-8H2K-4QM7-XT91');
  });

  test('ignores an address supplied by the caller — never mails a third party', async () => {
    const res = await request(await makeApp())
      .post('/api/licence/resend')
      .send({ session_id: GOOD_SESSION, email: 'attacker@evil.test' });
    expect(res.status).toBe(200);
    expect(state.sent[0].to).toBe('buyer@example.com');
    expect(state.sent.some((m) => m.to === 'attacker@evil.test')).toBe(false);
  });

  test('requires a well-formed session id', async () => {
    const res = await request(await makeApp())
      .post('/api/licence/resend').send({ session_id: 'nope' });
    expect(res.status).toBe(400);
    expect(state.sent).toHaveLength(0);
  });

  test('409s when the purchase carries no address anywhere', async () => {
    state.licence = { ...state.licence, email: null };
    state.session = { id: GOOD_SESSION, subscription: 'sub_123', customer_details: {}, customer_email: null };
    const res = await request(await makeApp())
      .post('/api/licence/resend').send({ session_id: GOOD_SESSION });
    expect(res.status).toBe(409);
    expect(state.sent).toHaveLength(0);
  });

  test('falls back to the email Stripe holds when the licence row has none', async () => {
    state.licence = { ...state.licence, email: null };
    state.session = {
      id: GOOD_SESSION, subscription: 'sub_123',
      customer_details: { email: 'from-stripe@example.com' },
    };
    const res = await request(await makeApp())
      .post('/api/licence/resend').send({ session_id: GOOD_SESSION });
    expect(res.status).toBe(200);
    expect(state.sent[0].to).toBe('from-stripe@example.com');
  });

  test('reports a send failure rather than swallowing it like the webhook does', async () => {
    state.stripeThrows = true;
    const res = await request(await makeApp())
      .post('/api/licence/resend').send({ session_id: GOOD_SESSION });
    expect(res.status).toBe(502);
  });
});
