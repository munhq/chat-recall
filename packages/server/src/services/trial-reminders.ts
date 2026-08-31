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
import { isNoCardTrial, trialDaysLeft } from '../util/trial.js';
import { compose, type Block } from '../auth/mail-template.js';

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

/** Shared closing: the honest alternative to paying us. Naming it costs a few
 *  subscriptions and buys the credibility that makes the rest of the message
 *  believable — a product that hides its free path is not trusted about anything
 *  else it says. */
const SELF_HOST_FOOTER: Block[] = [
  {
    kind: 'small',
    text: 'Prefer to keep it on your own hardware? Running chat-recall yourself is free forever for one person, with every feature and no licence key.',
  },
  { kind: 'links', items: [{ label: 'Self-host chat-recall', url: SELF_HOST_URL }] },
];

const INSTALL_BLOCKS: Block[] = [
  { kind: 'code', lines: ['npx chat-recall init'] },
  {
    kind: 'p',
    text: 'It finds the transcripts Claude Code, Codex, Gemini CLI, Cursor, OpenCode and Antigravity already wrote to your disk, shows you exactly what would upload, and waits for a yes. Secrets are masked before anything leaves the machine, and project paths are sent as hashes.',
  },
];

/**
 * The SETUP track: a trial where nothing was ever synced.
 *
 * It sells nothing, because there is nothing to sell yet — the reader has not
 * seen the product work, so a price is an unanswerable question. It does exactly
 * two things: give the one command, and offer to restart the clock. The offer is
 * real and a person honours it by hand; at this scale that is cheaper than
 * losing every user who got stuck at install.
 */
function setupTrackMail(to: string, stage: ReminderStage, daysLeft: number) {
  const account: Block = { kind: 'links', items: [{ label: 'Your account', url: ACCOUNT_URL }] };

  if (stage === 'ended') {
    return compose({
      to,
      subject: 'Your chat-recall trial ended before it started',
      preheader: 'Reply and I will give you a fresh one. No conditions, no card.',
      blocks: [
        { kind: 'lead', text: 'Your trial has ended, and no sessions ever reached the server.' },
        { kind: 'p', text: 'So you never saw the thing you signed up for. That is not a trial you declined. It is one that never ran, and I would rather fix it than let it lapse quietly.' },
        { kind: 'p', text: 'The offer is open: reply to this message and I will give you a fresh trial, starting the day you are set up. No conditions, and no card.' },
        { kind: 'p', text: 'If you would rather just do it now, it is one command:' },
        ...INSTALL_BLOCKS,
        { kind: 'p', text: 'And if chat-recall was simply not what you expected, I would still like to know what you were hoping for. Reply and tell me. It is the most useful mail I get.' },
        account,
      ],
      footer: SELF_HOST_FOOTER,
    });
  }

  if (stage === 'final') {
    return compose({
      to,
      subject: 'One command left on your chat-recall trial',
      preheader: 'Nothing has synced yet, and I will happily restart the clock.',
      blocks: [
        { kind: 'lead', text: `Your trial ends ${daysLeft === 1 ? 'tomorrow' : `in ${n(daysLeft)} days`}, and nothing has synced yet.` },
        { kind: 'p', text: 'Which means you have not actually seen what you signed up to try. Two ways to fix that, and either is fine by me.' },
        { kind: 'p', text: 'The first is one command:' },
        ...INSTALL_BLOCKS,
        { kind: 'p', text: 'The second: reply to this message and I will restart your trial from the day you get set up. A trial nobody managed to run is not a fair test of anything.' },
        account,
      ],
    });
  }

  return compose({
    to,
    subject: 'Your chat-recall account is empty. This is the one command',
    preheader: 'The history is already on your disk. It has just never been searchable.',
    blocks: [
      { kind: 'lead', text: 'Your account is live, but nothing has synced yet.' },
      { kind: 'p', text: 'So there is nothing for chat-recall to recall. That is one command away:' },
      ...INSTALL_BLOCKS,
      { kind: 'p', text: 'The first sync is usually the surprising part. The history is already on your disk (often months of it), and it has simply never been searchable. Once it is, ask your agent:' },
      { kind: 'quote', text: 'What was I working on last week?' },
      { kind: 'p', text: `You have ${n(daysLeft)} ${plural(daysLeft, 'day')} left, and an empty account is a poor way to spend them. If something blocked you, reply to this message. A person reads it, and I will happily restart the clock so you get a fair look.` },
      account,
    ],
  });
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
 * It names no numbers it cannot prove, and it must not promise more than the
 * server delivers. Until 2026-08-25 this said the synced history stayed
 * searchable after the trial; it does not any more, and a reassurance the
 * product then contradicts is worse than the plain fact.
 */
function valueTrackMail(to: string, stage: ReminderStage, daysLeft: number, usage?: TrialUsage | null) {
  const h = holdingsOf(usage);
  const yoursLong = h ? `your ${h.long}` : 'your synced history';
  const yoursShort = h ? `your ${h.short}` : 'your synced history';
  const account: Block = { kind: 'links', items: [{ label: 'See your account and days left', url: ACCOUNT_URL }] };

  if (stage === 'ended') {
    return compose({
      to,
      subject: 'Your chat-recall trial has ended. Syncing has stopped',
      preheader: 'Nothing was deleted. One command brings it all back.',
      blocks: [
        { kind: 'lead', text: 'Your chat-recall trial has ended.' },
        { kind: 'p', text: 'Searches stop answering, and new sessions are no longer syncing.' },
        ...(h ? [{ kind: 'stats' as const, text: `What is still true: the server still holds ${yoursLong}.`, items: h.figures }] : []),
        { kind: 'p', text: h ? 'All of it is still on the server. Nothing is deleted, and export works whenever you want it.' : `What is still true: the server still holds ${yoursLong}. Nothing is deleted, and export works whenever you want it.` },
        { kind: 'p', text: 'Turning it back on is one click and one command:' },
        { kind: 'cta', label: 'Subscribe and resume syncing', url: UPGRADE_URL },
        { kind: 'code', lines: ['chat-recall sync --full'] },
        { kind: 'p', text: 'Everything your tools wrote while the trial was over is still on your own disk, so that second step catches the server up completely. You lost nothing by pausing, and you would lose nothing by waiting longer.' },
        { kind: 'p', text: 'If chat-recall was not right for you, that is genuinely fine, but reply and tell me what was missing. It is the most useful mail I get.' },
      ],
      footer: SELF_HOST_FOOTER,
    });
  }

  if (stage === 'final') {
    return compose({
      to,
      subject: h && daysLeft === 1
        ? `Tomorrow: ${h.short} ${h.verb} being searchable`
        : `${n(daysLeft)} ${plural(daysLeft, 'day')} left on your chat-recall trial`,
      preheader: 'Reversible at any point. Your transcripts never left your disk.',
      blocks: [
        { kind: 'lead', text: `Your chat-recall trial ends ${daysLeft === 1 ? 'tomorrow' : `in ${n(daysLeft)} days`}.` },
        { kind: 'p', text: `Then: searches stop answering, and new sessions stop syncing. Nothing is deleted, the server keeps ${yoursShort}, and export keeps working.` },
        { kind: 'p', text: 'This is reversible at any point, which is the part worth knowing before you decide. Your transcripts are still on your own disk, so one command brings the server current the day you subscribe:' },
        { kind: 'code', lines: ['chat-recall sync --full'] },
        { kind: 'p', text: 'You lose no history by taking another week to think about it. You lose only the searching.' },
        { kind: 'cta', label: 'Keep recall running', url: UPGRADE_URL },
        account,
      ],
      footer: SELF_HOST_FOOTER,
    });
  }

  return compose({
    to,
    subject: h
      ? `${n(daysLeft)} days left, and ${h.short} on the server`
      : `${n(daysLeft)} days left on your chat-recall trial`,
    preheader: h
      ? `That is what stops being searchable in ${n(daysLeft)} days.`
      : 'What stops, what does not, and how to keep it.',
    blocks: [
      ...(h
        ? [
            { kind: 'lead' as const, text: `In ${n(daysLeft)} days, this stops being searchable.` },
            { kind: 'stats' as const, text: `chat-recall has indexed ${h.long}.`, items: h.figures },
          ]
        : [
            { kind: 'lead' as const, text: `Your chat-recall trial ends in ${n(daysLeft)} days.` },
            { kind: 'p' as const, text: 'The longer it runs the more of your own history it can reach, so this is usually the point where it starts earning its place.' },
          ]),
      { kind: 'p', text: 'What changes: recall switches off. Searches stop answering, and new sessions stop syncing.' },
      { kind: 'p', text: 'What does not: nothing is deleted, your history stays on the server, and export keeps working.' },
      { kind: 'p', text: 'The part worth paying for is the one that is hard to notice while it works. You stop re-explaining a repository to a fresh agent. You stop hunting for the decision you made six weeks ago. You ask, and the answer is already there.' },
      { kind: 'cta', label: 'Keep recall running', url: UPGRADE_URL },
      account,
    ],
    footer: SELF_HOST_FOOTER,
  });
}

/**
 * The reminder copy for one tenant at one stage.
 *
 * `usage` decides the track. Undefined or null means "could not read it", which
 * takes the value track without numbers — never the setup track, because telling
 * an active user their account is empty is the one mistake here that destroys
 * trust outright.
 */
export function trialReminderMail(
  to: string,
  stage: ReminderStage,
  daysLeft: number,
  usage?: TrialUsage | null,
) {
  if (usage && usage.sessions === 0) return setupTrackMail(to, stage, daysLeft);
  return valueTrackMail(to, stage, daysLeft, usage);
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
      if (!isNoCardTrial(ent)) continue;
      onTrial++;

      const left = trialDaysLeft(ent, now);
      const stage = reminderStage(left);
      if (!stage) continue;

      const key = `trial_reminder_${stage}`;
      if (await cp.getTenantSetting(tenant, key)) continue;   // already sent

      const to = await ownerEmail(cp, tenant);
      if (!to) continue;

      // Read AFTER the already-sent guard: no point costing a query for a tenant
      // that is not going to be written to.
      const usage = await loadTrialUsage(tenant);

      const res = await sendMail(trialReminderMail(to, stage, left ?? 0, usage));
      if (!res.sent && res.reason === 'send-failed') {
        log.warn({ tenant, stage }, 'trial reminder send failed; will retry');
        continue;
      }
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
