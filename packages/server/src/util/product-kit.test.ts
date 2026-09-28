/**
 * The seam: every call works with the kit and without it.
 *
 * Without the kit (the public self-host image) growth is a no-op and mail says
 * it cannot send. With it, both delegate, and the mailer fills in this server's
 * default sender and maps the kit's result onto the reasons its callers read.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { __setProductKit } from './product-kit.js';
import { growth, recordMailSent, growthEnabled } from './growth.js';
import { sendMail } from '../auth/mailer.js';

afterEach(() => { __setProductKit(null); delete process.env.SMTP_HOST; vi.restoreAllMocks(); });

function fakeKit(result: { sent: true; messageId: string | null } | { sent: false; reason: string }) {
  const calls: Array<[string, unknown[]]> = [];
  const kit = {
    growth: (...a: unknown[]) => { calls.push(['growth', a]); },
    recordMailSent: (...a: unknown[]) => { calls.push(['recordMailSent', a]); },
    growthEnabled: () => true,
    closeGrowth: async () => {},
    sendMail: async (...a: unknown[]) => { calls.push(['sendMail', a]); return result; },
  };
  __setProductKit(kit as never);
  return calls;
}

describe('without the kit', () => {
  test('growth does nothing, and says measurement is off', () => {
    __setProductKit(null);
    expect(() => growth('install', { tenant: 't' })).not.toThrow();
    expect(() => recordMailSent({ kind: 'k', recipient: 'a@example.com' })).not.toThrow();
    expect(growthEnabled()).toBe(false);
  });
});

describe('with the kit', () => {
  test('growth delegates', () => {
    const calls = fakeKit({ sent: true, messageId: null });
    growth('activate', { tenant: 't', oncePerDay: true });
    expect(calls).toEqual([['growth', ['activate', { tenant: 't', oncePerDay: true }]]]);
  });

  test('sendMail passes the default sender and the tenant, and maps the result', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    const calls = fakeKit({ sent: true, messageId: 'm-1' });
    const r = await sendMail({ to: 'a@example.com', subject: 's', text: 't', kind: 'trial.setup.final' }, { tenant: 'ada-1' });
    expect(r).toEqual({ sent: true });
    const [, [mail, meta]] = calls[0] as [string, [{ from: string; kind: string }, unknown]];
    expect(mail.from).toContain('noreply@chatrecall.dev');
    expect(mail.kind).toBe('trial.setup.final');
    expect(meta).toEqual({ tenant: 'ada-1' });
  });

  test('a refused send is send-failed, which the reminder sweep retries', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    fakeKit({ sent: false, reason: 'send-failed' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendMail({ to: 'a@example.com', subject: 's', text: 't' })).toEqual({ sent: false, reason: 'send-failed' });
  });
});
