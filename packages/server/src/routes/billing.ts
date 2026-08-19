/**
 * /api/billing — Stripe subscription lifecycle for the cloud edition.
 *
 *   POST /api/billing/checkout   → create a Stripe Checkout Session (subscription
 *                                  mode) for the caller's tenant; returns { url }.
 *                                  Body: { plan?: string, seats?: number }.
 *   POST /api/billing/webhook    → Stripe → us: verify signature, map subscription
 *                                  events onto the tenant's entitlement row.
 *   GET  /api/billing/plans      → PUBLIC catalogue with live Stripe amounts.
 *
 * Design constraints:
 *   - Pricing is NEVER hardcoded. Plan keys map to Stripe price ids via
 *     BILLING_PLANS (see util/billing-plans.ts); amounts are read back from
 *     Stripe. This file never sees an amount; Stripe owns the catalog.
 *   - Seats are validated SERVER-SIDE against the tenant's real member count.
 *     A client-supplied seat count is a discount request, not a fact.
 *   - The Stripe client is LAZY: constructed only when STRIPE_SECRET_KEY is set,
 *     so the server boots (and self-host runs) with Stripe entirely absent.
 *   - The webhook uses a RAW body (signature is over the exact bytes); the route
 *     mounts its own express.raw parser so the global json parser doesn't eat it.
 *   - The event→entitlement mapping is factored into the pure, exported
 *     `applyStripeEvent` so it's unit-testable without signature verification.
 *
 * Env the operator must provide to go live (cloud):
 *   STRIPE_SECRET_KEY      — secret API key (sk_live_… / sk_test_…). Presence of
 *                            this flips billingEnabled() on (see util/billing.ts).
 *   STRIPE_PRICE_ID        — the recurring price the checkout subscribes to.
 *   STRIPE_WEBHOOK_SECRET  — endpoint signing secret (whsec_…) for verification.
 *   STRIPE_SUCCESS_URL     — redirect after successful checkout.
 *   STRIPE_CANCEL_URL      — redirect if the user backs out.
 */
import express from 'express';
import type Stripe from 'stripe';
import { createControlPlane, type EntitlementStatus } from '../imports.js';
import { requireUser } from '../middleware/auth.js';
import { billingEnabled, openBeta } from '../util/billing.js';
import { planCatalogue, resolveLine, isPlanError, trialDays } from '../util/billing-plans.js';

const router = express.Router();

// ── Lazy Stripe client ──────────────────────────────────────────────────
// Constructed on first use, only when STRIPE_SECRET_KEY is set. Cached so we
// don't re-import the SDK per request. Returns null when billing is off, which
// every caller treats as "billing not configured" (501/402) rather than
// crashing — this is what lets the server module import with no Stripe env.
let _stripe: Stripe | null = null;
let _stripeLoaded = false;
async function getStripe(): Promise<Stripe | null> {
  if (!billingEnabled()) return null;
  if (_stripeLoaded) return _stripe;
  const { default: StripeCtor } = await import('stripe');
  _stripe = new StripeCtor(process.env.STRIPE_SECRET_KEY as string);
  _stripeLoaded = true;
  return _stripe;
}

/** Test seam: drop the cached client so an env change between tests is honored. */
export function _resetStripeForTests(): void {
  _stripe = null;
  _stripeLoaded = false;
}

// ── Pure event → entitlement mapping (unit-testable, no Stripe/signature) ──

/** Minimal shape of the Stripe events we act on. We read these fields off the
 *  real `Stripe.Event` at runtime; the loose typing here keeps the pure mapper
 *  callable from tests with a hand-built fixture. */
interface StripeLikeEvent {
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * Which plan the customer actually bought.
 *
 * Read from the subscription metadata /checkout stamps (metadata.plan = the
 * catalogue key), else the line item's price id, else the legacy env var.
 *
 * This was process.env.STRIPE_PRICE_ID unconditionally, which recorded the same
 * value for every customer — and with a BILLING_PLANS catalogue that var is
 * usually unset, so it recorded null. The entitlement therefore could not tell a
 * Solo subscriber from a Team one, and the invite gate (which only checks
 * status) let a Solo subscriber add teammates for free.
 */
function planOf(o: Record<string, unknown>): string | null {
  const md = (o.metadata ?? null) as Record<string, unknown> | null;
  if (md && typeof md.plan === 'string' && md.plan) return md.plan;
  const items = ((o.items as Record<string, unknown> | undefined)?.data ?? []) as Array<Record<string, unknown>>;
  const price = items[0]?.price as Record<string, unknown> | undefined;
  if (price && typeof price.id === 'string') return price.id;
  return process.env.STRIPE_PRICE_ID ?? null;
}

/**
 * Whether a recorded plan grants COLLABORATION on the hosted service.
 *
 * Team keys match by prefix so a new team price needs no code change. A null or
 * unrecognised plan is NOT team — fail closed, since the alternative gives team
 * away for the price of Solo.
 */
export function planGrantsTeam(plan: string | null | undefined): boolean {
  if (!plan) return false;
  const p = plan.toLowerCase();
  if (p.startsWith('team') || p.startsWith('enterprise')) return true;
  const match = planCatalogue().find((c) => c.priceId === plan);
  return !!match && match.seats === 'per_seat';
}

/** Map Stripe's subscription `status` string onto our EntitlementStatus.
 *  Anything we don't recognize collapses to 'none' (fail-closed: not entitled). */
function mapSubStatus(s: unknown): EntitlementStatus {
  switch (s) {
    case 'active': return 'active';
    case 'trialing': return 'trialing';
    case 'past_due': return 'past_due';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'none';
  }
}

/**
 * Stripe gives period end in SECONDS; we store epoch MILLIS everywhere.
 *
 * Stripe MOVED this field. `current_period_end` no longer exists on the
 * subscription object — it lives on each subscription ITEM (items.data[i]) —
 * so reading only the top level recorded null for every subscription. That
 * matters because isEntitled() treats a null period as "no expiry known, still
 * valid", so a lapsed subscription whose status write was missed would stay
 * entitled indefinitely.
 *
 * Order: top level first (older API versions and any object that still carries
 * it), then the first item, then trial_end — during a trial the item period and
 * trial_end coincide, and trial_end is the one guaranteed to be present.
 */
function periodEndMs(o: Record<string, unknown>): number | null {
  const top = o.current_period_end;
  if (typeof top === 'number') return top * 1000;
  const items = ((o.items as Record<string, unknown> | undefined)?.data ?? []) as Array<Record<string, unknown>>;
  const fromItem = items[0]?.current_period_end;
  if (typeof fromItem === 'number') return fromItem * 1000;
  const trial = o.trial_end;
  return typeof trial === 'number' ? trial * 1000 : null;
}

/** The tenant we're billing is carried as `client_reference_id` on the checkout
 *  session and mirrored into subscription `metadata.tenant` so later
 *  subscription.* events (which have no client_reference_id) can still resolve
 *  it. Returns null when we can't determine the tenant — caller skips the write
 *  rather than guessing. */
function tenantOf(o: Record<string, unknown>): string | null {
  if (typeof o.client_reference_id === 'string' && o.client_reference_id) return o.client_reference_id;
  const meta = o.metadata;
  if (meta && typeof meta === 'object' && typeof (meta as Record<string, unknown>).tenant === 'string') {
    const t = (meta as Record<string, unknown>).tenant as string;
    if (t) return t;
  }
  return null;
}

const asStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Apply a Stripe event to the control plane's entitlement store. Pure w.r.t.
 * Stripe: takes an already-parsed event and a control plane, performs the
 * `setEntitlement` upsert, and returns what it did (or null if ignored / no
 * tenant). Exported so tests can drive it directly with a fake event.
 *
 * Handled:
 *   checkout.session.completed     → first activation (records customer + sub).
 *   customer.subscription.updated  → status / period changes (renew, past_due…).
 *   customer.subscription.deleted  → cancellation.
 */
export async function applyStripeEvent(
  event: StripeLikeEvent,
  cp: { setEntitlement(tenant: string, e: Record<string, unknown>): Promise<void> },
): Promise<{ tenant: string; status: EntitlementStatus } | null> {
  const o = event.data.object;
  const tenant = tenantOf(o);
  if (!tenant) return null;

  switch (event.type) {
    case 'checkout.session.completed': {
      // IDS ONLY — no status, no period. PLUS the plan, when the session states
      // it outright (see the stamped-metadata note below).
      //
      // Both this and customer.subscription.created fire for one purchase and the
      // later write wins, so anything this event guesses can erase what the
      // subscription event knows. It guessed badly: it hardcoded status 'active',
      // which overwrote the accurate 'trialing' and told a trialing customer they
      // were paying; and a session carries no items[] and no trial_end, so its
      // period was always null and erased the real one.
      //
      // Observed ordering (stripe listen, repeatedly): subscription.created
      // arrives FIRST, then this. Even were it reversed, the subscription event
      // follows within milliseconds and carries status, plan and period together.
      // So this event contributes only the two ids, and ordering stops mattering.
      // A read-before-write was tried instead and returned null in the webhook
      // context, silently reintroducing the clobber — hence no read at all.
      //
      // The plan is the exception, and it must be written here. It is not a
      // guess: /checkout stamps metadata.plan onto the SESSION for exactly this
      // reason, so the value is the catalogue key the customer chose.
      //
      // Recording it here is what makes the plan independent of the webhook
      // endpoint's event subscription. customer.subscription.created is the only
      // other event that carries a plan, so if an endpoint is not subscribed to
      // it, the entitlement keeps plan=NULL — and a NULL plan is not team, which
      // denies collaboration to a paying Team customer. Writing it from both
      // events is harmless (same value); writing it from neither is an outage.
      //
      // Read metadata.plan DIRECTLY, not via planOf(): a session carries no
      // items[], so planOf() would fall through to process.env.STRIPE_PRICE_ID
      // and could overwrite a correct plan with a stale global default.
      const stamped = (o.metadata ?? null) as Record<string, unknown> | null;
      const plan = stamped && typeof stamped.plan === 'string' && stamped.plan
        ? stamped.plan
        : undefined;   // undefined, so mergeEntitlement preserves what is there
      await cp.setEntitlement(tenant, {
        ...(plan === undefined ? {} : { plan }),
        stripeCustomerId: asStr(o.customer),
        stripeSubscriptionId: asStr(o.subscription),
      });
      return { tenant, status: 'active' as EntitlementStatus };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const status = mapSubStatus(o.status);
      await cp.setEntitlement(tenant, {
        status,
        plan: planOf(o),
        currentPeriodEnd: periodEndMs(o),
        stripeCustomerId: asStr(o.customer),
        stripeSubscriptionId: asStr(o.id),
      });
      return { tenant, status };
    }
    case 'customer.subscription.deleted': {
      await cp.setEntitlement(tenant, {
        status: 'canceled' as EntitlementStatus,
        currentPeriodEnd: periodEndMs(o),
        stripeSubscriptionId: asStr(o.id),
      });
      return { tenant, status: 'canceled' };
    }
    default:
      return null; // event we don't care about — ack with 200, do nothing.
  }
}

// ── Routes ──────────────────────────────────────────────────────────────

/** Resolve which tenant a billing action applies to from the Keycloak user's
 *  team membership (a team IS a tenant; slug = tenant id). `x-team` selects when
 *  there are several; the sole membership is used otherwise. Returns null after
 *  sending the appropriate 4xx (no team → 403, ambiguous → 400). Shared by
 *  checkout, GET /, and portal so they resolve identically. */
async function resolveBillingTenant(
  req: express.Request,
  res: express.Response,
  cp: { listMemberships(sub: string): Promise<Array<{ team_slug: string }>> },
  userSub: string,
): Promise<string | null> {
  const memberships = await cp.listMemberships(userSub);
  if (memberships.length === 0) {
    res.status(403).json({ error: 'no team yet — create one via POST /api/teams' });
    return null;
  }
  const wanted = req.get('x-team');
  if (wanted) {
    if (!memberships.some((m) => m.team_slug === wanted)) {
      res.status(403).json({ error: `not a member of team '${wanted}'` });
      return null;
    }
    return wanted;
  }
  if (memberships.length === 1) return memberships[0].team_slug;
  res.status(400).json({ error: 'multiple teams — pass the x-team header', teams: memberships.map((m) => m.team_slug) });
  return null;
}

/**
 * POST /api/billing/checkout — start a subscription for the caller's tenant.
 * Behind requireUser (Keycloak/dev-user identity → memberships); we use the
 * user's single membership (or x-team) as the tenant to bill, mirroring how
 * tenantAuth resolves a tenant for a user.
 */
router.post('/checkout', async (req, res) => {
  if (!billingEnabled()) {
    return res.status(501).json({ error: 'billing not enabled (STRIPE_SECRET_KEY unset)' });
  }
  if (!planCatalogue().length) {
    return res.status(501).json({ error: 'billing misconfigured (no BILLING_PLANS and no STRIPE_PRICE_ID)' });
  }
  const user = await requireUser(req, res);
  if (!user) return; // 401 already sent

  // Resolve which tenant this checkout buys for: the user's team. A team IS a
  // tenant (slug = tenant id). Use x-team when given, else the sole membership.
  const cp = await createControlPlane();
  try {
    const tenant = await resolveBillingTenant(req, res, cp, user.sub);
    if (!tenant) return; // 4xx already sent

    // Seats are validated against the REAL member count, not the client's word
    // for it. listMembers can legitimately fail on a brand-new tenant, and a
    // seat floor of 1 is the safe degradation — it never over-charges.
    let memberCount = 1;
    try {
      const members = await (cp as unknown as { listMembers(t: string): Promise<unknown[]> }).listMembers(tenant);
      if (Array.isArray(members) && members.length > 0) memberCount = members.length;
    } catch { /* fall back to 1 — see above */ }

    const line = resolveLine(
      typeof req.body?.plan === 'string' ? req.body.plan : null,
      req.body?.seats,
      memberCount,
    );
    if (isPlanError(line)) {
      // 409 for enterprise: the request is well-formed, the plan simply is not
      // buyable here. The contact address goes back so the UI can link it.
      if (line.code === 'contact_only') {
        return res.status(409).json({ error: line.message, contact: line.contact, plan: req.body?.plan });
      }
      return res.status(400).json({ error: line.message, code: line.code });
    }

    const stripe = await getStripe();
    if (!stripe) return res.status(501).json({ error: 'billing not enabled' });

    // Card-required free trial: the customer enters a card now, gets
    // TRIAL_DAYS free, then auto-converts to paid. No free tier, minimal abuse.
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: line.plan.priceId as string, quantity: line.quantity }],
      // Lets a coupon be redeemed at checkout. This is what makes launch promos
      // and referral discounts possible WITHOUT building a referral system:
      // codes are created in the Stripe dashboard and honoured here.
      allow_promotion_codes: true,
      // client_reference_id ties the resulting subscription back to OUR tenant;
      // we also stamp it into the subscription metadata so later subscription.*
      // events (which lack client_reference_id) can resolve the tenant.
      client_reference_id: tenant,
      // Session-level metadata as well as subscription_data.metadata below:
      // checkout.session.completed carries the SESSION object, whose metadata is
      // separate from the subscription's. Without this, planOf() sees nothing on
      // the first event and the entitlement records a null plan.
      metadata: { tenant, plan: line.plan.key, seats: String(line.quantity) },
      subscription_data: {
        // plan + seats recorded on the subscription so a later webhook (and any
        // support question) can tell WHICH plan was bought — the events
        // themselves carry only the price id.
        metadata: { tenant, plan: line.plan.key, seats: String(line.quantity) },
        trial_period_days: trialDays(),
      },
      success_url: process.env.STRIPE_SUCCESS_URL || 'https://chat-recall.munhq.com/?view=account&checkout=success',
      cancel_url: process.env.STRIPE_CANCEL_URL || 'https://chat-recall.munhq.com/?view=account&checkout=cancel',
    });

    if (!session.url) {
      // Stripe should always return a hosted URL for a checkout session; if it
      // doesn't, surface a real error rather than a broken { url: null }.
      return res.status(502).json({ error: 'Stripe returned no checkout URL' });
    }
    res.json({ url: session.url });
  } catch (err) {
    res.status(502).json({ error: 'Stripe checkout failed', detail: (err as Error).message });
  } finally {
    await cp.close();
  }
});

/**
 * POST /api/billing/webhook — Stripe → us. RAW body (signature is over the exact
 * bytes), so this route owns an express.raw parser. We verify the signature with
 * STRIPE_WEBHOOK_SECRET, then hand the parsed event to applyStripeEvent and ACK
 * 200 quickly. A bad signature is 400 (Stripe will retry on 5xx, so we only 5xx
 * on real processing failures).
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!billingEnabled()) {
    return res.status(501).json({ error: 'billing not enabled' });
  }
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whSecret) {
    return res.status(501).json({ error: 'billing misconfigured (STRIPE_WEBHOOK_SECRET unset)' });
  }
  const stripe = await getStripe();
  if (!stripe) return res.status(501).json({ error: 'billing not enabled' });

  const sig = req.get('stripe-signature') || '';
  let event: Stripe.Event;
  try {
    // req.body is a Buffer here (express.raw) — exactly what constructEvent needs.
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig, whSecret);
  } catch (err) {
    // Signature mismatch / malformed payload → reject, do NOT touch state.
    return res.status(400).json({ error: 'invalid signature', detail: (err as Error).message });
  }

  const cp = await createControlPlane();
  try {
    const result = await applyStripeEvent(event as unknown as StripeLikeEvent, cp);
    res.json({ received: true, applied: result });
  } catch (err) {
    // Processing failed (e.g. DB hiccup): 500 so Stripe retries the delivery.
    res.status(500).json({ error: 'webhook processing failed', detail: (err as Error).message });
  } finally {
    await cp.close();
  }
});

/**
 * GET /api/billing — the caller tenant's current entitlement (plan/status/period).
 * Drives the Account page's subscription panel and the client-side app gate.
 */
router.get('/', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const cp = await createControlPlane();
  try {
    const tenant = await resolveBillingTenant(req, res, cp, user.sub);
    if (!tenant) return;
    const ent = await cp.getEntitlement(tenant);
    res.json({
      billingEnabled: billingEnabled(),
      openBeta: openBeta(),
      tenant,
      status: ent?.status ?? 'none',
      plan: ent?.plan ?? null,
      currentPeriodEnd: ent?.currentPeriodEnd ?? null,
      hasSubscription: !!ent?.stripeCustomerId,
    });
  } catch (err) {
    res.status(500).json({ error: 'entitlement lookup failed', detail: (err as Error).message });
  } finally {
    await cp.close();
  }
});

/**
 * POST /api/billing/portal — open the Stripe Billing Portal so a subscriber can
 * update payment method / cancel. Needs an existing Stripe customer (from a prior
 * checkout); 409 if the tenant has never subscribed.
 */
router.post('/portal', async (req, res) => {
  if (!billingEnabled()) return res.status(501).json({ error: 'billing not enabled' });
  const user = await requireUser(req, res);
  if (!user) return;
  const cp = await createControlPlane();
  try {
    const tenant = await resolveBillingTenant(req, res, cp, user.sub);
    if (!tenant) return;
    const ent = await cp.getEntitlement(tenant);
    if (!ent?.stripeCustomerId) {
      return res.status(409).json({ error: 'no subscription to manage — subscribe first' });
    }
    const stripe = await getStripe();
    if (!stripe) return res.status(501).json({ error: 'billing not enabled' });
    const session = await stripe.billingPortal.sessions.create({
      customer: ent.stripeCustomerId,
      return_url: process.env.STRIPE_PORTAL_RETURN_URL || 'https://chat-recall.munhq.com/?view=account',
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(502).json({ error: 'Stripe portal failed', detail: (err as Error).message });
  } finally {
    await cp.close();
  }
});

/**
 * GET /api/billing/plan — PUBLIC (mounted before tenantAuth). Returns the Stripe
 * price so the pricing page is driven by Stripe truth, never a hardcoded amount.
 * Returns `{ configured: false }` (200) when Stripe isn't set up, so the landing
 * page can render a "coming soon"/contact state instead of erroring.
 */
router.get('/plan', async (_req, res) => {
  const priceId = process.env.STRIPE_PRICE_ID;
  const days = trialDays();
  if (!billingEnabled() || !priceId) return res.json({ configured: false, trialDays: days, openBeta: openBeta() });
  try {
    const stripe = await getStripe();
    if (!stripe) return res.json({ configured: false, trialDays: days, openBeta: openBeta() });
    const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    const product = price.product as Stripe.Product | undefined;
    res.json({
      configured: true,
      trialDays: days,
      openBeta: openBeta(),
      amount: price.unit_amount,
      currency: price.currency,
      interval: price.recurring?.interval ?? null,
      productName: product && typeof product === 'object' && 'name' in product ? product.name : null,
    });
  } catch (err) {
    // Don't leak Stripe errors to a public endpoint; degrade to unconfigured.
    res.json({ configured: false, trialDays: days, openBeta: openBeta(), error: (err as Error).message });
  }
});

/**
 * GET /api/billing/plans — PUBLIC. The whole catalogue, each self-serve plan
 * carrying its LIVE Stripe amount, so a pricing page never hardcodes a number
 * and a dashboard price edit needs no deploy.
 *
 * Contact-only plans (Enterprise) are returned with `selfServe: false` and their
 * contact address instead of an amount, so the UI renders "Talk to us" rather
 * than a buy button it cannot honour.
 *
 * Degrades to `configured: false` rather than erroring: the marketing page must
 * still render when Stripe is absent, which is the normal state on self-host.
 */
router.get('/plans', async (_req, res) => {
  const days = trialDays();
  const catalogue = planCatalogue();
  const base = { trialDays: days, openBeta: openBeta(), billingEnabled: billingEnabled() };

  if (!billingEnabled() || !catalogue.length) {
    return res.json({ ...base, configured: false, plans: [] });
  }
  try {
    const stripe = await getStripe();
    if (!stripe) return res.json({ ...base, configured: false, plans: [] });

    // One retrieve per priced plan. A catalogue is a handful of entries, and
    // Stripe is the source of truth for the amount, so this is deliberate.
    const plans = await Promise.all(
      catalogue.map(async (p) => {
        if (!p.priceId) {
          return {
            key: p.key, label: p.label, selfServe: false,
            contact: p.contact ?? null, seats: p.seats,
          };
        }
        try {
          const price = await stripe.prices.retrieve(p.priceId, { expand: ['product'] });
          const product = price.product as Stripe.Product | undefined;
          return {
            key: p.key,
            label: p.label,
            selfServe: true,
            seats: p.seats,
            minSeats: p.minSeats ?? null,
            maxSeats: p.maxSeats ?? null,
            amount: price.unit_amount,
            currency: price.currency,
            interval: price.recurring?.interval ?? null,
            intervalCount: price.recurring?.interval_count ?? null,
            productName:
              product && typeof product === 'object' && 'name' in product ? product.name : null,
          };
        } catch {
          // A stale price id must not blank the entire pricing page — drop that
          // one entry and keep serving the rest.
          return null;
        }
      }),
    );
    res.json({ ...base, configured: true, plans: plans.filter(Boolean) });
  } catch (err) {
    res.json({ ...base, configured: false, plans: [], error: (err as Error).message });
  }
});

export default router;
