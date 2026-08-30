/**
 * Trial reminders: which stage is due, and what each of the two tracks promises.
 *
 * The stage function is pure, so it is tested directly. The sweep itself is
 * covered through `reminderStage` plus the copy, because the sweep's remaining
 * logic is control-plane I/O that the integration harness exercises end to end.
 */
import { describe, test, expect } from 'vitest';
import { reminderStage, trialReminderMail, type TrialUsage } from './trial-reminders.js';

/** The body with its wrapping collapsed. Every content assertion goes through
 *  this: the copy wraps at 78 columns around numbers whose width varies per
 *  tenant, so a phrase may straddle a line break for one reader and not another. */
const flat = (text: string) => text.replace(/\s+/g, ' ');

const ACTIVE: TrialUsage = { sessions: 11004, projects: 65, oldestMs: Date.UTC(2025, 4, 7) };
const ONE: TrialUsage = { sessions: 1, projects: 1, oldestMs: Date.now() };
const IDLE: TrialUsage = { sessions: 0, projects: 0, oldestMs: null };
const STAGES = ['half', 'final', 'ended'] as const;

describe('reminderStage', () => {
  test('nothing is due early in the trial', () => {
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
    expect(reminderStage(2)).toBe('half');
    expect(reminderStage(1)).toBe('final');
  });

  test('no end date means no reminder', () => {
    expect(reminderStage(null)).toBeNull();
  });
});

describe('every message, on either track', () => {
  test('has a recipient, a subject and a way to reach a person', () => {
    for (const stage of STAGES) {
      for (const usage of [ACTIVE, IDLE, null]) {
        const mail = trialReminderMail('a@b.test', stage, 2, usage);
        expect(mail.to).toBe('a@b.test');
        expect(mail.subject).toBeTruthy();
        expect(mail.text).toContain('contact@chatrecall.dev');
      }
    }
  });

  test('links only to pages that exist — no invented docs URL', () => {
    // Only /, /pricing/ and /self-hosting/ are real. A 404 in a trial reminder
    // is worse than no link at all.
    for (const stage of STAGES) {
      for (const usage of [ACTIVE, IDLE, null]) {
        const text = flat(trialReminderMail('a@b.test', stage, 2, usage).text);
        for (const url of text.match(/https:\/\/chatrecall\.dev\S*/g) ?? []) {
          expect(url).toMatch(/^https:\/\/chatrecall\.dev(\/pricing|\/self-hosting\/|\/app\?view=account)?$/);
        }
      }
    }
  });

  test('never prints a raw thousands separator into a subject line', () => {
    // holdingsOf once shortened its sentence with split(','), which cut
    // "11,004 sessions" down to "11".
    for (const stage of STAGES) {
      const subject = trialReminderMail('a@b.test', stage, 3, ACTIVE).subject;
      expect(subject).not.toMatch(/\b11 sessions\b/);
      if (/session/.test(subject)) expect(subject).toContain('11,004 sessions');
    }
  });
});

describe('the VALUE track — a trial that has actually been used', () => {
  test('leads with what the server is really holding', () => {
    const mail = trialReminderMail('a@b.test', 'half', 3, ACTIVE);
    expect(flat(mail.text)).toContain('11,004 sessions');
    expect(flat(mail.text)).toContain('65 projects');
    expect(flat(mail.text)).toContain('May 2025');
    expect(mail.subject).toContain('11,004 sessions');
  });

  test('a recent, single-session account is not padded with a date or a project count', () => {
    const text = flat(trialReminderMail('a@b.test', 'half', 3, ONE).text);
    expect(text).toContain('1 session');
    expect(text).not.toMatch(/from 1 projects/);
    expect(text).not.toMatch(/the oldest from/);
  });

  test('unknown usage falls back to the value track, never to "your account is empty"', () => {
    // Telling an active user their account is empty because a COUNT(*) timed out
    // is the one mistake here that destroys trust outright.
    for (const stage of STAGES) {
      const text = flat(trialReminderMail('a@b.test', stage, 2, null).text);
      expect(text).not.toMatch(/nothing has synced|never reached the server|account is empty/i);
    }
  });

  test('every stage promises the data is kept and names the price', () => {
    for (const stage of STAGES) {
      const text = flat(trialReminderMail('a@b.test', stage, 2, ACTIVE).text);
      expect(text).toMatch(/nothing is deleted|deletes nothing/i);
      expect(text).toMatch(/pricing/);
    }
  });

  test('the ended notice states what stops and what does not', () => {
    const text = flat(trialReminderMail('a@b.test', 'ended', 0, ACTIVE).text);
    expect(text).not.toMatch(/read-only/i);
    expect(text).not.toMatch(/free plan/i);
    expect(text).not.toMatch(/searchable/i);
    expect(text).toMatch(/no longer syncing/i);
    expect(text).toMatch(/searches stop/i);
    expect(text).toMatch(/nothing is deleted/i);
    expect(text).toMatch(/sync --full/);       // the one command that restores it
    expect(text).toMatch(/export/i);
  });

  test('the final notice describes the same landing, and that it is reversible', () => {
    const text = flat(trialReminderMail('a@b.test', 'final', 1, ACTIVE).text);
    expect(text).not.toMatch(/read-only/i);
    expect(text).not.toMatch(/free plan/i);
    expect(text).not.toMatch(/searchable/i);
    expect(text).toMatch(/stop syncing/i);
    expect(text).toMatch(/searches stop/i);
    expect(text).toMatch(/sync --full/);
    expect(text).toMatch(/lose no history/i);
  });

  test('the halfway notice points at the ACCOUNT page, not only the price list', () => {
    const text = flat(trialReminderMail('a@b.test', 'half', 3, ACTIVE).text);
    expect(text).toContain('/app?view=account');
    expect(text).toMatch(/pricing/);
    expect(text).toMatch(/searches stop/i);
  });

  test('it never claims a number of days elapsed', () => {
    // `trialLengthDays() - daysLeft` printed "4 days into your trial" to accounts
    // on a 14-day grant who were 11 days in: the live env length has nothing to
    // do with the length a given trial was granted under.
    for (const stage of STAGES) {
      expect(flat(trialReminderMail('a@b.test', stage, 3, ACTIVE).text)).not.toMatch(/days into your/i);
    }
  });

  test('singular day, not "1 days"', () => {
    expect(trialReminderMail('a@b.test', 'final', 1, null).subject).toContain('1 day left');
    expect(trialReminderMail('a@b.test', 'final', 2, null).subject).toContain('2 days left');
  });
});

describe('the SETUP track — a trial where nothing was ever synced', () => {
  test('gives the one command instead of a price', () => {
    for (const stage of STAGES) {
      const text = flat(trialReminderMail('a@b.test', stage, 2, IDLE).text);
      expect(text).toContain('npx chat-recall init');
    }
  });

  test('never asks an empty account for money', () => {
    // The whole reason this track exists: a countdown and an invoice link sent to
    // someone who has never seen the product work reads as a dunning notice.
    for (const stage of STAGES) {
      const text = flat(trialReminderMail('a@b.test', stage, 2, IDLE).text);
      expect(text).not.toMatch(/subscribe/i);
      expect(text).not.toContain('https://chatrecall.dev/pricing');
    }
  });

  test('offers to restart the clock, at every stage', () => {
    for (const stage of STAGES) {
      const text = flat(trialReminderMail('a@b.test', stage, 2, IDLE).text);
      expect(text).toMatch(/restart|fresh trial/i);
      expect(text).toMatch(/reply/i);
    }
  });

  test('the ended notice asks what was missing rather than closing the door', () => {
    const text = flat(trialReminderMail('a@b.test', 'ended', 0, IDLE).text);
    expect(text).toMatch(/fresh trial/i);
    expect(text).toMatch(/what you expected/i);
  });

  test('states the privacy facts, since the ask is to run the CLI', () => {
    const text = flat(trialReminderMail('a@b.test', 'half', 3, IDLE).text);
    expect(text).toMatch(/masked/i);
    expect(text).toMatch(/waits for a yes/i);
  });
});
