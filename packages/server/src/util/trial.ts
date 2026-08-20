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
 *     contact. FREE_TRIAL_DAYS (default 14) sets the length.
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

/** Trial length in days. FREE_TRIAL_DAYS, default 14.
 *
 *  14 rather than 7 because the product's value accrues as sessions accumulate:
 *  a week is not long enough for a user's own history to become the reason they
 *  stay. Read live from env so the length is a config change, not a deploy. */
export function trialLengthDays(): number {
  const n = Number(process.env.FREE_TRIAL_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 14;
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
 * Rounded UP so a trial with six hours left reads as "1 day left" and not as
 * "0 days left" to a user who still has access.
 */
export function trialDaysLeft(ent: Entitlement | null | undefined, now = Date.now()): number | null {
  if (!ent || ent.currentPeriodEnd == null) return null;
  return Math.max(0, Math.ceil((ent.currentPeriodEnd - now) / DAY_MS));
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
  cp: Pick<ControlPlane, 'getEntitlement' | 'setEntitlement'>,
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
