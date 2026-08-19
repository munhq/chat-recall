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

/**
 * 30s in-process TTL cache on the control-plane entitlement lookup, keyed by
 * the tenant being checked. Without it every paid request pays a control-plane
 * query. 30s of staleness on entitlement is acceptable: webhook-driven changes
 * (checkout completed, subscription canceled) simply take effect on the next
 * tick, so no explicit invalidation is needed. `clearEntitlementCache` exists
 * for tests.
 */
const entitlementCache = new TenantTtlCache<boolean>(30_000);

export function clearEntitlementCache(): void {
  entitlementCache.clear();
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
 * Open beta: everything is free for everyone, even with Stripe fully
 * configured underneath. One env flag (OPEN_BETA=1) so GA is a config change,
 * not a deploy — unset it and the subscription gate snaps back on. Surfaced
 * to the client via /api/billing and /api/billing/plan so the UI renders
 * beta copy instead of trial/checkout CTAs.
 */
export function openBeta(): boolean {
  return /^(1|true|yes)$/i.test(process.env.OPEN_BETA || '');
}

/**
 * Whether a tenant may use the paid surface right now.
 *
 *   - billing disabled → always true (self-host free tier).
 *   - open beta        → always true (cloud, pre-GA: free for everyone).
 *   - billing enabled  → true iff the tenant has a recorded subscription that
 *     is active|trialing AND not lapsed (currentPeriodEnd null = no expiry
 *     known yet, treated as still valid; otherwise must be in the future).
 *
 * Fail-closed on cloud: an absent row, an unknown status, or a past period all
 * resolve to NOT entitled.
 */
export async function isEntitled(tenant: string): Promise<boolean> {
  if (!billingEnabled() || openBeta()) return true;

  // Served from the 30s TTL cache when warm — one control-plane query per
  // tenant per window instead of one per paid request.
  const cached = entitlementCache.get(tenant);
  if (cached !== undefined) return cached;

  const cp = await createControlPlane();
  let entitled = false;
  try {
    const e = await cp.getEntitlement(tenant);
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
 * Express middleware: 402 Payment Required when the request's tenant isn't
 * entitled. Mount AFTER tenantAuth so `req.tenant` is resolved. On self-host
 * this is a transparent pass-through (isEntitled → true).
 *
 * The 402 body carries a `checkoutHint` so the client can route the user to
 * start a subscription instead of just surfacing a dead error.
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
    .then((ok) => {
      if (ok) return next();
      res.status(402).json({
        error: 'subscription required',
        checkoutHint: 'POST /api/billing/checkout to start a subscription',
      });
    })
    .catch(next);
}

/**
 * Express middleware: the TEAM (collaboration) gate.
 *
 * Three states, in order:
 *   - cloud (billingEnabled)  → the subscription already decides; pass through
 *     to requireEntitlement, which is mounted alongside on these routes.
 *   - self-host + team licence → pass.
 *   - self-host, no licence    → 402 with how to get one.
 *
 * Why this is separate from requireEntitlement: isEntitled() returns true for
 * every self-host request by design (self-host is the free tier), which made the
 * collaboration surface free at any company size. Solo self-hosting stays free
 * and complete; only the features that need colleagues are licensed.
 */
export function requireTeamFeature(req: Request, res: Response, next: NextFunction): void {
  // NO openBeta() BYPASS, deliberately. The beta frees the SOLO surface —
  // isEntitled() honours it — not collaboration. Team is paid in every state: a
  // Team-tier plan on cloud, a licence key on self-host. A beta that gives away
  // the paid tier cannot end without taking it back from the earliest adopters.
  if (billingEnabled()) return next();          // cloud: subscription governs
  if (hasFeature('team')) return next();        // self-host with a team licence

  const s = licenseState();
  res.status(402).json({
    error: 'team features require a licence',
    reason: s.valid ? 'licence does not include the team feature' : s.reason,
    detail: 'detail' in s ? s.detail : undefined,
    hint: 'Solo self-hosting is free and unlimited. Collaboration (shared project history, the team task board, per-member activity, the team toolkit) needs a licence: https://chatrecall.dev/pricing',
  });
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
  if (billingEnabled()) {
    const cp = await createControlPlane();
    try {
      const ent = await cp.getEntitlement(tenant);
      if (planGrantsTeam(ent?.plan)) return true;
      res.status(402).json({
        error: 'the Team plan is required to invite teammates',
        plan: ent?.plan ?? null,
        checkoutHint: 'POST /api/billing/checkout with {"plan":"team-monthly","seats":N}',
      });
      return false;
    } finally {
      await cp.close();
    }
  }
  // Self-host: a team licence key. Inlined rather than delegated — the helper
  // this called was a second copy of the same decision and drifted, ending up
  // without the openBeta() check the rest of this function has.
  if (hasFeature('team')) return true;
  const st = licenseState();
  res.status(402).json({
    error: 'team features require a licence',
    reason: st.valid ? 'licence does not include the team feature' : st.reason,
    hint: 'Solo self-hosting is free and unlimited. Collaboration needs a licence: https://chatrecall.dev/pricing',
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
