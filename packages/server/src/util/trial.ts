/**
 * The no-card trial — how a tenant reaches the paid surface for the first time.
 *
 * ── Why a trial and not a beta flag ─────────────────────────────────────────
 *
 * This replaces OPEN_BETA, which granted access by making isEntitled() return
 * true before it read anything. That had two costs. It gave away the paid tier
 * with no end date, no reminder and no moment where anyone is asked to pay; and
 * because the gate short-circuited, the paid path never executed in production,
 * so every entitlement defect stayed invisible until the flag came off.
 *
 * A trial fixes both. Access is granted by a real entitlement row, so the gate
 * runs the same code for a trial user, a subscriber and a lapsed tenant — the
 * paid path is under test from the first request. And the row carries an end
 * date, which is what makes reminders and conversion possible at all.
 *
 * ── The rules ──────────────────────────────────────────────────────────────
 *
 *   - A tenant with no entitlement history gets one trial, dated from first
 *     contact. FREE_TRIAL_DAYS (default 7) sets the length.
 *   - The trial's plan is 'trial', which maps to the SOLO feature set. It was null
 *     at first, and that was a mistake: a null plan resolves to the free set, so the
 *     trial demonstrated none of the product it exists to sell. 'trial' does not
 *     begin with 'team', so collaboration stays paid — the same rule that applies to
 *     a Solo subscriber.
 *   - The row's EXISTENCE is the record that a trial was already given. A lapsed
 *     or cancelled tenant therefore never receives a second one, without needing
 *     a separate "has_trialed" column.
 *   - A trial is distinguishable from a Stripe card trial by having no
 *     subscription id. Only the no-card kind is reminded and expired by us;
 *     Stripe owns the lifecycle of the other.
 */
import type { ControlPlane, Entitlement } from '../imports.js';

const DAY_MS = 86_400_000;

/** Trial length in days. FREE_TRIAL_DAYS, default 7.
 *
 *  7, and the default matters: the pricing page, the pricing FAQ, llms.txt and
 *  the published TERMS all state seven days. A default of 14 meant a deployment
 *  that simply did not set the variable granted twice what the terms promise,
 *  which is the one drift here with a legal edge rather than a cosmetic one.
 *
 *  The argument for 14 was that value accrues as sessions accumulate. The free
 *  tier answers that better than a longer trial does: when the trial ends the
 *  account keeps syncing and keeps its recent history, so the accumulation
 *  continues without a countdown. Read live from env so the length stays a
 *  config change, not a deploy. */
export function trialLengthDays(): number {
  const n = Number(process.env.FREE_TRIAL_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 7;
}

/**
 * A trial WE granted, as opposed to a Stripe trial that already has a card
 * behind it. Only this kind is ours to remind about and expire; Stripe drives
 * the other one through webhooks.
 */
export function isNoCardTrial(ent: Entitlement | null | undefined): boolean {
  return !!ent && ent.status === 'trialing' && !ent.stripeSubscriptionId;
}

/**
 * Whole days remaining, never negative. null when the entitlement carries no end
 * date (a Stripe trial Stripe has not dated yet), which callers must treat as
 * "no deadline known" rather than as expired.
 *
 * Rounded DOWN, except on the final day. See the note in the body.
 */
export function trialDaysLeft(ent: Entitlement | null | undefined, now = Date.now()): number | null {
  if (!ent || ent.currentPeriodEnd == null) return null;
  const ms = ent.currentPeriodEnd - now;
  if (ms <= 0) return 0;
  // FLOOR, not ceil. Ceil rounded 13.05 days up to "14 days left" on a 14-day
  // trial that started yesterday, so the banner read exactly as it had on day
  // zero and the trial looked stopped. Floor states the days you can still
  // count on.
  //
  // The last day is the exception: flooring alone shows "0 days left" for the
  // final 24 hours, while access is still live. Anything under a day reports 1.
  return Math.max(1, Math.floor(ms / DAY_MS));
}

/**
 * Return the entitlement in force for a tenant, granting the trial when the
 * tenant has no entitlement history at all.
 *
 * Provisioning lazily on read (rather than at signup) is deliberate: it covers
 * tenants that already existed before trials did, with no migration and no
 * backfill job. Their trial starts the first time they are seen, which is the
 * generous reading — nobody loses days to a deploy date.
 *
 * Concurrent first requests are safe: setEntitlement upserts on the tenant key,
 * so two racing grants converge on one row rather than duplicating it.
 */
export async function ensureTrial(
  cp: Pick<ControlPlane, 'getEntitlement' | 'setEntitlement'> & Partial<Pick<ControlPlane, 'hasVerifiedMember'>>,
  tenant: string,
  now = Date.now(),
): Promise<Entitlement | null> {
  const existing = await cp.getEntitlement(tenant);
  // Any row at all means this tenant has already had its trial. Do NOT re-grant
  // on a lapsed or cancelled row, or the trial would renew itself forever.
  //
  // One exception, and only one: a LIVE trial whose plan is null. Trials were
  // first written with plan=null, which resolves to the free set — so those
  // tenants spent their trial on memory+scan, and the first call needing sync
  // or findings answered 402. Writing plan='trial' below fixed new rows and did
  // nothing for existing ones, because of the early return directly above.
  //
  // This repairs the plan and NOTHING else: no new end date, no status change,
  // so it cannot extend or re-grant a trial. It is scoped to status==='trialing'
  // with a null plan, which a lapsed or cancelled row can never match.
  if (existing) {
    const live = existing.currentPeriodEnd == null || existing.currentPeriodEnd > now;
    if (existing.status === 'trialing' && existing.plan == null && live) {
      await cp.setEntitlement(tenant, { plan: 'trial' });
      return cp.getEntitlement(tenant);
    }
    return existing;
  }

  // No trial until an address is confirmed. This is the anti-abuse gate, and it
  // sits HERE rather than on sign-in: better-auth's requireEmailVerification
  // blocks the first login, so a single flaky SMTP send locks a new user out of
  // an account they just made. Blocking the trial instead costs an unconfirmed
  // visitor nothing they can see — they can sign in and look around — while
  // withholding the only thing that spends money: ingest, embeddings, summaries.
  //
  // Only ever gates a NEW grant. An existing trial is returned above untouched,
  // so this can never revoke one already running.
  //
  // hasVerifiedMember is optional on the passed shape, and absent means "do not
  // gate": the test doubles and the self-host control plane have no auth tables
  // to ask, and denying every trial there would be a worse failure than the
  // abuse this prevents.
  if (cp.hasVerifiedMember && !(await cp.hasVerifiedMember(tenant))) return null;

  await cp.setEntitlement(tenant, {
    status: 'trialing',
    // 'trial', NOT null. A null plan resolves to the FREE feature set, so a trial
    // granted nothing beyond memory and the scan verdict — it demonstrated none of
    // the product it exists to sell. 'trial' maps to the Solo set in PLAN_FEATURES,
    // and it deliberately does not begin with 'team', so collaboration stays paid.
    plan: 'trial',
    currentPeriodEnd: now + trialLengthDays() * DAY_MS,
  });
  return cp.getEntitlement(tenant);
}
