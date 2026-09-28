/**
 * The funnel middleware, which exists to see the steps people FAIL at.
 *
 * The three pre-existing growth events all fire after success, so the funnel
 * could only show people who made it. Twelve `chat-recall init` runs abandoned
 * at the sign-in prompt and were visible only because better-auth happens to
 * persist a deviceCode row; nothing recorded a signup that never confirmed or a
 * verification code typed wrong.
 *
 * Three properties matter more than the counts, and all are asserted here:
 * a failed step is recorded as a failure, a failure names the address it was
 * about, and no password, code or token ever reaches the event.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const sent = vi.hoisted(() => ({ calls: [] as Array<{ event: string; props: unknown }> }));
vi.mock('../util/growth.js', () => ({
  growth: (event: string, props: unknown) => { sent.calls.push({ event, props }); },
}));

const { funnelTelemetry, noteAttemptedEmail } = await import('./funnel.js');

/** An app that answers with whatever status the test asks for. */
function app(status = 200) {
  const a = express();
  a.use(express.json());
  a.all('/api/auth/*', funnelTelemetry, (_req, res) => { res.status(status).json({ ok: status < 300 }); });
  return a;
}

/** An app whose handler reports an address the way better-auth's after-hook does. */
function appNoting(status: number, ...candidates: unknown[]) {
  const a = express();
  a.use(express.json());
  a.all('/api/auth/*', funnelTelemetry, (_req, res) => {
    noteAttemptedEmail(...candidates);
    res.status(status).json({ ok: status < 300 });
  });
  return a;
}

function extraOf(i = 0): Record<string, unknown> {
  return (sent.calls[i]?.props as { extra: Record<string, unknown> }).extra;
}

beforeEach(() => { sent.calls = []; });

describe('funnel telemetry', () => {
  test('records the steps a user can fail at', async () => {
    const paths: Array<[string, string]> = [
      ['/api/auth/sign-up/email', 'signup'],
      ['/api/auth/email-otp/send-verification-otp', 'verify_code_sent'],
      ['/api/auth/email-otp/verify-email', 'verify_code_entered'],
      ['/api/auth/device/code', 'cli_login_prompt'],
      ['/api/auth/device/approve', 'cli_login_approved'],
      ['/api/auth/mcp/register', 'connector_registered'],
    ];
    for (const [path, step] of paths) {
      sent.calls = [];
      await request(app(200)).post(path).send({});
      expect(sent.calls[0]?.event, path).toBe('funnel');
      expect((sent.calls[0]?.props as { extra: { step: string } }).extra.step, path).toBe(step);
    }
  });

  test('a FAILED step is recorded as a failure, not dropped', async () => {
    // The whole point. A wrong verification code that emitted nothing would
    // leave the same silence this middleware exists to end.
    await request(app(400)).post('/api/auth/email-otp/verify-email').send({});
    expect(sent.calls[0]?.event).toBe('funnel_fail');
    expect((sent.calls[0]?.props as { extra: { status: number } }).extra.status).toBe(400);
  });

  test('a success records only a step name and a status', async () => {
    await request(app(200))
      .post('/api/auth/sign-up/email')
      .send({ email: 'someone@example.com', password: 'hunter2-not-in-events', name: 'X' });
    const blob = JSON.stringify(sent.calls);
    expect(blob).not.toContain('someone@example.com');
    expect(blob).not.toContain('hunter2-not-in-events');
    expect(Object.keys((sent.calls[0]?.props as { extra: Record<string, unknown> }).extra).sort())
      .toEqual(['status', 'step']);
  });

  test('a failure carries the address, and never the password', async () => {
    await request(appNoting(401, ' Someone@Example.com '))
      .post('/api/auth/sign-in/email')
      .send({ email: ' Someone@Example.com ', password: 'hunter2-not-in-events' });
    expect(sent.calls[0]?.event).toBe('funnel_fail');
    expect(extraOf()).toEqual({ step: 'signin', status: 401, email: 'someone@example.com' });
    expect(JSON.stringify(sent.calls)).not.toContain('hunter2-not-in-events');
  });

  test('a success drops the address the hook reported', async () => {
    await request(appNoting(200, 'someone@example.com')).post('/api/auth/sign-in/email').send({});
    expect(Object.keys(extraOf()).sort()).toEqual(['status', 'step']);
  });

  test('the first well-formed address wins, and anything else is dropped', async () => {
    await request(appNoting(400, 'not-an-address', 42, 'session@example.com'))
      .post('/api/auth/device/approve').send({});
    expect(extraOf().email).toBe('session@example.com');

    sent.calls = [];
    await request(appNoting(400, 'not-an-address', `${'a'.repeat(250)}@example.com`))
      .post('/api/auth/sign-up/email').send({});
    expect(extraOf()).not.toHaveProperty('email');
  });

  test('an address noted outside a funnel request goes nowhere', async () => {
    noteAttemptedEmail('stray@example.com');
    await request(app(401)).post('/api/auth/sign-in/email').send({});
    expect(extraOf()).not.toHaveProperty('email');
  });

  test('two concurrent requests keep their own addresses', async () => {
    const a = express();
    a.all('/api/auth/*', funnelTelemetry, async (req, res) => {
      const who = String(req.query.who);
      await new Promise((r) => setTimeout(r, who === 'first' ? 30 : 0));
      noteAttemptedEmail(`${who}@example.com`);
      res.status(401).end();
    });
    await Promise.all([
      request(a).post('/api/auth/sign-in/email?who=first'),
      request(a).post('/api/auth/sign-in/email?who=second'),
    ]);
    expect(sent.calls.map((c) => (c.props as { extra: { email: string } }).extra.email).sort())
      .toEqual(['first@example.com', 'second@example.com']);
  });

  test('ignores auth requests that are not funnel steps', async () => {
    await request(app(200)).get('/api/auth/get-session');
    await request(app(200)).post('/api/auth/sign-out');
    expect(sent.calls).toHaveLength(0);
  });

  test('device/token is not mistaken for device/code by a prefix match', async () => {
    // The poll happens dozens of times per login; counting it as a prompt would
    // make the abandonment rate look far better than it is.
    await request(app(200)).post('/api/auth/device/token').send({});
    expect(sent.calls).toHaveLength(0);
  });

  test('a throw in telemetry can never cost someone their sign-up', async () => {
    const res = await request(app(200)).post('/api/auth/sign-up/email').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
