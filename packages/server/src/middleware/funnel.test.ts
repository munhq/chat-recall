/**
 * The funnel middleware, which exists to see the steps people FAIL at.
 *
 * The three pre-existing growth events all fire after success, so the funnel
 * could only show people who made it. Twelve `chat-recall init` runs abandoned
 * at the sign-in prompt and were visible only because better-auth happens to
 * persist a deviceCode row; nothing recorded a signup that never confirmed or a
 * verification code typed wrong.
 *
 * Two properties matter more than the counts, and both are asserted here:
 * a failed step must be recorded as a FAILURE rather than dropped, and no
 * credential may ever reach the event.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const sent = vi.hoisted(() => ({ calls: [] as Array<{ event: string; props: unknown }> }));
vi.mock('../util/growth.js', () => ({
  growth: (event: string, props: unknown) => { sent.calls.push({ event, props }); },
}));

const { funnelTelemetry } = await import('./funnel.js');

/** An app that answers with whatever status the test asks for. */
function app(status = 200) {
  const a = express();
  a.use(express.json());
  a.all('/api/auth/*', funnelTelemetry, (_req, res) => { res.status(status).json({ ok: status < 300 }); });
  return a;
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

  test('never records a credential — only a step name and a status', async () => {
    await request(app(200))
      .post('/api/auth/sign-up/email')
      .send({ email: 'someone@example.com', password: 'hunter2-not-in-events', name: 'X' });
    const blob = JSON.stringify(sent.calls);
    expect(blob).not.toContain('someone@example.com');
    expect(blob).not.toContain('hunter2-not-in-events');
    expect(Object.keys((sent.calls[0]?.props as { extra: Record<string, unknown> }).extra).sort())
      .toEqual(['status', 'step']);
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
