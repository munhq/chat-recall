/**
 * Trial reminder sweep — the part of conversion the product previously lacked
 * entirely.
 *
 * Before this, nothing in the system ever asked anyone to pay: access was
 * granted by a flag with no end date, so there was no deadline to warn about and
 * no moment where a free user became a customer. A dated trial only converts if
 * somebody is told it is ending.
 *
 * ── What it sends ──────────────────────────────────────────────────────────
 *
 * Three messages, keyed on DAYS REMAINING rather than days elapsed, so a sweep
 * that misses a window still sends the most urgent message rather than a stale
 * one:
 *
 *   7 days left → the halfway nudge
 *   2 days left → the deadline is real
 *   0 days left → the trial has ended; the account is on the free plan
 *
 * Each stage is sent at most once per tenant. The record of having sent it is a
 * tenant setting (`trial_reminder_<stage>`), so a restart, a redeploy or a second
 * server replica cannot re-send one; there is no in-memory state to lose.
 *
 * ── Why it is safe to run on every replica ─────────────────────────────────
 *
 * The guard is a read-then-write on the tenant setting, which is not atomic
 * across replicas, so a simultaneous double-send is theoretically possible. The
 * consequence is one duplicate email, and the alternative — a lock table or a
 * leader election for three emails per tenant per fortnight — costs more than the
 * failure. The sweep is hourly and the windows are days wide, so replicas
 * realistically never collide inside one tick.
 *
 * Mail failures never throw (see auth/mailer.ts) and are NOT marked as sent, so a
 * transient SMTP outage retries on the next sweep instead of silently swallowing
 * the only warning a user gets.
 */
import { createControlPlane } from '../imports.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { sendMail } from '../auth/mailer.js';
import { isNoCardTrial, trialDaysLeft, trialLengthDays } from '../util/trial.js';
import { freeLimits } from '../util/entitlements.js';

const log = createLogger('trial-reminders');

/** The three moments we write to a trialing user. */
export type ReminderStage = 'half' | 'final' | 'ended';

/**
 * Which reminder is due at `daysLeft`, or null when none is.
 *
 * Ordered most-urgent-first and using `<=` rather than `===` so the correct
 * message still goes out if a sweep is skipped: a tenant found at 1 day left
 * gets the 'final' notice, not the halfway one it slept through. The
 * already-sent guard in the caller stops the broader thresholds re-firing.
 */
export function reminderStage(daysLeft: number | null): ReminderStage | null {
  if (daysLeft == null) return null;
  if (daysLeft <= 0) return 'ended';
  if (daysLeft <= 2) return 'final';
  if (daysLeft <= 7) return 'half';
  return null;
}

const UPGRADE_URL = process.env.TRIAL_UPGRADE_URL || 'https://chatrecall.dev/pricing';

/**
 * The reminder copy.
 *
 * States what happens at the end in every message, because the thing that makes
 * a deadline email tolerable is that it does not threaten: the history is kept,
 * and the account lands on the free plan rather than going dark — nobody has to
 * act out of fear of losing work. The window is read from freeLimits() so the
 * email never promises a number the server does not enforce.
 */
export function trialReminderMail(to: string, stage: ReminderStage, daysLeft: number) {
  const keep = 'Your history is kept either way — nothing is deleted.';
  const windowDays = freeLimits().searchWindowDays ?? 7;
  if (stage === 'ended') {
    return {
      to,
      subject: 'Your chat-recall trial has ended',
      text: [
        'Your chat-recall trial has ended.',
        '',
        `Your account is now on the FREE plan: your last ${windowDays} days stay`,
        'searchable, and sync keeps working within a monthly quota. Your full',
        'history is kept and unlocks the moment you upgrade.',
        '',
        keep,
        '',
        `Subscribe: ${UPGRADE_URL}`,
      ].join('\n'),
    };
  }
  if (stage === 'final') {
    return {
      to,
      subject: `${daysLeft} day${daysLeft === 1 ? '' : 's'} left on your chat-recall trial`,
      text: [
        `Your chat-recall trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
        '',
        `When it ends you move to the free plan: your last ${windowDays} days stay`,
        'searchable, sync keeps working within a monthly quota, and your full',
        'history unlocks when you upgrade.',
        '',
        keep,
        '',
        `Subscribe: ${UPGRADE_URL}`,
      ].join('\n'),
    };
  }
  return {
    to,
    subject: `${daysLeft} days left on your chat-recall trial`,
    text: [
      `You are ${trialLengthDays() - daysLeft} days into your chat-recall trial,`,
      `with ${daysLeft} to go.`,
      '',
      'The longer it runs, the more of your own history it can recall — so this is',
      'usually the point where it starts earning its place.',
      '',
      `Subscribe any time: ${UPGRADE_URL}`,
    ].join('\n'),
  };
}

/**
 * One sweep across all tenants. Returns what it did, so the caller can log it and
 * a test can assert on it without inspecting mail.
 */
export async function sweepTrialReminders(
  now = Date.now(),
): Promise<{ scanned: number; onTrial: number; sent: Array<{ tenant: string; stage: ReminderStage }> }> {
  const sent: Array<{ tenant: string; stage: ReminderStage }> = [];
  let scanned = 0;
  let onTrial = 0;

  const cp = await createControlPlane();
  try {
    const tenants = await cp.listTenants();
    for (const tenant of tenants) {
      scanned++;
      const ent = await cp.getEntitlement(tenant);
      // Only OUR trials. A Stripe card trial is Stripe's to chase — it dunns on
      // its own and the customer already gave us a card.
      if (!isNoCardTrial(ent)) continue;
      onTrial++;

      const left = trialDaysLeft(ent, now);
      const stage = reminderStage(left);
      if (!stage) continue;

      const key = `trial_reminder_${stage}`;
      if (await cp.getTenantSetting(tenant, key)) continue;   // already sent

      const to = await ownerEmail(cp, tenant);
      // No address on file: skip WITHOUT marking, so the reminder still goes out
      // if an email appears later. Marking here would silently burn the notice.
      if (!to) continue;

      const res = await sendMail(trialReminderMail(to, stage, left ?? 0));
      if (!res.sent && res.reason === 'send-failed') {
        // Transient: leave unmarked and retry next sweep.
        log.warn({ tenant, stage }, 'trial reminder send failed; will retry');
        continue;
      }
      // Marked on success, and also when there is no SMTP at all: in that mode
      // mailer.ts prints the message and a self-hoster is not served by us
      // reprinting it hourly forever.
      await cp.setTenantSetting(tenant, key, String(now));
      sent.push({ tenant, stage });
    }
  } finally {
    await cp.close();
  }

  if (sent.length) log.info({ sent, scanned, onTrial }, 'trial reminders sent');
  return { scanned, onTrial, sent };
}

/** The team owner's address — the person who can actually pay. */
async function ownerEmail(
  cp: { listMembers(t: string): Promise<Array<{ email: string | null; role: string }>> },
  tenant: string,
): Promise<string | null> {
  const members = await cp.listMembers(tenant);
  const owner = members.find((m) => m.role === 'owner' && m.email);
  return owner?.email ?? null;
}
