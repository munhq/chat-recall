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
import type { Request } from 'express';
import type Stripe from 'stripe';
import { createControlPlane, type EntitlementStatus } from '../imports.js';
import { requireUser } from '../middleware/auth.js';
import { billingEnabled, isEntitled, tenantFeatures } from '../util/billing.js';
import { ensureTrial, isNoCardTrial, trialDaysLeft, trialLengthDays } from '../util/trial.js';
import { planCatalogue, resolveLine, isPlanError, trialDays } from '../util/billing-plans.js';
import { publicOrigin, UnsafeOriginError } from './install.js';

const router = express.Router();

/**
 * Where Stripe sends the browser back to after checkout or the customer portal.
 *
 * The STRIPE_*_URL variables stay authoritative, so an operator can point the
 * return at a different front end. When none is set we derive the origin the
 * client actually reached us on (PUBLIC_URL, else hard-validated forwarded
 * headers — see publicOrigin). A baked-in host is never correct here: the one
 * that used to sit in this file outlived the domain it named and kept sending
 * paying self-hosters to a 404.
 */
function accountReturnUrl(req: Request, override: string | undefined, params: string): string {
  if (override) return override;
  let origin: string;
  try {
    origin = publicOrigin(req);
  } catch (err) {
    if (err instanceof UnsafeOriginError) {
      throw new Error(
        `cannot derive a Stripe return URL: ${err.message}. `
        + 'Set PUBLIC_URL, or set STRIPE_SUCCESS_URL / STRIPE_CANCEL_URL / STRIPE_PORTAL_RETURN_URL explicitly.',
      );
    }
    throw err;
  }
  return `${origin}/?view=account${params ? `&${params}` : ''}`;
}

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

/** The address to send a licence to. Stripe puts it on the subscription's metadata
 *  when checkout stamps it; otherwise fall back to nothing rather than guessing. */
function subscriberEmail(o: Record<string, unknown>): string | null {
  const md = (o.metadata ?? null) as Record<string, unknown> | null;
  const e = md?.email;
  return typeof e === 'string' && e.includes('@') ? e : null;
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
      const plan = planOf(o);
      await cp.setEntitlement(tenant, {
        status,
        plan,
        currentPeriodEnd: periodEndMs(o),
        stripeCustomerId: asStr(o.customer),
        stripeSubscriptionId: asStr(o.id),
      });

      // A SELF-HOST purchase is delivered as a licence serial, not as access to our
      // servers, so it needs an artefact the customer can paste into their own
      // deployment. Issued here because this is the event that knows the plan.
      //
      // Idempotent on the subscription id: this event fires more than once per
      // purchase, and a second serial for one subscription would be two licences
      // sold once. Failures are logged and swallowed — the webhook must still ack, or
      // Stripe retries forever and the entitlement write above is repeated for
      // nothing.
      if (plan && plan.toLowerCase().startsWith('selfhost') && (status === 'active' || status === 'trialing')) {
        try {
          const { issueSerialForSubscription } = await import('./licence.js');
          const subId = asStr(o.id);
          if (subId) {
            const { serial, created } = await issueSerialForSubscription({
              subscriptionId: subId,
              customerId: asStr(o.customer),
              email: subscriberEmail(o),
              seats: Number((o.metadata as Record<string, unknown> | undefined)?.seats) || null,
            });
            if (created) {
              const to = subscriberEmail(o);
              if (to) {
                const { sendMail, licenceSerialMail } = await import('../auth/mailer.js');
                const interval = plan.toLowerCase().includes('year') ? 'year' : 'month';
                await sendMail(licenceSerialMail(to, serial, interval));
              }
            }
          }
        } catch (e) {
          console.error('[billing] self-host serial issuance failed:', (e as Error).message);
        }
      }
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

    // TOTAL free time is capped at ONE trial, never stacked.
    //
    // The tenant is already on a no-card trial by the time it reaches checkout, so
    // adding trial_period_days here would hand out a SECOND free window — 14 days
    // free, then another 7 with a card on file, 21 before the first charge. The
    // free period a customer was promised is the one they are already on, so the
    // subscription inherits its END rather than starting a new clock.
    //
    // Cases:
    //   - live no-card trial  → trial_end = that trial's end (total stays 14 days)
    //   - <48h left, or lapsed, or a returning subscriber → no trial; Stripe
    //     charges at once. Stripe rejects a trial_end under 48 hours out, and
    //     someone at the end of their trial has had the free window already.
    //   - no entitlement row at all → the classic card-required trial, which is
    //     still inside the cap.
    const cpTrial = await createControlPlane();
    let trialArg: { trial_end?: number; trial_period_days?: number } = {};
    try {
      const cur = await cpTrial.getEntitlement(tenant);
      const MIN_TRIAL_MS = 48 * 60 * 60 * 1000;
      if (!cur) {
        trialArg = { trial_period_days: trialDays() };
      } else if (isNoCardTrial(cur) && cur.currentPeriodEnd != null
                 && cur.currentPeriodEnd - Date.now() > MIN_TRIAL_MS) {
        trialArg = { trial_end: Math.floor(cur.currentPeriodEnd / 1000) };
      }
      // else: no trial at all — charge now.
    } finally {
      await cpTrial.close();
    }

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
        // `email` is stamped so the self-host licence serial has somewhere to go: the
        // subscription event is what knows the plan, and it carries no address of its
        // own. Without this a self-host purchase succeeds and the customer receives
        // nothing.
        metadata: { tenant, plan: line.plan.key, seats: String(line.quantity), email: user.email ?? '' },
        // Exactly one of trial_end / trial_period_days, or neither. See above.
        ...trialArg,
      },
      success_url: accountReturnUrl(req, process.env.STRIPE_SUCCESS_URL, 'checkout=success'),
      cancel_url: accountReturnUrl(req, process.env.STRIPE_CANCEL_URL, 'checkout=cancel'),
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
    // ensureTrial, not getEntitlement: the Account page is often the first
    // authenticated call a new tenant makes, and it must report the trial it is
    // actually on rather than "none" until some other route provisions it.
    const ent = await ensureTrial(cp, tenant);
    const onTrial = isNoCardTrial(ent);
    res.json({
      billingEnabled: billingEnabled(),
      tenant,
      status: ent?.status ?? 'none',
      plan: ent?.plan ?? null,
      currentPeriodEnd: ent?.currentPeriodEnd ?? null,
      hasSubscription: !!ent?.stripeCustomerId,
      // AUTHORITATIVE. The client must not re-derive "may I use this?" from
      // status and dates: that is the same decision the gate makes, and a second
      // copy of it drifts. A trial whose period has passed still reads
      // status='trialing', so a client deriving it would say "ends today" to
      // someone already read-only.
      entitled: await isEntitled(tenant),
      // The tenant's resolved capabilities. /api/capabilities is PRE-AUTH and
      // therefore deployment-wide — it answers "does this build have teams", not
      // "may you use them". That is why the Team tab rendered for every account
      // regardless of plan: a door that cannot open, which this codebase already
      // calls worse than no door where it gates the admin view. The client
      // intersects these with the deployment's capabilities.
      features: await tenantFeatures(tenant),
      // The trial surface the client renders its banner and gate from.
      onTrial,
      trialDaysLeft: onTrial ? trialDaysLeft(ent) : null,
      trialLengthDays: trialLengthDays(),
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
      return_url: accountReturnUrl(req, process.env.STRIPE_PORTAL_RETURN_URL, ''),
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
  if (!billingEnabled() || !priceId) return res.json({ configured: false, trialDays: days, freeTrialDays: trialLengthDays() });
  try {
    const stripe = await getStripe();
    if (!stripe) return res.json({ configured: false, trialDays: days, freeTrialDays: trialLengthDays() });
    const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    const product = price.product as Stripe.Product | undefined;
    res.json({
      configured: true,
      trialDays: days,
      freeTrialDays: trialLengthDays(),
      amount: price.unit_amount,
      currency: price.currency,
      interval: price.recurring?.interval ?? null,
      productName: product && typeof product === 'object' && 'name' in product ? product.name : null,
    });
  } catch (err) {
    // Don't leak Stripe errors to a public endpoint; degrade to unconfigured.
    res.json({ configured: false, trialDays: days, freeTrialDays: trialLengthDays(), error: (err as Error).message });
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
  const base = { trialDays: days, freeTrialDays: trialLengthDays(), billingEnabled: billingEnabled() };

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
