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
 *   3 days left → the halfway nudge
 *   1 day left  → the deadline is real
 *   0 days left → the trial has ended; syncing has stopped
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

const log = createLogger('trial-reminders');

/** The three moments we write to a trialing user.
 *
 *  Keyed for a SEVEN-day trial: 3 days left, 1 day left, ended. The thresholds
 *  were 7 / 2 / 0, written for a 14-day trial — on the 7-day trial prod actually
 *  runs, the halfway nudge fired on day zero, alongside the welcome. */
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
  if (daysLeft <= 1) return 'final';
  if (daysLeft <= 3) return 'half';
  return null;
}

const UPGRADE_URL = process.env.TRIAL_UPGRADE_URL || 'https://chatrecall.dev/pricing';

/** The account page on THIS deployment — where a person sees their plan, their
 *  days left and the subscribe button. Derived from the app's own base URL so a
 *  self-hoster's reminder links to their server, not to ours. */
const ACCOUNT_URL = `${(process.env.BETTER_AUTH_URL || process.env.APP_URL || 'https://chatrecall.dev').replace(/\/+$/, '')}/app?view=account`;

/**
 * The reminder copy.
 *
 * States what happens at the end in every message, because the thing that makes
 * a deadline email tolerable is that it does not threaten: the history is kept
 * and export is never withheld, so nobody has to act out of fear of losing work.
 * It names no numbers, so it cannot promise a limit the server does not enforce.
 *
 * It also must not promise more than the server delivers. Until 2026-08-25 this
 * said the synced history stayed searchable after the trial; it does not any
 * more, and a reassurance the product then contradicts is worse than the plain
 * fact.
 */
export function trialReminderMail(to: string, stage: ReminderStage, daysLeft: number) {
  const keep = 'Nothing is deleted, and export always works.';
  // What actually happens at the end, in the words the CLI and the banner use.
  const after = [
    'What changes: recall switches off — searches stop answering, and new',
    'sessions stop syncing.',
    'What does not: your history stays on the server, and export keeps working.',
    '',
    'Your transcripts live on your own disk, so nothing is stranded — one',
    '`chat-recall sync --full` brings the server current the day you subscribe.',
  ];
  if (stage === 'ended') {
    return {
      to,
      subject: 'Your chat-recall trial has ended — syncing has stopped',
      text: [
        'Your chat-recall trial has ended, so new sessions are no longer syncing.',
        '',
        ...after,
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
        `Your chat-recall trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}, and`,
        'syncing stops when it does.',
        '',
        ...after,
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
      ...after,
      '',
      // The account page, not only the price list. Someone who connected through
      // the MCP connector has never opened the dashboard — they signed in once at
      // an OAuth prompt and have worked inside their AI tool since. This is the
      // first time they are told the dashboard exists, and "what am I on, and
      // until when" is the question they have; a pricing page does not answer it.
      `See your account and days left: ${ACCOUNT_URL}`,
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
