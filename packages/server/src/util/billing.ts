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
import {
  allows, featureRequired, featuresFor, limitsFor, limitReached,
  FULL_LIMITS, type Feature, type PlanLimits,
} from './entitlements.js';

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
 * The plan the FEATURE RESOLVER must see — the recorded plan while the
 * entitlement is live, 'free' once it is not.
 *
 * This is the single change that makes the free tier real everywhere at once:
 * requireFeature, tenantFeatures (what the UI hides), collaborationOr402 and the
 * limits below all resolve through here, so a lapsed Solo tenant loses insights,
 * tasks and toolkit the moment the entitlement lapses — previously the feature
 * gates read the RECORDED plan and never looked at status, so a lapsed 'trial'
 * row still granted the whole Solo set to reads.
 *
 * Self-host returns null untouched: the resolver ignores the plan there and
 * reads the licence instead.
 */
export async function effectivePlan(tenant: string): Promise<string | null> {
  if (!billingEnabled()) return null;
  return (await isEntitled(tenant)) ? tenantPlan(tenant) : 'free';
}

/**
 * The tenant's quantitative limits (window, quotas, meters). Self-host is never
 * metered — it runs on the operator's own hardware.
 */
export async function tenantLimits(tenant: string): Promise<PlanLimits> {
  if (!billingEnabled()) return FULL_LIMITS;
  return limitsFor(await effectivePlan(tenant));
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
    effectivePlan(tenant)
      .then((plan) => {
        if (allows(plan, feature)) return next();
        res.status(402).json(featureRequired(feature));
      })
      .catch(next);
  };
}

/** The tenant's resolved feature list, for the client to hide what it cannot use.
 *  Resolves through effectivePlan, so a lapsed tenant's UI shows the free tier —
 *  the server gates would refuse anyway, but a door that 402s is worse than no
 *  door. */
export async function tenantFeatures(tenant: string): Promise<Feature[]> {
  return [...featuresFor(await effectivePlan(tenant))];
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
 * A LAPSED tenant lands on the FREE TIER, not on read-only. This middleware
 * therefore refuses almost nothing itself any more: for a lapsed tenant it
 * passes the request through and the decision moves to the layers that know
 * what "free" means —
 *
 *   - requireFeature, which resolves through effectivePlan and so answers
 *     'free' for a lapsed tenant (insights, tasks, toolkit, team → 402 with
 *     the upgrade offer),
 *   - the search/list window (routes clamp to tenantLimits().searchWindowDays),
 *   - the sync meters (syncAdmission below).
 *
 * The data behind this gate is the user's own conversation history, indexed from
 * their own machine — so locking them out buys no leverage while guaranteeing
 * the worst possible story about us. The free tier keeps the daily habit (sync,
 * recent search) alive and prices the accumulated history instead.
 *
 * The ONE refusal left here: a tenant that never confirmed an email address gets
 * 402 on writes. That is the anti-abuse gate — an unconfirmed address must not
 * spend money — and the message tells them to check their inbox, not to
 * subscribe, because that is the actual fix.
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
      if (isReadRequest(req)) return next();   // free tier reads; routes window them
      if (await needsEmailConfirmation(tenant)) {
        res.status(402).json({
          error: 'email confirmation required',
          detail: 'Confirm your email address to start your trial. Nothing is counting down until you do.',
          resendHint: 'POST /api/auth/send-verification-email to get another link',
        });
        return;
      }
      // Lapsed → free tier. Writes to the free surfaces (kg, diary, kv) are part
      // of the tier; writes to paid surfaces are refused by their feature gates
      // with a payload that names the plan to buy — a better answer than a
      // blanket "subscription required" that can't say what for.
      next();
    })
    .catch(next);
}

/**
 * Admission decision for one ingest batch — THE enforcement point for the
 * free tier's sync meters, called by /api/sync with the batch's byte size.
 *
 * Sync was previously not entitlement-checked at all: the route authenticates
 * its own device token and never consulted billing, so a lapsed tenant's CLI
 * could push forever and the "syncs pause" promise was enforced nowhere. This
 * closes that — free is metered (monthly quota + total cap), paid and trialing
 * are unmetered, and a tenant whose address was never confirmed is refused
 * outright (the trial gate's reasoning: an unconfirmed address must not spend
 * money, and ingest is the thing that spends).
 *
 * Refusals are 402 with the canonical limitReached()/confirmation payloads, so
 * the CLI can print the same actionable sentence the dashboard shows.
 */
export type SyncAdmission =
  | { ok: true; limits: PlanLimits }
  | { ok: false; status: number; body: Record<string, unknown> };

export async function syncAdmission(tenant: string, incomingBytes: number): Promise<SyncAdmission> {
  if (!billingEnabled()) return { ok: true, limits: FULL_LIMITS };
  const entitled = await isEntitled(tenant);   // lazily grants the trial on first contact
  if (!entitled && (await needsEmailConfirmation(tenant))) {
    return {
      ok: false,
      status: 402,
      body: {
        error: 'email confirmation required',
        detail: 'Confirm your email address to start your trial before syncing.',
        resendHint: 'POST /api/auth/send-verification-email to get another link',
      },
    };
  }
  const limits = limitsFor(entitled ? await tenantPlan(tenant) : 'free');
  if (limits.syncBytesPerMonth === null && limits.syncStorageBytes === null) {
    return { ok: true, limits };
  }
  const month = currentUsageMonth();
  const cp = await createControlPlane();
  try {
    const u = await cp.getSyncUsage(tenant, month);
    if (limits.syncStorageBytes !== null && u.totalBytes + incomingBytes > limits.syncStorageBytes) {
      return { ok: false, status: 402, body: limitReached('sync_storage', u.totalBytes, limits.syncStorageBytes) };
    }
    if (limits.syncBytesPerMonth !== null && u.monthBytes + incomingBytes > limits.syncBytesPerMonth) {
      return { ok: false, status: 402, body: limitReached('sync_quota', u.monthBytes, limits.syncBytesPerMonth, nextMonthStartMs()) };
    }
  } finally {
    await cp.close();
  }
  return { ok: true, limits };
}

/**
 * Record an ACCEPTED batch's bytes. Called after a successful ingest, not
 * before — a batch the server failed to write must not consume quota. Recorded
 * for every cloud tenant, paid included: the running total is what makes a
 * later downgrade honest (a heavy user who drops to free is already over the
 * storage cap, which is the correct outcome, not a loophole).
 */
export async function recordSyncUsage(tenant: string, bytes: number): Promise<void> {
  if (!billingEnabled() || !Number.isFinite(bytes) || bytes <= 0) return;
  const cp = await createControlPlane();
  try {
    await cp.addSyncUsage(tenant, currentUsageMonth(), bytes);
  } finally {
    await cp.close();
  }
}

/**
 * Mark that a tenant TRIED to sync this month, without consuming quota. A
 * zero-byte upsert leaves the row in place, and row existence — not bytes — is
 * what the retention sweep reads as presence. Without this, a tenant over the
 * storage cap (every batch refused, so no accepted bytes are ever recorded)
 * looks absent and gets purged despite syncing daily — the exact promise
 * ("your data is kept") the cap's refusal message makes.
 */
export async function recordSyncPresence(tenant: string): Promise<void> {
  if (!billingEnabled()) return;
  const cp = await createControlPlane();
  try {
    await cp.addSyncUsage(tenant, currentUsageMonth(), 0);
  } finally {
    await cp.close();
  }
}

/** 'YYYY-MM', UTC — the usage meter's bucket key. */
export function currentUsageMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** When the monthly meter turns over: the first instant of next month, UTC. */
export function nextMonthStartMs(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
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
  const plan = await effectivePlan(tenant);
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
