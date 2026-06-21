/**
 * /api/billing — Stripe subscription lifecycle for the cloud edition.
 *
 *   POST /api/billing/checkout   → create a Stripe Checkout Session (subscription
 *                                  mode) for the caller's tenant; returns { url }.
 *   POST /api/billing/webhook    → Stripe → us: verify signature, map subscription
 *                                  events onto the tenant's entitlement row.
 *
 * Design constraints:
 *   - Pricing is NEVER hardcoded. The line item is STRIPE_PRICE_ID (env). This
 *     file never sees an amount; Stripe owns the catalog.
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
import { billingEnabled } from '../util/billing.js';

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

/** Stripe gives period end in SECONDS; we store epoch MILLIS everywhere. */
function periodEndMs(o: Record<string, unknown>): number | null {
  const sec = o.current_period_end;
  return typeof sec === 'number' ? sec * 1000 : null;
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
      // On the completed checkout the session object carries customer + the
      // subscription id, but not yet a subscription status — a completed
      // subscription checkout is, by definition, active. Stripe will follow up
      // with subscription.updated carrying the precise status/period.
      const patch = {
        status: 'active' as EntitlementStatus,
        plan: process.env.STRIPE_PRICE_ID ?? null,
        currentPeriodEnd: periodEndMs(o),
        stripeCustomerId: asStr(o.customer),
        stripeSubscriptionId: asStr(o.subscription),
      };
      await cp.setEntitlement(tenant, patch);
      return { tenant, status: patch.status };
    }
    case 'customer.subscription.updated': {
      const status = mapSubStatus(o.status);
      await cp.setEntitlement(tenant, {
        status,
        plan: process.env.STRIPE_PRICE_ID ?? null,
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
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) {
    return res.status(501).json({ error: 'billing misconfigured (STRIPE_PRICE_ID unset)' });
  }
  const user = await requireUser(req, res);
  if (!user) return; // 401 already sent

  // Resolve which tenant this checkout buys for: the user's team. A team IS a
  // tenant (slug = tenant id). Use x-team when given, else the sole membership.
  const cp = await createControlPlane();
  try {
    const tenant = await resolveBillingTenant(req, res, cp, user.sub);
    if (!tenant) return; // 4xx already sent

    const stripe = await getStripe();
    if (!stripe) return res.status(501).json({ error: 'billing not enabled' });

    // Card-required free trial: the customer enters a card now, gets
    // TRIAL_DAYS free, then auto-converts to paid. No free tier, minimal abuse.
    const trialDays = Number(process.env.STRIPE_TRIAL_DAYS) || 14;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // client_reference_id ties the resulting subscription back to OUR tenant;
      // we also stamp it into the subscription metadata so later subscription.*
      // events (which lack client_reference_id) can resolve the tenant.
      client_reference_id: tenant,
      subscription_data: { metadata: { tenant }, trial_period_days: trialDays },
      success_url: process.env.STRIPE_SUCCESS_URL || 'https://chat-recall.hotmun.com/?view=account&checkout=success',
      cancel_url: process.env.STRIPE_CANCEL_URL || 'https://chat-recall.hotmun.com/?view=account&checkout=cancel',
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
      return_url: process.env.STRIPE_PORTAL_RETURN_URL || 'https://chat-recall.hotmun.com/?view=account',
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
  const trialDays = Number(process.env.STRIPE_TRIAL_DAYS) || 14;
  if (!billingEnabled() || !priceId) return res.json({ configured: false, trialDays });
  try {
    const stripe = await getStripe();
    if (!stripe) return res.json({ configured: false, trialDays });
    const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    const product = price.product as Stripe.Product | undefined;
    res.json({
      configured: true,
      trialDays,
      amount: price.unit_amount,
      currency: price.currency,
      interval: price.recurring?.interval ?? null,
      productName: product && typeof product === 'object' && 'name' in product ? product.name : null,
    });
  } catch (err) {
    // Don't leak Stripe errors to a public endpoint; degrade to unconfigured.
    res.json({ configured: false, trialDays, error: (err as Error).message });
  }
});

export default router;
