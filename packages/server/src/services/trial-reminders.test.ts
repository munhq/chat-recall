/**
 * Trial reminders: which stage is due, and what each of the two tracks promises.
 *
 * The stage function is pure, so it is tested directly. The sweep itself is
 * covered through `reminderStage` plus the copy, because the sweep's remaining
 * logic is control-plane I/O that the integration harness exercises end to end.
 */
import { describe, test, expect } from 'vitest';
import { reminderStage, nudgeDue, nudgeAfterDays, trialReminderMail, type TrialUsage } from './trial-reminders.js';

/** The body with its wrapping collapsed. Every content assertion goes through
 *  this: the copy wraps at 78 columns around numbers whose width varies per
 *  tenant, so a phrase may straddle a line break for one reader and not another. */
const flat = (text: string) => text.replace(/\s+/g, ' ');

const ACTIVE: TrialUsage = { sessions: 11004, projects: 65, oldestMs: Date.UTC(2025, 4, 7) };
const ONE: TrialUsage = { sessions: 1, projects: 1, oldestMs: Date.now() };
const IDLE: TrialUsage = { sessions: 0, projects: 0, oldestMs: null };
const STAGES = ['half', 'final', 'ended'] as const;

describe('the install nudge', () => {
  test('is due two days into a seven-day trial', () => {
    expect(nudgeAfterDays()).toBe(2);
    expect(nudgeDue(5)).toBe(true);
  });

  test('is not due on the day of signup or the day after', () => {
    expect(nudgeDue(7)).toBe(false);
    expect(nudgeDue(6)).toBe(false);
  });

  test('yields to every deadline stage, so the urgent message wins', () => {
    for (const left of [3, 1, 0, -2]) expect(nudgeDue(left)).toBe(false);
  });

  test('no trial means nothing is due', () => {
    expect(nudgeDue(null)).toBe(false);
  });

});

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


/*
 * The copy assertions that stood below moved out with the words.
 *
 * Four blocks checked what each message SAYS: that the nudge sells nothing,
 * that the value track leads with the tenant's own counts, that the setup track
 * never mentions a price, that no subject prints a raw thousands separator.
 * Those are claims about wording, and the wording is now a pack this repository
 * does not carry.
 *
 * They are checked where the words live: k8s_gpu/scripts/check-mail-pack.mjs
 * reads the mounted pack, and @munhq/mailkit tests the renderer against a
 * fixture. What stays here is the part this repository still decides — WHICH
 * message is due, and WHEN.
 */
