/**
 * The mailer must never throw, and must never silently swallow a reset link.
 *
 * Both halves are load-bearing. A throw inside sendResetPassword propagates
 * into better-auth's /forget-password handler, which turns "we could not send
 * mail" into a visible error for a user who cannot act on it — and worse, it
 * only errors for addresses that HAVE an account, which converts the endpoint
 * into an account-enumeration oracle. Silently dropping is the opposite
 * failure: a self-host install with no SMTP would look identical to a working
 * one while every reset vanished, leaving accounts permanently unrecoverable.
 *
 * So the contract is: log the message, report sent:false, and never raise.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendMail, mailerConfigured, resetPasswordMail } from './mailer.js';

const saved: Record<string, string | undefined> = {};
const ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'MAIL_FROM'];

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  vi.restoreAllMocks();
});

describe('mailerConfigured', () => {
  test('is false with no SMTP_HOST, true with one', () => {
    expect(mailerConfigured()).toBe(false);
    process.env.SMTP_HOST = 'smtp.example.com';
    expect(mailerConfigured()).toBe(true);
  });
});

describe('unconfigured — the self-host path', () => {
  test('logs the message instead of sending, and does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await sendMail({ to: 'ada@example.com', subject: 'Reset', text: 'link: https://x/reset/TOK' });

    expect(r).toEqual({ sent: false, reason: 'no-smtp' });
    expect(warn).toHaveBeenCalledOnce();
    const logged = warn.mock.calls[0][0] as string;
    // The operator recovers the account from this log line, so the address and
    // the link itself both have to survive into it.
    expect(logged).toContain('ada@example.com');
    expect(logged).toContain('https://x/reset/TOK');
  });
});

describe('configured but failing', () => {
  test('a transport error is swallowed, not raised', async () => {
    process.env.SMTP_HOST = '127.0.0.1';
    // Port 1 is reserved and nothing listens there, so this is a real failure
    // rather than a mocked one — it exercises the catch, not a stub of it.
    process.env.SMTP_PORT = '1';
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await sendMail({ to: 'ada@example.com', subject: 'Reset', text: 'body' });
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('send-failed');
  }, 30_000);
});

describe('resetPasswordMail', () => {
  test('carries the link and states the expiry in minutes', () => {
    const m = resetPasswordMail('ada@example.com', 'https://chatrecall.dev/api/auth/reset-password/TOK', 60);
    expect(m.to).toBe('ada@example.com');
    expect(m.subject).toMatch(/reset/i);
    expect(m.text).toContain('https://chatrecall.dev/api/auth/reset-password/TOK');
    expect(m.text).toContain('60 minutes');
    // "ignore this message" is the instruction for someone who did not ask —
    // without it the mail reads as a breach notification.
    expect(m.text).toMatch(/ignore/i);
  });

  test('says the link is single use, so a shared link is not a standing key', () => {
    const m = resetPasswordMail('ada@example.com', 'https://x/y', 60);
    expect(m.text).toMatch(/once/i);
  });
});
