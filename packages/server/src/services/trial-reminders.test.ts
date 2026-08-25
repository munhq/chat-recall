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
    // Re-keyed for the 7-day trial prod runs: at 7 days left the user has just
    // signed up, and the old threshold fired the halfway nudge on day zero.
    expect(reminderStage(7)).toBeNull();
    expect(reminderStage(4)).toBeNull();
  });

  test('the halfway nudge at 3 days left', () => {
    expect(reminderStage(3)).toBe('half');
  });

  test('the final notice from 1 day left', () => {
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
    expect(reminderStage(2)).toBe('half');
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
    expect(trialReminderMail('a@b.test', 'final', 1).text).toMatch(/nothing is deleted/i);
  });

  test('the ended notice states what stops and what does not', () => {
    const text = trialReminderMail('a@b.test', 'ended', 0).text;
    // Three earlier versions of this copy were wrong, each written for a tier
    // that no longer existed: "read-only" (nothing was read-only), "the free
    // plan: your last 7 days stay searchable" (no window, and sync had stopped),
    // and "everything already synced stays fully searchable" (recall now stops
    // outright). An email cannot be corrected after it is sent, so the promise
    // must be the narrow true one: the data is kept, and export works.
    expect(text).not.toMatch(/read-only/i);
    expect(text).not.toMatch(/free plan/i);
    expect(text).not.toMatch(/searchable/i);
    expect(text).toMatch(/stop syncing|no longer syncing/i);
    expect(text).toMatch(/searches stop/i);
    expect(text).toMatch(/nothing is deleted/i);
    expect(text).toMatch(/sync --full/);       // the one command that restores it
    expect(text).toMatch(/export/i);
  });

  test('the final notice describes the same landing', () => {
    const text = trialReminderMail('a@b.test', 'final', 1).text;
    expect(text).not.toMatch(/read-only/i);
    expect(text).not.toMatch(/free plan/i);
    expect(text).not.toMatch(/searchable/i);
    expect(text).toMatch(/syncing stops/i);
    expect(text).toMatch(/searches stop/i);
  });

  test('the day-4 notice points at the ACCOUNT page, not only the price list', () => {
    // A connector user has never opened the dashboard — they signed in once at an
    // OAuth prompt and have worked inside their AI tool since. This mail is where
    // they learn it exists, and "what am I on, until when" is what they want.
    const text = trialReminderMail('a@b.test', 'half', 3).text;
    expect(text).toContain('/app?view=account');
    expect(text).toMatch(/pricing|subscribe/i);
    // And it states the landing, like the other two stages, so no stage implies
    // a softer ending than the product delivers.
    expect(text).toMatch(/searches stop/i);
  });

  test('singular day, not "1 days"', () => {
    expect(trialReminderMail('a@b.test', 'final', 1).subject).toContain('1 day left');
    expect(trialReminderMail('a@b.test', 'final', 2).subject).toContain('2 days left');
  });
});
