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
import { createControlPlane, createStore, runWithTenant } from '../imports.js';
import { TenantTtlCache } from './tenant-cache.js';
import { hasFeature, licenseState } from './license.js';
import { planGrantsTeam } from '../routes/billing.js';
import { ensureTrial } from './trial.js';
import {
  allows, featureRequired, featuresFor, dormantLimits, trialLimits, limitReached, syncOffPayload,
  noPlanPayload, FULL_LIMITS, type Feature, type PlanLimits,
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
  confirmationCache.clear();
}

/**
 * Tenants this deployment always treats as fully entitled, and the plan they
 * resolve to. `OPERATOR_TENANTS` is a comma-separated list of tenant slugs;
 * `OPERATOR_PLAN` names the tier (default 'enterprise', the only one granting
 * every feature).
 *
 * This exists because the people who run chat-recall are also its heaviest
 * users, and the hard stop applies to them too: the maintainer's own account
 * runs on the same no-card trial as everybody else's, so it lapses on the same
 * schedule and takes the dogfooding with it. Paying yourself through Stripe to
 * keep working is a worse answer than saying so in configuration.
 *
 * Read from env on every call rather than cached at import, so adding a tenant
 * is a rollout and not a rebuild. Deliberately keyed on the TENANT SLUG, not on
 * an email: the gates all run on `req.tenant`, and resolving an address per
 * request would add a lookup to every gated route.
 *
 * It grants a plan; it does NOT grant the operator role. `chat-recall-admin`
 * stays with ADMIN_EMAILS / ADMIN_KEY, because "may use every feature" and "may
 * read across tenants" must not be the same switch.
 */
export function operatorPlan(tenant: string): string | null {
  const list = (process.env.OPERATOR_TENANTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.includes(tenant)) return null;
  return (process.env.OPERATOR_PLAN || 'enterprise').trim() || 'enterprise';
}

/** The tenant's recorded plan, or null. Empty on self-host, where the licence —
 *  not a plan — decides, and the resolver ignores this value entirely. */
export async function tenantPlan(tenant: string): Promise<string | null> {
  if (!billingEnabled()) return null;
  // Before the cache: an operator's plan comes from configuration, so a stale
  // cached row must not outrank it, and a control-plane round trip is pointless.
  const operator = operatorPlan(tenant);
  if (operator) return operator;
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
 * The tenant's quantitative limits (window, quotas, meters).
 *
 * Keyed on ENTITLEMENT, not on parsing the plan string: a live entitlement is
 * proof of payment (or a granted trial), and meters exist only for the free
 * floor. Resolving limits through plan-name prefixes metered real payers —
 * a subscription created in the Stripe dashboard or via a payment link records
 * plan as a raw price id (or null), no prefix matches, and the paying customer
 * got a 7-day window and a 402 at 50 MB. Features may fail closed on an
 * unrecorded plan; TAKING SOMEONE'S MONEY WHILE METERING THEM may not.
 *
 * Self-host is never metered — it runs on the operator's own hardware.
 */
export async function tenantLimits(tenant: string): Promise<PlanLimits> {
  if (!billingEnabled()) return FULL_LIMITS;
  if (!(await isEntitled(tenant))) return dormantLimits();
  // One exception to "entitled means unmetered": OUR no-card trial, which is the
  // only plan that ingests without a card. It is safe to key on the plan string
  // here — and only here — because `plan: 'trial'` is written by ensureTrial and
  // by nothing else. A Stripe CARD trial records its real plan (solo, team), so
  // it stays unmetered, which is the point: that customer gave us a card.
  const plan = (await tenantPlan(tenant))?.toLowerCase() ?? '';
  return plan.startsWith('trial') ? trialLimits() : FULL_LIMITS;
}

/**
 * The free-tier read window, resolved once per request. `floorMs` is set only
 * when a window applies; routes clamp their queries to it. One helper rather
 * than the same four lines in every route: the copies were already five when
 * this was extracted, and a route that windows results but forgets the
 * response keys shows truncated data with no locked-history offer.
 */
export async function searchWindow(tenant: string): Promise<{ days: number | null; floorMs?: number }> {
  const { searchWindowDays } = await tenantLimits(tenant);
  return typeof searchWindowDays === 'number'
    ? { days: searchWindowDays, floorMs: Date.now() - searchWindowDays * 86_400_000 }
    : { days: null };
}

/** The windowed-response envelope: spread into the JSON only when a window is
 *  active, so the paid response shape stays byte-identical. */
export function windowMeta(
  w: { days: number | null; floorMs?: number },
  lockedOlder?: number | null,
): Record<string, number> {
  if (w.floorMs === undefined || w.days === null) return {};
  return { window_days: w.days, ...(lockedOlder != null ? { locked_older: lockedOlder } : { locked_older: 0 }) };
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
 * util/trial.ts) and is entitled for its duration.
 *
 * ONE flag skips this check: OPERATOR_TENANTS (see operatorPlan above), which
 * exists so the people running the service are not locked out of it by their own
 * trial clock. It is an allowlist of named slugs, so it cannot widen by accident
 * the way a boolean "dev mode" does — and every other tenant still gets a real
 * entitlement row, which is what keeps this path exercised in production.
 *
 * Fail-closed on cloud: an unknown status or a past period resolves to NOT
 * entitled.
 */
export async function isEntitled(tenant: string): Promise<boolean> {
  if (!billingEnabled()) return true;
  // Ahead of the cache and the control plane, for the same reason as in
  // tenantPlan: configuration outranks a row, and asking costs a round trip.
  if (operatorPlan(tenant)) return true;

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
const confirmationCache = new TenantTtlCache<boolean>(30_000);

async function needsEmailConfirmation(tenant: string): Promise<boolean> {
  // Cached like isEntitled, because this runs on the REFUSED path — abandoned
  // unverified signups whose CLI retries are exactly the tenants who must not
  // generate a control-plane query per attempt.
  const cached = confirmationCache.get(tenant);
  if (cached !== undefined) return cached;
  let needs = false;
  try {
    const cp = await createControlPlane();
    try {
      // An existing entitlement row means the trial was granted at some point,
      // so confirmation is not what is missing — they lapsed.
      needs = !(await cp.getEntitlement(tenant)) && !(await cp.hasVerifiedMember(tenant));
    } finally {
      await cp.close();
    }
  } catch {
    needs = false;
  }
  confirmationCache.set(tenant, needs);
  return needs;
}

/**
 * Express middleware: the entitlement gate. Mount AFTER tenantAuth so
 * `req.tenant` is resolved. On self-host this is a transparent pass-through
 * (isEntitled → true).
 *
 * A tenant with no live entitlement is REFUSED here, reads included. Until
 * 2026-08-25 this passed every GET through, so a lapsed account kept answering
 * from the corpus it had at the moment it lapsed. That was the wrong trade: a
 * memory product whose memory stopped last month is not a cheaper product, it is
 * a wrong one, and the staleness banner that was supposed to carry the caveat
 * only works on an agent that reads banners.
 *
 * Two surfaces deliberately do NOT carry this gate, and must not gain it:
 *   - /api/data — export and delete. Refusing to hand back or erase data
 *     someone uploaded is a different category of problem from withholding a
 *     feature.
 *   - /api/status, /api/health, /api/account, /api/billing, /api/teams — the
 *     routes a person needs in order to see this state and fix it.
 *
 * The other refusal here: a tenant that never confirmed an email address. That
 * is the anti-abuse gate, and its message names the inbox rather than the
 * pricing page, because that is the actual fix.
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
      // CORS preflight carries no credentials and reads nothing. Refusing it
      // makes the browser report a CORS failure instead of the 402 the app
      // needs to render, which hides the one message that explains the state.
      if (req.method === 'OPTIONS') return next();
      if (await needsEmailConfirmation(tenant)) {
        res.status(402).json({
          error: 'email confirmation required',
          detail: 'Confirm your email address to start your trial. Nothing is counting down until you do.',
          resendHint: 'POST /api/auth/send-verification-email to get another link',
        });
        return;
      }
      res.status(402).json(noPlanPayload());
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
  // DORMANT tenants do not ingest. This is a plan gate, not a meter: since
  // 2026-08-22 a lapsed trial keeps reading its whole history and stops adding
  // to it, so the meters that used to be the only brake are null here and would
  // have admitted the batch. Reads are untouched — the refusal is on this path
  // only, which is ingest.
  const plan = await effectivePlan(tenant);
  if (!allows(plan, 'sync')) {
    return { ok: false, status: 402, body: syncOffPayload() };
  }
  // tenantLimits, not a re-derivation: exactly one place says what a plan
  // meters, or a future grace-period change makes the meters disagree with
  // every other gate. The entitlement lookups behind it are TTL-cached.
  const limits = await tenantLimits(tenant);
  if (limits.syncBytesPerMonth === null && limits.syncStorageBytes === null) {
    return { ok: true, limits };
  }
  const month = currentUsageMonth();
  const cp = await createControlPlane();
  try {
    const u = await cp.getSyncUsage(tenant, month);
    // The two meters measure DIFFERENT things, on purpose. The monthly QUOTA
    // meters ingest TRAFFIC (the processing we pay for), so it counts every
    // accepted batch. The STORAGE cap meters what is actually stored — the CLI
    // legitimately re-ships a session whenever it grows, and billing traffic
    // as storage made a 3 MB session synced twenty times read as 60 MB,
    // permanently. Measuring reality also makes deletes self-correcting.
    const storedBytes = await tenantStoredBytes(tenant);
    if (limits.syncStorageBytes !== null && storedBytes + incomingBytes > limits.syncStorageBytes) {
      return { ok: false, status: 402, body: limitReached('sync_storage', storedBytes, limits.syncStorageBytes) };
    }
    if (limits.syncBytesPerMonth !== null && u.monthBytes + incomingBytes > limits.syncBytesPerMonth) {
      return { ok: false, status: 402, body: limitReached('sync_quota', u.monthBytes, limits.syncBytesPerMonth, nextMonthStartMs()) };
    }
  } finally {
    await cp.close();
  }
  return { ok: true, limits };
}

/** 10-minute cache on the stored-bytes measurement: the sums scan the
 *  tenant's rows, and the meter does not need per-batch precision. */
const storedBytesCache = new TenantTtlCache<number>(600_000);

/** Bytes this tenant actually stores (chunks + rendered conversations),
 *  measured, cached. Fails open to 0 — a broken measurement must refuse
 *  nobody. */
export async function tenantStoredBytes(tenant: string): Promise<number> {
  const cached = storedBytesCache.get(tenant);
  if (cached !== undefined) return cached;
  let bytes = 0;
  try {
    // runWithTenant: the admission path runs BEFORE the route's own tenant
    // scoping, and an unscoped store would measure the wrong tenant.
    bytes = await runWithTenant(tenant, async () => {
      const store = await createStore();
      try { return Number(await store.approxStoredBytes()) || 0; }
      finally { await store.close(); }
    });
  } catch { bytes = 0; }
  storedBytesCache.set(tenant, bytes);
  return bytes;
}

/** Delete-all just removed (nearly) everything — reflect that immediately
 *  instead of refusing syncs for up to one cache TTL on an empty account. */
export function noteStorageWiped(tenant: string): void {
  storedBytesCache.set(tenant, 0);
}

/**
 * Record an ACCEPTED batch's bytes. Called after a successful ingest, not
 * before — a batch the server failed to write must not consume quota. Recorded
 * for every cloud tenant, paid included: the running total is what makes a
 * later downgrade honest (a heavy user who drops to free is already over the
 * storage cap, which is the correct outcome, not a loophole).
 */
export async function recordSyncUsage(tenant: string, bytes: number): Promise<void> {
  // bytes < 0, not <= 0: a ZERO write is the presence marker (see
  // recordSyncPresence) — the upsert creates the row without touching quota.
  if (!billingEnabled() || !Number.isFinite(bytes) || bytes < 0) return;
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
  // One writer, two names: this is recordSyncUsage's zero-byte case, kept as
  // its own export so call sites say what they mean. Two bodies drifted once
  // reviewed as a risk — a retry added to one and not the other would stop
  // presence rows, and the retention sweep purges whoever stops marking.
  return recordSyncUsage(tenant, 0);
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
    hint: 'Solo self-hosting is free and unlimited, task board and Toolkit included. Only collaboration needs the Team plan or a licence.',
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
