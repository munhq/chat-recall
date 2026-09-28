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
 * Three moments, keyed on DAYS REMAINING rather than days elapsed, so a sweep
 * that misses a window still sends the most urgent message rather than a stale
 * one:
 *
 *   3 days left → the halfway nudge
 *   1 day left  → the deadline is real
 *   0 days left → the trial has ended; syncing has stopped
 *
 * ── Why each moment has TWO messages ───────────────────────────────────────
 *
 * The first live run of this sweep exposed the real failure, and it was not
 * conversion. Of the tenants it wrote to, MOST had never synced a single
 * session. They were sent a countdown and an invoice link for a product they had
 * never seen work.
 *
 * That is the worst email in the set: it asks for money from someone with an
 * empty account, and it reads as a dunning notice rather than an offer. So each
 * stage branches on whether anything was ever synced:
 *
 *   sessions = 0  → the SETUP track. Do not sell. Give the one command, and
 *                   offer to restart the clock, because a trial nobody ran is
 *                   not a trial they declined.
 *   sessions > 0  → the VALUE track. Lead with what the server actually holds
 *                   for them — their own counts — because that is the entire
 *                   product argument and we can state it as fact.
 *
 * The usage lookup is best-effort: if it fails, or the deployment has no
 * Postgres URL, the copy falls back to the value track with no numbers. A
 * reminder must never be lost because a COUNT(*) was unavailable.
 *
 * ── Once-only ──────────────────────────────────────────────────────────────
 *
 * Each stage is sent at most once per tenant. The sweep is the lifecycle
 * scheduler of `@munhq/product-kit`. A send starts with a claim: an insert of
 * (product, tenant, stage) into `lifecycle_mail`, in this server's own
 * Postgres. Postgres gives the row to one inserter, and only that replica
 * sends. So a restart, a redeploy or two replicas that sweep at the same time
 * send each stage once.
 *
 * The setup and value copies of one stage share the claim key `trial.<stage>`,
 * so a tenant gets one mail for each stage, whichever copy is due.
 *
 * The flags that recorded a send before the scheduler (`trial_reminder_<stage>`
 * in tenant settings) became `lifecycle_mail` rows with the outcome `sent`, in
 * cloud/migrations/0017_trial_reminder_claims.sql. A tenant that got a stage
 * under the flags does not get it again.
 *
 * A mail that fails to send releases its claim, so a transient SMTP outage
 * retries on the next sweep. A deployment with no copy, no server or no sender
 * keeps the claim with that reason, so a deployment that gets a server later
 * does not mail every old stage at once.
 *
 * ── A build without the kit ────────────────────────────────────────────────
 *
 * The kit and `@munhq/mailkit` are optional dependencies, installed together
 * (MAILKIT=1 in docker/Dockerfile.server). A build without them has no copy
 * pack, so no reminder can have words. `startTrialReminders()` then logs one
 * line and schedules nothing.
 */
import type { Lifecycle, LifecyclePool, LifecycleStep } from '@munhq/product-kit/lifecycle';
import { createControlPlane } from '../imports.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { renderMail, mailFrom, type Mail } from '../auth/mailer.js';
import { mailkit } from '../auth/mail-kit.js';
import { loadProductKit, lifecycleKit } from '../util/product-kit.js';
import { isNoCardTrial, trialDaysLeft, trialLengthDays } from '../util/trial.js';

const log = createLogger('trial-reminders');

/** The moments we write to a trialing user.
 *
 *  Keyed for a SEVEN-day trial: 3 days left, 1 day left, ended. The thresholds
 *  were 7 / 2 / 0, written for a 14-day trial — on the 7-day trial prod actually
 *  runs, the halfway nudge fired on day zero, alongside the welcome.
 *
 *  `nudge` is keyed the other way round — days SINCE SIGNUP — and goes only to
 *  an account that has synced nothing. Every other stage waits for the deadline
 *  to approach, so the earliest mail an empty account could receive was day 4 of
 *  7. Four days is long enough to forget you signed up, and the whole failure
 *  this addresses is somebody who never ran the install command. */
export type ReminderStage = 'nudge' | 'half' | 'final' | 'ended';

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

/** Days into the trial at which an account with nothing synced gets the nudge. */
export function nudgeAfterDays(): number {
  const n = Number(process.env.TRIAL_NUDGE_DAY);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
}

/**
 * Is the install nudge due?
 *
 * Only while no deadline stage owns the tenant, so a trial already inside its
 * last three days gets the urgent message instead of a beginner's one. The
 * caller checks the account is empty before it sends — telling an active user
 * that nothing has synced is the one mistake in this file that destroys trust.
 */
export function nudgeDue(daysLeft: number | null): boolean {
  if (daysLeft == null) return false;
  if (reminderStage(daysLeft)) return false;
  return trialLengthDays() - daysLeft >= nudgeAfterDays();
}

const UPGRADE_URL = process.env.TRIAL_UPGRADE_URL || 'https://chatrecall.dev/pricing';

/** The account page on THIS deployment — where a person sees their plan, their
 *  days left and the subscribe button. Derived from the app's own base URL so a
 *  self-hoster's reminder links to their server, not to ours. */
const ACCOUNT_URL = `${(process.env.BETTER_AUTH_URL || process.env.APP_URL || 'https://chatrecall.dev').replace(/\/+$/, '')}/app?view=account`;

/** Only three marketing pages exist. Do not invent a fourth in an email —
 *  a 404 in a trial reminder is worse than no link at all. */
const SELF_HOST_URL = 'https://chatrecall.dev/self-hosting/';

/**
 * What the server is actually holding for this tenant.
 *
 * These three numbers ARE the pitch. "Your history is valuable" is a claim;
 * "11,004 sessions from 65 projects, the oldest from May 2025" is the same claim
 * with the burden of proof already discharged, in the reader's own data.
 */
export interface TrialUsage {
  sessions: number;
  projects: number;
  /** mtime of the oldest indexed session, ms. Null when nothing is synced. */
  oldestMs: number | null;
}

/**
 * Read the tenant's session counts, or null when they cannot be read.
 *
 * Deliberately best-effort and never throwing. The reminder is the only warning
 * a trialing user receives; losing it because a stats query timed out would be a
 * far worse outcome than sending copy without numbers in it. A null return puts
 * the caller on the generic value track.
 *
 * The sweep runs with no author context, so `app.viewer` is set to the '*'
 * sentinel and the query sees the whole tenant rather than one member's rows.
 */
export async function loadTrialUsage(tenant: string): Promise<TrialUsage | null> {
  if (!process.env.DATABASE_URL && !process.env.CHAT_RECALL_DATABASE_URL) return null;
  try {
    const { openPgPool, tenantQuery } = await import('@chat-recall/engine/core/store/pg-pool.js');
    const pool = await openPgPool(process.env.DATABASE_URL || '');
    const r = await tenantQuery(
      pool,
      tenant,
      `SELECT COUNT(*)::int                              AS sessions,
              COUNT(DISTINCT NULLIF(project_id, ''))::int AS projects,
              MIN(mtime)                                  AS oldest
         FROM memory_metadata
        WHERE tenant = $1 AND source_type = 'session'`,
      [tenant],
      // Rather fail than queue behind a migration's ACCESS EXCLUSIVE lock: the
      // fallback copy is fine, a stuck sweep is not.
      { lockTimeoutMs: 5_000 },
    );
    const row = (r.rows?.[0] ?? {}) as { sessions?: number; projects?: number; oldest?: number | null };
    return {
      sessions: Number(row.sessions) || 0,
      projects: Number(row.projects) || 0,
      oldestMs: row.oldest == null ? null : Number(row.oldest),
    };
  } catch (err) {
    log.warn({ tenant, err: err instanceof Error ? err.message : err }, 'trial usage lookup failed; using generic copy');
    return null;
  }
}

const n = (v: number) => v.toLocaleString('en-US');
const plural = (v: number, one: string, many = `${one}s`) => (v === 1 ? one : many);

/** "May 2025". UTC so the month never shifts with the server's timezone. */
function monthYear(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * What the server holds, in the three forms the copy needs.
 *
 * `short` goes in a subject line, so it never carries the date clause: a subject
 * that wraps is a subject nobody finishes reading. `long` ends ON that clause, so
 * only a sentence that ENDS there may use it — otherwise the tail dangles
 * ("...the oldest from May 2025 for you."). `figures` is the HTML stat row.
 *
 * The project count is only added above one, and the date only when the history
 * genuinely reaches back — "the oldest from August 2026" on a trial started in
 * August reads as padding, and padding is what makes a personalised message feel
 * automated rather than observed.
 */
function holdingsOf(u: TrialUsage | null | undefined) {
  if (!u || u.sessions <= 0) return null;
  const short = `${n(u.sessions)} ${plural(u.sessions, 'session')}`;
  const figures: Array<{ value: string; label: string }> = [
    { value: n(u.sessions), label: plural(u.sessions, 'session') },
  ];
  let long = short;
  if (u.projects > 1) {
    long += ` from ${n(u.projects)} projects`;
    figures.push({ value: n(u.projects), label: 'projects' });
  }
  const AGED_MS = 45 * 86_400_000;
  if (u.oldestMs != null && Date.now() - u.oldestMs > AGED_MS) {
    long += `, the oldest from ${monthYear(u.oldestMs)}`;
    figures.push({ value: monthYear(u.oldestMs), label: 'oldest' });
  }
  return { short, long, figures, verb: u.sessions === 1 ? 'stops' : 'stop' };
}

/**
 * The SETUP track: a trial where nothing was ever synced.
 *
 * It sells nothing, because there is nothing to sell yet — the reader has not
 * seen the product work, so a price is an unanswerable question. It does exactly
 * two things: give the one command, and offer to restart the clock. The offer is
 * real and a person honours it by hand; at this scale that is cheaper than
 * losing every user who got stuck at install.
 *
 * EVERY stage of this track comes from a person, not only the day-two one, and
 * the pack sets that sender. The track writes to somebody who never got the
 * product working, asks what went wrong, and offers to restart their trial —
 * three things a no-reply sender makes look automated, which is the one reading
 * that guarantees no answer.
 */
async function setupTrackMail(to: string, stage: ReminderStage, daysLeft: number) {
  const kit = await mailkit();
  if (!kit) return null;
  const { copy, word } = kit;
  const elapsed = Math.max(1, trialLengthDays() - daysLeft);
  const id = stage === 'nudge' ? 'trial.setup.nudge'
    : stage === 'ended' ? 'trial.setup.ended'
      : stage === 'final' ? 'trial.setup.final'
        : 'trial.setup.half';
  return renderMail(copy(id, to, {
    days: n(daysLeft),
    dayWord: plural(daysLeft, 'day'),
    elapsed: n(elapsed),
    elapsedWord: plural(elapsed, 'day'),
    endsWhen: daysLeft === 1 ? word('tomorrow') : word('inDays', { days: n(daysLeft) }),
    accountUrl: ACCOUNT_URL,
    selfHostUrl: SELF_HOST_URL,
    upgradeUrl: UPGRADE_URL,
  }), kit, id);
}

/**
 * The VALUE track: a trial that has actually been used.
 *
 * Every stage states the same two facts — what stops, and what does not — because
 * the thing that makes a deadline message tolerable is that it does not threaten.
 * Nothing is deleted and export is never withheld, so nobody has to act out of
 * fear of losing work. Removing the fear is not softness; it is what makes the
 * remaining reason to subscribe an honest one.
 *
 * Two variants per stage. `holdings` leads with the tenant's own counts and
 * carries a stats row; `plain` is the same message for a tenant whose counts
 * could not be read. The numbers in the stats row come from here, because their
 * length depends on what the tenant has; every word around them is in the pack.
 */
async function valueTrackMail(to: string, stage: ReminderStage, daysLeft: number, usage?: TrialUsage | null) {
  const kit = await mailkit();
  if (!kit) return null;
  const { copy, word, withFigures } = kit;
  const h = holdingsOf(usage);
  const bucket = stage === 'ended' ? 'ended' : stage === 'final' ? 'final' : 'half';
  const id = `trial.value.${bucket}.${h ? 'holdings' : 'plain'}`;
  const fallback = word('yourSyncedHistory');
  const message = copy(id, to, {
    days: n(daysLeft),
    dayWord: plural(daysLeft, 'day'),
    endsWhen: daysLeft === 1 ? word('tomorrow') : word('inDays', { days: n(daysLeft) }),
    holdingsShort: h ? h.short : undefined,
    holdingsLong: h ? h.long : undefined,
    yoursShort: h ? word('yours', { what: h.short }) : fallback,
    yoursLong: h ? word('yours', { what: h.long }) : fallback,
    verb: h ? h.verb : undefined,
    accountUrl: ACCOUNT_URL,
    selfHostUrl: SELF_HOST_URL,
    upgradeUrl: UPGRADE_URL,
  });
  return renderMail(withFigures(message, h ? h.figures : []), kit, id);
}

/**
 * The reminder copy for one tenant at one stage.
 *
 * `usage` decides the track. Undefined or null means "could not read it", which
 * takes the value track without numbers — never the setup track, because telling
 * an active user their account is empty is the one mistake here that destroys
 * trust outright.
 */
export async function trialReminderMail(
  to: string,
  stage: ReminderStage,
  daysLeft: number,
  usage?: TrialUsage | null,
) {
  // `nudge` is only ever chosen for an empty account, and its copy says so
  // outright, so it must never reach the value track.
  if (stage === 'nudge' || (usage && usage.sessions === 0)) return setupTrackMail(to, stage, daysLeft);
  return valueTrackMail(to, stage, daysLeft, usage);
}

/** One trialing tenant, as the scheduler sees it. */
export interface TrialSubject {
  id: string;
  tenant: string;
  /** The team owner's address: the person who can pay. */
  to: string | null;
  daysLeft: number | null;
  /** The tenant's counts, read once for each sweep and only when a stage asks. */
  usage(): Promise<TrialUsage | null>;
}

/** The deadline stages, most urgent first. */
const DEADLINES = ['ended', 'final', 'half'] as const;

/** Mail from this server has one sender. */
async function withSender(input: Promise<Mail | null>): Promise<Mail | null> {
  const mail = await input;
  return mail ? { ...mail, from: mail.from || mailFrom() } : null;
}

/**
 * The scheduler's steps, most urgent first.
 *
 * The scheduler sends the first due step of a tenant and no other in that
 * sweep. A tenant found at 1 day left gets the final notice, and the halfway
 * one it did not get stays unsent, because the final stage is still the first
 * due step. This is the rule of `reminderStage()`.
 *
 * Each deadline stage has three copies under one claim key: the setup track
 * for an account with nothing synced, and the value track with or without the
 * tenant's counts. Counts that cannot be read take the value track with no
 * numbers. The nudge goes only to an empty account, and only while no deadline
 * stage is due.
 */
export function trialSteps(): Array<LifecycleStep<TrialSubject>> {
  const steps: Array<LifecycleStep<TrialSubject>> = [];
  for (const stage of DEADLINES) {
    const key = `trial.${stage}`;
    const at = (s: TrialSubject) => reminderStage(s.daysLeft) === stage;
    const empty = (u: TrialUsage | null) => !!u && u.sessions === 0;
    steps.push({
      id: `trial.setup.${stage}`,
      key,
      due: async (s) => at(s) && empty(await s.usage()),
      mail: (s) => withSender(setupTrackMail(s.to ?? '', stage, s.daysLeft ?? 0)),
    });
    steps.push({
      id: `trial.value.${stage}.holdings`,
      key,
      due: async (s) => {
        if (!at(s)) return false;
        const u = await s.usage();
        return !empty(u) && holdingsOf(u) !== null;
      },
      mail: async (s) => withSender(valueTrackMail(s.to ?? '', stage, s.daysLeft ?? 0, await s.usage())),
    });
    steps.push({
      id: `trial.value.${stage}.plain`,
      key,
      due: async (s) => {
        if (!at(s)) return false;
        const u = await s.usage();
        return !empty(u) && holdingsOf(u) === null;
      },
      mail: async (s) => withSender(valueTrackMail(s.to ?? '', stage, s.daysLeft ?? 0, await s.usage())),
    });
  }
  steps.push({
    id: 'trial.setup.nudge',
    key: 'trial.nudge',
    due: async (s) => {
      if (!nudgeDue(s.daysLeft)) return false;
      const u = await s.usage();
      return !!u && u.sessions === 0;
    },
    mail: (s) => withSender(setupTrackMail(s.to ?? '', 'nudge', s.daysLeft ?? 0)),
  });
  return steps;
}

/**
 * Every tenant on a no-card trial, with its owner's address.
 *
 * `loadUsage` is read lazily and once for each tenant in a sweep: only a
 * tenant inside a stage's window costs a query.
 */
export async function* trialSubjects(
  now: Date,
  loadUsage: (tenant: string) => Promise<TrialUsage | null> = loadTrialUsage,
): AsyncGenerator<TrialSubject> {
  const cp = await createControlPlane();
  try {
    for (const tenant of await cp.listTenants()) {
      const ent = await cp.getEntitlement(tenant);
      if (!isNoCardTrial(ent)) continue;
      let usage: Promise<TrialUsage | null> | undefined;
      yield {
        id: tenant,
        tenant,
        to: await ownerEmail(cp, tenant),
        daysLeft: trialDaysLeft(ent, now.getTime()),
        usage: () => (usage ??= loadUsage(tenant)),
      };
    }
  } finally {
    await cp.close();
  }
}

export interface TrialReminderOptions {
  /** The Postgres pool for `lifecycle_mail`. Default: this server's primary pool. */
  pool?: LifecyclePool;
  /** The tenant's counts. Default: `loadTrialUsage`. */
  loadUsage?: (tenant: string) => Promise<TrialUsage | null>;
}

/**
 * The trial reminder scheduler, or null when this build cannot send one.
 *
 * Null without `@munhq/product-kit/lifecycle`, and null without a Postgres
 * URL, because the claims live in this server's Postgres.
 */
export async function trialReminders(opts: TrialReminderOptions = {}): Promise<Lifecycle | null> {
  await loadProductKit();
  const kit = lifecycleKit();
  if (!kit) {
    log.info('trial reminders: this build has no @munhq/product-kit lifecycle, so none are scheduled');
    return null;
  }
  let pool = opts.pool;
  if (!pool) {
    if (!process.env.DATABASE_URL && !process.env.CHAT_RECALL_DATABASE_URL) {
      log.warn('trial reminders: no DATABASE_URL, and the claims live in Postgres, so none are scheduled');
      return null;
    }
    const { openPgPool } = await import('@chat-recall/engine/core/store/pg-pool.js');
    pool = (await openPgPool()) as LifecyclePool;
  }
  const loadUsage = opts.loadUsage ?? loadTrialUsage;
  return kit.lifecycle<TrialSubject>({
    pool,
    product: 'chat-recall',
    killSwitch: 'TRIAL_REMINDERS',
    subjects: (now) => trialSubjects(now, loadUsage),
    steps: trialSteps(),
    logger: {
      info: (o, m) => log.info(o, m),
      warn: (o, m) => log.warn(o, m),
      error: (o, m) => log.error(o, m),
    },
  });
}

/** Start the hourly sweep, on the role that runs workers. */
export async function startTrialReminders(): Promise<void> {
  const scheduler = await trialReminders();
  scheduler?.start();
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
