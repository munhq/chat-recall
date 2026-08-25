/**
 * The confirmation mail, which every single signup receives.
 *
 * It used to carry a link. Two things killed that silently: corporate mail
 * scanners GET every URL to check it, spending a single-use verification token
 * before the human clicks — and because the token was a stateless JWT there was
 * no row, so no trace it happened. And a link opened in the default browser, or
 * on a phone, lands in a different session from the one that signed up.
 *
 * A code has neither failure, and finishes in the tab the user is already in.
 * These assertions protect the properties that make that true in practice.
 */
import { describe, test, expect } from 'vitest';
import { verifyOtpMail } from './mailer.js';

describe('the confirmation code mail', () => {
  const mail = verifyOtpMail('someone@example.com', '481923', 'email-verification');

  test('puts the code alone on its own line', () => {
    // Phones select a whole line, and the OS offers a one-tap autofill for a
    // mail shaped this way. A code buried mid-sentence gets neither.
    expect(mail.text.split('\n')).toContain('481923');
  });

  test('carries NO link — that is the whole point of the change', () => {
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.text).not.toMatch(/verify-email\?token=/);
  });

  test('says how long it lasts, so an expired code is not a mystery', () => {
    expect(mail.text).toMatch(/expires in 15 minutes/i);
  });

  test('says the trial has not started yet', () => {
    // Someone who leaves it a day should not think they burned a day of trial.
    expect(mail.text).toMatch(/nothing is counting down/i);
  });

  test('a password reset says reset, not "start your trial"', () => {
    const reset = verifyOtpMail('someone@example.com', '481923', 'forget-password');
    expect(reset.subject).toMatch(/password reset/i);
    expect(reset.text).toMatch(/reset your password/i);
    expect(reset.text).not.toMatch(/start your chat-recall trial/i);
  });

  test('every variant tells an unexpecting recipient to ignore it', () => {
    for (const t of ['email-verification', 'forget-password'] as const) {
      expect(verifyOtpMail('a@b.test', '000000', t).text).toMatch(/ignore this message/i);
    }
  });
});
