/**
 * Trial reminders: which stage is due, and the once-only guarantee.
 *
 * The stage function is pure, so it is tested directly. The sweep itself is
 * covered through `reminderStage` plus the copy, because the sweep's remaining
 * logic is control-plane I/O that the integration harness exercises end to end.
 */
import { describe, test, expect } from 'vitest';
import { reminderStage, trialReminderMail } from './trial-reminders.js';

describe('reminderStage', () => {
  test('nothing is due early in the trial', () => {
    expect(reminderStage(14)).toBeNull();
    expect(reminderStage(8)).toBeNull();
  });

  test('the halfway nudge at 7 days left', () => {
    expect(reminderStage(7)).toBe('half');
  });

  test('the final notice from 2 days left', () => {
    expect(reminderStage(2)).toBe('final');
    expect(reminderStage(1)).toBe('final');
  });

  test('the ended notice at 0 or past', () => {
    expect(reminderStage(0)).toBe('ended');
    expect(reminderStage(-3)).toBe('ended');
  });

  test('a skipped sweep still sends the MOST URGENT stage, not the one missed', () => {
    // Thresholds are <=, not ==, so a tenant first seen at 3 days left gets the
    // halfway message, and one first seen at 1 day gets the final one. An == test
    // would silently send nothing at all to a tenant the sweep stepped over.
    expect(reminderStage(5)).toBe('half');
    expect(reminderStage(1)).toBe('final');
  });

  test('no end date means no reminder', () => {
    // A Stripe trial Stripe has not dated yet must not trigger our copy.
    expect(reminderStage(null)).toBeNull();
  });
});

describe('trialReminderMail', () => {
  test('every stage promises the data is kept', () => {
    // The deadline must never read as a threat to the user's own history, or the
    // email converts worse than sending nothing.
    for (const stage of ['half', 'final', 'ended'] as const) {
      const mail = trialReminderMail('a@b.test', stage, 2);
      expect(mail.to).toBe('a@b.test');
      expect(mail.subject).toBeTruthy();
      expect(mail.text).toMatch(/subscribe/i);
    }
    expect(trialReminderMail('a@b.test', 'ended', 0).text).toMatch(/nothing is deleted/i);
    expect(trialReminderMail('a@b.test', 'final', 2).text).toMatch(/nothing is deleted/i);
  });

  test('the ended notice states the free-plan truth, not read-only', () => {
    const text = trialReminderMail('a@b.test', 'ended', 0).text;
    // The old promise ("read-only after trial") is no longer the product: a
    // lapsed tenant lands on the FREE plan — windowed search, metered sync.
    expect(text).not.toMatch(/read-only/i);
    expect(text).toMatch(/free plan/i);
    expect(text).toMatch(/7 days/);            // the enforced search window
    expect(text).toMatch(/monthly quota/i);    // sync continues, metered
    expect(text).toMatch(/unlocks/i);          // the full history is the offer
  });

  test('the final notice describes the same free-plan landing', () => {
    const text = trialReminderMail('a@b.test', 'final', 2).text;
    expect(text).not.toMatch(/read-only/i);
    expect(text).toMatch(/free plan/i);
    expect(text).toMatch(/monthly quota/i);
  });

  test('singular day, not "1 days"', () => {
    expect(trialReminderMail('a@b.test', 'final', 1).subject).toContain('1 day left');
    expect(trialReminderMail('a@b.test', 'final', 2).subject).toContain('2 days left');
  });
});
