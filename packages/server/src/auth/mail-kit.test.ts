import { describe, test, expect } from 'vitest';
import { sendMail, verifyOtpMail, resetPasswordMail, trialEndingMail, licenceSerialMail } from './mailer.js';

/**
 * What this repository still owes about mail.
 *
 * The renderer and every word it renders moved to @munhq/mailkit, which is an
 * optionalDependency and is absent from a self-host build. The copy is tested
 * there, against a fixture pack. What is left to prove here is the seam: that a
 * build without the package sends nothing, says so, and does not throw.
 *
 * These tests run in exactly that state, because the test run does not install
 * optional dependencies from a private repository either.
 */
describe('a build without the mail package', () => {
  const builders = [
    ['verifyOtpMail', () => verifyOtpMail('a@b.test', '481923', 'email-verification')],
    ['resetPasswordMail', () => resetPasswordMail('a@b.test', 'https://e.test/r', 60)],
    ['trialEndingMail', () => trialEndingMail('a@b.test', new Date('2026-10-01'))],
    ['licenceSerialMail', () => licenceSerialMail('a@b.test', 'CR-TEST-0000', 'year')],
  ] as const;

  test('every builder answers null rather than throwing', async () => {
    for (const [name, build] of builders) {
      await expect(build(), name).resolves.toBeNull();
    }
  });

  test('sendMail treats null as "do not send" and reports why', async () => {
    // Not { sent: true }: a mailer that quietly reports success while sending
    // nothing reads exactly like a quiet week.
    const r = await sendMail(null);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('no-copy');
  });

  test('sendMail accepts the promise a builder returns, unawaited', async () => {
    const r = await sendMail(verifyOtpMail('a@b.test', '481923', 'sign-in'));
    expect(r.sent).toBe(false);
  });
});
