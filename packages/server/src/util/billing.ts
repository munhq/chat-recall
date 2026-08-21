/**
 * Entitlement gate — turns "is this tenant paid?" into a single async check
 * the paid routes consult, instead of reading a bare env flag at the call site.
 *
 * The locked model:
 *   - Self-host (no STRIPE_SECRET_KEY) → billing is OFF; every tenant is
 *     entitled by default. Self-host IS the free tier and is never billed, so
 *     the team toolkit just works without any subscription plumbing.
 *   - Cloud (STRIPE_SECRET_KEY set) → a tenant is entitled only with an ACTIVE
 *     (or trialing) subscription whose period hasn't lapsed. The subscription
 *     state lives in the control plane's `entitlements` table, flipped by the
 *     Stripe webhook in routes/billing.ts.
 *
 * Pricing is NEVER hardcoded here: which price a checkout buys is the operator's
 * STRIPE_PRICE_ID (see routes/billing.ts). This file only reads the RESULT of a
 * subscription (its status), never any amount.
 */
import type { Request, Response, NextFunction } from 'express';
import { createControlPlane } from '../imports.js';
import { TenantTtlCache } from './tenant-cache.js';
import { hasFeature, licenseState } from './license.js';
import { planGrantsTeam } from '../routes/billing.js';
import { ensureTrial } from './trial.js';
import { allows, featureRequired, featuresFor, type Feature } from './entitlements.js';

/**
 * 30s in-process TTL cache on the control-plane entitlement lookup, keyed by
 * the tenant being checked. Without it every paid request pays a control-plane
 * query. 30s of staleness on entitlement is acceptable: webhook-driven changes
 * (checkout completed, subscription canceled) simply take effect on the next
 * tick, so no explicit invalidation is needed. `clearEntitlementCache` exists
 * for tests.
 */
const entitlementCache = new TenantTtlCache<boolean>(30_000);

/**
 * The tenant's recorded PLAN, cached like the entitlement above and for the same
 * reason: the feature gate runs on every request to a gated route, and the plan
 * changes only when a webhook lands.
 */
const planCache = new TenantTtlCache<string | null>(30_000);

export function clearEntitlementCache(): void {
  entitlementCache.clear();
  planCache.clear();
}

/** The tenant's recorded plan, or null. Empty on self-host, where the licence —
 *  not a plan — decides, and the resolver ignores this value entirely. */
export async function tenantPlan(tenant: string): Promise<string | null> {
  if (!billingEnabled()) return null;
  const cached = planCache.get(tenant);
  if (cached !== undefined) return cached;
  const cp = await createControlPlane();
  try {
    const e = await cp.getEntitlement(tenant);
    const plan = e?.plan ?? null;
    planCache.set(tenant, plan);
    return plan;
  } finally {
    await cp.close();
  }
}

/**
 * Express middleware: require one FEATURE. Mount after tenantAuth.
 *
 * This replaces requireTeamFeature, which began with
 *
 *   if (billingEnabled()) return next();   // "the subscription governs"
 *
 * and so was a PASS-THROUGH on cloud. The only check mounted beside it was
 * requireEntitlement, which any trialing or Solo tenant passes — so
 * /api/activity, /api/tasks and /api/shares were guarded by "has a subscription"
 * rather than "has Team". The plan was never consulted. This asks the one
 * resolver, which reads the plan on cloud and the licence on self-host, so both
 * editions cannot disagree.
 *
 * Refusals carry featureRequired()'s payload: the same actionable shape the
 * dashboard, the CLI and an MCP-driven agent all relay.
 */
export function requireFeature(feature: Feature) {
  return function featureGate(req: Request, res: Response, next: NextFunction): void {
    const tenant = req.tenant;
    if (!tenant) {
      res.status(401).json({ error: 'no tenant resolved (auth middleware missing?)' });
      return;
    }
    tenantPlan(tenant)
      .then((plan) => {
        if (allows(plan, feature)) return next();
        res.status(402).json(featureRequired(feature));
      })
      .catch(next);
  };
}

/** The tenant's resolved feature list, for the client to hide what it cannot use. */
export async function tenantFeatures(tenant: string): Promise<Feature[]> {
  return [...featuresFor(await tenantPlan(tenant))];
}

/**
 * Billing is "enabled" exactly when a Stripe secret key is configured. This is
 * the single switch that flips the server from self-host (free, always
 * entitled) to cloud (subscription-gated). Read live from env on every call so
 * tests can toggle it without re-importing the module.
 */
export function billingEnabled(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

/**
 * Whether a tenant may use the paid surface right now.
 *
 *   - billing disabled → always true (self-host free tier).
 *   - billing enabled  → true iff the tenant's entitlement is active|trialing
 *     AND not lapsed (currentPeriodEnd null = no expiry known yet, treated as
 *     still valid; otherwise it must be in the future).
 *
 * A tenant with no entitlement history is granted the no-card trial here (see
 * util/trial.ts) and is entitled for its duration. There is no flag that skips
 * this check: access is always the answer of a real entitlement row, which is
 * what keeps this path exercised in production instead of only after GA.
 *
 * Fail-closed on cloud: an unknown status or a past period resolves to NOT
 * entitled.
 */
export async function isEntitled(tenant: string): Promise<boolean> {
  if (!billingEnabled()) return true;

  // Served from the 30s TTL cache when warm — one control-plane query per
  // tenant per window instead of one per paid request.
  const cached = entitlementCache.get(tenant);
  if (cached !== undefined) return cached;

  const cp = await createControlPlane();
  let entitled = false;
  try {
    const e = await ensureTrial(cp, tenant);
    const statusOk = !!e && (e.status === 'active' || e.status === 'trialing');
    // null period = open-ended (e.g. a trial Stripe hasn't dated yet); any
    // recorded period must not be in the past.
    const periodOk = !!e && (e.currentPeriodEnd == null || e.currentPeriodEnd > Date.now());
    entitled = statusOk && periodOk;
  } finally {
    await cp.close();
  }
  entitlementCache.set(tenant, entitled);
  return entitled;
}

/**
 * Is this tenant un-entitled because nobody has confirmed an email address?
 *
 * Only ever consulted on the refusal path, so the extra control-plane round trip
 * costs nothing in the common case. Distinguishes "confirm your address" from
 * "subscribe", which are the two ways to arrive here and have nothing in common
 * from the user's side.
 *
 * Fails to FALSE on any error: a wrong "subscribe" message is a smaller harm
 * than telling a paying customer whose subscription lapsed to go and check their
 * inbox.
 */
async function needsEmailConfirmation(tenant: string): Promise<boolean> {
  try {
    const cp = await createControlPlane();
    try {
      // An existing entitlement row means the trial was granted at some point,
      // so confirmation is not what is missing — they lapsed.
      if (await cp.getEntitlement(tenant)) return false;
      return !(await cp.hasVerifiedMember(tenant));
    } finally {
      await cp.close();
    }
  } catch {
    return false;
  }
}

/**
 * Safe methods, for the lapsed-tenant degradation below. GET and HEAD read;
 * everything else changes state. OPTIONS is included so CORS preflight is never
 * the thing that fails.
 */
function isReadRequest(req: Request): boolean {
  return req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
}

/**
 * Express middleware: the entitlement gate. Mount AFTER tenantAuth so
 * `req.tenant` is resolved. On self-host this is a transparent pass-through
 * (isEntitled → true).
 *
 * A LAPSED tenant is DEGRADED, NOT LOCKED OUT: reads pass, writes get 402.
 *
 * The data behind this gate is the user's own conversation history, indexed from
 * their own machine — so locking them out of reading it buys no leverage (the CLI
 * can re-index it in one command) while guaranteeing the worst possible story
 * about us. Degrading instead applies the same pressure on the surfaces that cost
 * us money to run, keeps the door open for someone who pays late, and leaves them
 * able to export what is already theirs.
 *
 * Writes stop, which is what pauses sync: the CLI pushes with POST.
 *
 * The 402 body carries a `checkoutHint` so the client can route the user to
 * checkout instead of surfacing a dead error.
 */
export function requireEntitlement(req: Request, res: Response, next: NextFunction): void {
  const tenant = req.tenant;
  if (!tenant) {
    // tenantAuth must run first; a missing tenant here is a wiring bug, not a
    // billing state — fail closed and say so rather than silently allowing.
    res.status(401).json({ error: 'no tenant resolved (auth middleware missing?)' });
    return;
  }
  isEntitled(tenant)
    .then(async (ok) => {
      if (ok) return next();
      if (isReadRequest(req)) return next();   // lapsed: read-only, see above
      // Two very different reasons to be un-entitled, and telling them apart is
      // the difference between an actionable message and a wrong one. A tenant
      // that never got a trial because nobody confirmed an address must not be
      // told to subscribe — the fix is a link in their inbox, and saying
      // "subscription required" sends them to a checkout they do not need.
      if (await needsEmailConfirmation(tenant)) {
        res.status(402).json({
          error: 'email confirmation required',
          detail: 'Confirm your email address to start your trial. Nothing is counting down until you do.',
          resendHint: 'POST /api/auth/send-verification-email to get another link',
        });
        return;
      }
      res.status(402).json({
        error: 'subscription required',
        detail: 'Your access is read-only until you subscribe. Your history is kept.',
        checkoutHint: 'POST /api/billing/checkout to start a subscription',
      });
    })
    .catch(next);
}




/**
 * Inline COLLABORATION gate, covering both editions:
 *   - cloud     → the entitlement's recorded plan must be a team tier. A Solo
 *                 subscriber is entitled (isEntitled true) but NOT team, which is
 *                 the leak this closes: the invite gate previously checked only
 *                 status, so Solo bought Team.
 *   - self-host → a team licence key.
 *
 * Returns true to proceed; on false it has already sent the 402.
 */
export async function collaborationOr402(res: Response, tenant: string): Promise<boolean> {
  const plan = await tenantPlan(tenant);
  if (allows(plan, 'team')) return true;
  // One refusal shape for every edition. This used to branch — plan check on
  // cloud, licence check inlined for self-host — which is how the cloud branch
  // gained the plan check while three route mounts did not.
  res.status(402).json({
    ...featureRequired('team'),
    plan: plan ?? null,
    hint: 'Solo self-hosting is free and unlimited. Collaboration needs the Team plan or a licence.',
  });
  return false;
}

/**
 * Inline gate for routes that resolve their tenant from a path param BEFORE
 * tenantAuth runs (the team toolkit routes map identity→team themselves, so
 * `req.tenant` isn't set there). Returns true when the caller may proceed; on
 * false it has already sent a 402. Self-host always returns true.
 */
export async function entitledOr402(res: Response, tenant: string): Promise<boolean> {
  if (await isEntitled(tenant)) return true;
  res.status(402).json({
    error: 'subscription required',
    checkoutHint: 'POST /api/billing/checkout to start a subscription',
  });
  return false;
}
