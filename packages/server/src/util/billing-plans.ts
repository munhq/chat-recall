/**
 * The billing plan catalogue.
 *
 * WHY THIS EXISTS: checkout used to hardcode one line item —
 * `[{ price: STRIPE_PRICE_ID, quantity: 1 }]`. That sells exactly one plan at
 * exactly one seat, while the pricing page advertised two plans and a per-seat
 * price. Anyone who clicked "Team" bought Solo. Annual pricing was impossible
 * for the same reason: a second interval is a second price id, and there was
 * nowhere to put it.
 *
 * WHAT IT DOES NOT DO: hold amounts. The original design constraint stands —
 * Stripe owns the catalogue, this file owns the *mapping* from a plan key the
 * client may ask for to a Stripe price id and its seat rules. Amounts are read
 * back from Stripe (`prices.retrieve`) so a price change in the dashboard needs
 * no deploy, and so an amount can never drift between our copy and the charge.
 *
 * CONFIG — `BILLING_PLANS`, a JSON array in env:
 *
 *   [{"key":"solo-monthly","label":"Solo","priceId":"price_...","seats":"fixed"},
 *    {"key":"solo-yearly", "label":"Solo (yearly)","priceId":"price_...","seats":"fixed"},
 *    {"key":"team-monthly","label":"Team","priceId":"price_...","seats":"per_seat","minSeats":2,"maxSeats":50},
 *    {"key":"enterprise",  "label":"Enterprise","contact":"sales@munhq.com"}]
 *
 * A plan with `contact` and no `priceId` is deliberately NOT self-serve: the
 * checkout route refuses it and hands back the address. Enterprise deals are
 * negotiated, and a "buy now" button on one is a support ticket, not a sale.
 */

export type SeatMode = 'fixed' | 'per_seat';

export interface PlanDef {
  /** Stable id the client sends to /checkout. Never shown to a user. */
  key: string;
  /** Human label, echoed to the pricing UI so copy lives in one place. */
  label: string;
  /** Stripe price id. Absent ⇒ contact-only (see `contact`). */
  priceId?: string;
  /** 'fixed' forces quantity 1; 'per_seat' bills quantity × unit price. */
  seats: SeatMode;
  minSeats?: number;
  maxSeats?: number;
  /** Contact address for a plan that is not self-serve. */
  contact?: string;
}

/** A plan resolved and ready to become a Stripe line item. */
export interface ResolvedLine {
  plan: PlanDef;
  quantity: number;
}

export type PlanError =
  | { code: 'unknown_plan'; message: string }
  | { code: 'contact_only'; message: string; contact: string }
  | { code: 'bad_seats'; message: string };

/**
 * Parse `BILLING_PLANS`. Malformed JSON must never take the server down — a
 * typo in an env var is an operator mistake, and crash-looping the API is a
 * worse outcome than falling back. So this returns [] and the caller degrades
 * to the legacy single-price path.
 */
export function planCatalogue(): PlanDef[] {
  const raw = process.env.BILLING_PLANS;
  if (!raw || !raw.trim()) return legacyCatalogue();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately not fatal. See above.
    return legacyCatalogue();
  }
  if (!Array.isArray(parsed)) return legacyCatalogue();

  const plans: PlanDef[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const key = typeof o.key === 'string' ? o.key.trim() : '';
    if (!key) continue;

    const priceId = typeof o.priceId === 'string' && o.priceId.trim() ? o.priceId.trim() : undefined;
    const contact = typeof o.contact === 'string' && o.contact.trim() ? o.contact.trim() : undefined;
    // A plan with neither is unusable — it can be neither bought nor enquired
    // about — so drop it rather than surface a dead button.
    if (!priceId && !contact) continue;

    const seats: SeatMode = o.seats === 'per_seat' ? 'per_seat' : 'fixed';
    plans.push({
      key,
      label: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : key,
      priceId,
      contact,
      seats,
      minSeats: numOrUndef(o.minSeats),
      maxSeats: numOrUndef(o.maxSeats),
    });
  }
  return plans.length ? plans : legacyCatalogue();
}

/**
 * The pre-catalogue behaviour, preserved: a single fixed-seat plan built from
 * STRIPE_PRICE_ID. This is what keeps an existing deployment (and the existing
 * tests) working after this change with no config edit at all.
 */
function legacyCatalogue(): PlanDef[] {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) return [];
  return [{ key: 'default', label: 'Subscription', priceId, seats: 'fixed' }];
}

function numOrUndef(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Look a plan up by key. `undefined` key ⇒ the first self-serve plan, which
 *  preserves "POST /checkout with no body" from before the catalogue existed. */
export function findPlan(key?: string | null): PlanDef | null {
  const all = planCatalogue();
  if (!all.length) return null;
  if (!key) return all.find((p) => p.priceId) ?? all[0];
  return all.find((p) => p.key === key) ?? null;
}

/**
 * Turn a requested plan + seat count into a Stripe line item, or an error.
 *
 * `memberCount` is the tenant's ACTUAL member count. Seats are validated
 * against it because the client is untrusted: without this check a ten-person
 * team buys two seats and every member keeps full access, which is not a
 * pricing model, it is an honour system. Buying MORE seats than members is
 * allowed — teams grow, and pre-paying for headroom is legitimate.
 */
export function resolveLine(
  key: string | null | undefined,
  requestedSeats: unknown,
  memberCount: number,
): ResolvedLine | PlanError {
  const plan = findPlan(key);
  if (!plan) {
    return { code: 'unknown_plan', message: key ? `unknown plan '${key}'` : 'no plans configured' };
  }
  if (!plan.priceId) {
    return {
      code: 'contact_only',
      message: `${plan.label} is not self-serve — contact ${plan.contact}`,
      contact: plan.contact as string,
    };
  }

  // Fixed-seat plans ignore any seat count the client sends. Honouring it would
  // let a caller multiply a flat price by an arbitrary quantity.
  if (plan.seats === 'fixed') return { plan, quantity: 1 };

  const min = Math.max(1, plan.minSeats ?? 1, memberCount);
  const asked = requestedSeats === undefined || requestedSeats === null ? min : Number(requestedSeats);

  if (!Number.isFinite(asked) || !Number.isInteger(asked) || asked < 1) {
    return { code: 'bad_seats', message: 'seats must be a positive integer' };
  }
  if (asked < min) {
    const why =
      memberCount > (plan.minSeats ?? 1)
        ? `the team already has ${memberCount} member(s)`
        : `this plan starts at ${plan.minSeats ?? 1} seat(s)`;
    return { code: 'bad_seats', message: `at least ${min} seats — ${why}` };
  }
  if (plan.maxSeats && asked > plan.maxSeats) {
    return {
      code: 'bad_seats',
      message: `${plan.label} tops out at ${plan.maxSeats} seats — contact us for more`,
    };
  }
  return { plan, quantity: asked };
}

/** Narrow a resolveLine() result. */
export function isPlanError(r: ResolvedLine | PlanError): r is PlanError {
  return (r as PlanError).code !== undefined;
}

/**
 * Trial length. Dropped from 14 to 7 days: a card-required trial converts on
 * intent, not on time, and a shorter window means the charge lands while the
 * product is still fresh in mind — which is the single biggest lever on
 * "I don't recognise this charge" disputes.
 */
export function trialDays(): number {
  return Number(process.env.STRIPE_TRIAL_DAYS) || 7;
}
