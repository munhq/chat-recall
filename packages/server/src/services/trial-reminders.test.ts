/**
 * Trial reminders: which stage is due, and what each of the two tracks promises.
 *
 * The stage function and the scheduler steps are pure, so they are tested
 * directly. The claims in Postgres, and the flags the migration copies into
 * them, are tested in trial-reminders.pg.test.ts.
 */
import { describe, test, expect, afterEach } from 'vitest';
import {
  reminderStage, nudgeDue, nudgeAfterDays, trialSteps, trialReminders,
  type TrialUsage, type TrialSubject,
} from './trial-reminders.js';
import { __setProductKit } from '../util/product-kit.js';

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


/**
 * The step the scheduler sends: the first due step in list order. This is the
 * rule of the lifecycle scheduler, applied here to the steps without the kit.
 */
async function firstDue(daysLeft: number | null, usage: TrialUsage | null) {
  let reads = 0;
  const subject: TrialSubject = {
    id: 't', tenant: 't', to: 'owner@example.com', daysLeft,
    usage: async () => { reads++; return usage; },
  };
  for (const step of trialSteps()) {
    if (await step.due(subject, new Date())) return { id: step.id, key: step.key, reads };
  }
  return { id: null, key: null, reads };
}

describe('the scheduler steps', () => {
  test('each deadline stage picks its copy from the counts, under one claim key', async () => {
    expect(await firstDue(3, ACTIVE)).toMatchObject({ id: 'trial.value.half.holdings', key: 'trial.half' });
    expect(await firstDue(3, IDLE)).toMatchObject({ id: 'trial.setup.half', key: 'trial.half' });
    expect(await firstDue(1, ONE)).toMatchObject({ id: 'trial.value.final.holdings', key: 'trial.final' });
    expect(await firstDue(1, IDLE)).toMatchObject({ id: 'trial.setup.final', key: 'trial.final' });
    expect(await firstDue(0, ACTIVE)).toMatchObject({ id: 'trial.value.ended.holdings', key: 'trial.ended' });
    expect(await firstDue(-2, IDLE)).toMatchObject({ id: 'trial.setup.ended', key: 'trial.ended' });
  });

  test('counts that cannot be read take the value track with no numbers', async () => {
    for (const stage of STAGES) {
      const left = stage === 'half' ? 3 : stage === 'final' ? 1 : 0;
      expect(await firstDue(left, null)).toMatchObject({ id: `trial.value.${stage}.plain`, key: `trial.${stage}` });
    }
  });

  test('the most urgent stage is the first due step', async () => {
    expect((await firstDue(2, ACTIVE)).key).toBe('trial.half');
    expect((await firstDue(1, ACTIVE)).key).toBe('trial.final');
  });

  test('the nudge goes to an empty account only, before the deadline stages', async () => {
    expect(await firstDue(5, IDLE)).toMatchObject({ id: 'trial.setup.nudge', key: 'trial.nudge' });
    expect((await firstDue(5, ACTIVE)).id).toBeNull();
    expect((await firstDue(5, null)).id).toBeNull();
  });

  test('outside every window nothing is due, and the counts are not read', async () => {
    expect(await firstDue(7, IDLE)).toEqual({ id: null, key: null, reads: 0 });
    expect(await firstDue(null, IDLE)).toEqual({ id: null, key: null, reads: 0 });
  });
});

describe('a build without @munhq/product-kit', () => {
  afterEach(() => { __setProductKit(null); });

  test('schedules no trial reminder', async () => {
    __setProductKit(null);
    expect(await trialReminders()).toBeNull();
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
