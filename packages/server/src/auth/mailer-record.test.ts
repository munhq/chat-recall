/**
 * Every mail that leaves is recorded with its kind and the id SES gave it.
 *
 * SES keeps no per-message history. Before this, a verification code or a trial
 * reminder left no trace anywhere except the recipient's inbox, and a question
 * like "did we ever write to this person" had no answer. The record is also the
 * join key: SES publishes delivery and bounce events keyed on the same id.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const recorded = vi.hoisted(() => ({ calls: [] as unknown[] }));
const smtp = vi.hoisted(() => ({ response: '', fail: false }));

vi.mock('../util/growth.js', () => ({
  recordMailSent: (m: unknown) => { recorded.calls.push(m); },
}));
vi.mock('nodemailer', () => {
  const createTransport = () => ({
    sendMail: async () => {
      if (smtp.fail) throw new Error('421 try later');
      return { response: smtp.response };
    },
  });
  return { createTransport, default: { createTransport } };
});

const ORIG = { ...process.env };
beforeEach(() => {
  recorded.calls = [];
  smtp.fail = false;
  smtp.response = '250 Ok 0107019a1b2c3d4e-5f60a1b2-c3d4-4e5f-a6b7-c8d9e0f1a2b3-000000';
  process.env.SMTP_HOST = 'smtp.example.com';
});
afterEach(() => { process.env = { ...ORIG }; });

const { sendMail, sesMessageId } = await import('./mailer.js');

describe('sesMessageId', () => {
  test('reads the id from the reply SES gives to DATA', () => {
    expect(sesMessageId('250 Ok 0107019a1b2c3d4e-5f60a1b2-c3d4-4e5f-a6b7-c8d9e0f1a2b3-000000'))
      .toBe('0107019a1b2c3d4e-5f60a1b2-c3d4-4e5f-a6b7-c8d9e0f1a2b3-000000');
  });

  test('is null for any other server, and for nothing', () => {
    expect(sesMessageId('250 2.0.0 Ok: queued as 4F3A2B1C0D')).toBeNull();
    expect(sesMessageId('')).toBeNull();
    expect(sesMessageId(undefined)).toBeNull();
  });
});

describe('sendMail records what it sent', () => {
  test('the kind, the recipient, the tenant and the SES id', async () => {
    const r = await sendMail(
      { to: 'Ada@Example.com', subject: 'Your trial', text: 'body', kind: 'trial.setup.final' },
      { tenant: 'ada-1a2b3c' },
    );
    expect(r.sent).toBe(true);
    expect(recorded.calls).toEqual([{
      kind: 'trial.setup.final',
      recipient: 'Ada@Example.com',
      tenant: 'ada-1a2b3c',
      messageId: '0107019a1b2c3d4e-5f60a1b2-c3d4-4e5f-a6b7-c8d9e0f1a2b3-000000',
    }]);
  });

  test('a mail with no kind is still recorded, under a name that says so', async () => {
    await sendMail({ to: 'ada@example.com', subject: 's', text: 't' });
    expect(recorded.calls).toEqual([expect.objectContaining({ kind: 'unnamed', tenant: null })]);
  });

  test('a mail the server refused is not recorded as sent', async () => {
    smtp.fail = true;
    const r = await sendMail({ to: 'ada@example.com', subject: 's', text: 't', kind: 'auth.otp.verify' });
    expect(r).toEqual({ sent: false, reason: 'send-failed' });
    expect(recorded.calls).toEqual([]);
  });
});
