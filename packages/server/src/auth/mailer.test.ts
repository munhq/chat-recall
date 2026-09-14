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
import { sendMail, mailerConfigured } from './mailer.js';

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

/*
 * The copy assertions that stood here moved out with the words.
 *
 * They checked that the reset mail carries the link, states the expiry, says
 * the link works once, and tells an unexpecting recipient to ignore it. Those
 * are claims about wording, and the wording is now in a pack outside this
 * repository — so a test here could only assert that a builder returns null.
 * The pack is checked where it lives; the renderer is checked in
 * @munhq/mailkit. See auth/mail-kit.test.ts for what this repository still owes.
 */
