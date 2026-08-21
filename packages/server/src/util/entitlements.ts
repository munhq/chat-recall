/**
 * ONE resolver for "what may this tenant do?".
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The same question was being answered in two places by two mechanisms: cloud
 * asked `planGrantsTeam(plan)`, self-host asked `hasFeature('team')`. They
 * disagreed, and every time they disagreed it shipped:
 *
 *   - `requireTeamFeature` returns early on cloud ("the subscription governs"),
 *     but the only check beside it is isEntitled — which any TRIALING or SOLO
 *     tenant passes. So /api/activity, /api/tasks and /api/shares were guarded
 *     by "has any subscription", not "has Team".
 *   - `collaborationOr402` got the plan check; those three mounts never did.
 *   - `teamFeatureOr402` was a third copy that drifted and had to be deleted.
 *
 * Adding more paid features to that shape would multiply the divergence, so the
 * decision moves here. Cloud maps PLAN → features; self-host reads the signed
 * licence. Everything else asks this module and nothing reads a plan name or a
 * licence directly.
 *
 * ── Enforcement is server-side, always ────────────────────────────────────
 *
 * The CLI and the MCP server run on the user's machine, so a gate there is a line
 * they delete. They may READ this (to explain why something is unavailable) but
 * never decide it.
 */
import { hasFeature, licenseState, licensedSeats, seatCheck, type LicenseFeature } from './license.js';
import { activatedEntitlement } from './licence-activation.js';
import { billingEnabled } from './billing.js';

/**
 * The always-free capabilities. Never licensable, never gated, in any edition —
 * so no licence or plan can withhold them, by construction.
 */
export type FreeFeature =
  /** Index, search, recall, knowledge graph, notes, plans, diary. Always free:
   *  this IS the product's promise, and gating it means the free tier no longer
   *  demonstrates anything. */
  | 'memory'
  /** The one-time secret-leak verdict. Free because it runs locally, costs us
   *  nothing, and is the only surface that pays out on day one — a memory product
   *  is worth nothing until memory has accumulated. Monitoring is 'alerts'. */
  | 'scan';

/** Everything a tenant might be allowed to do: the free base plus the licensable
 *  set. LicenseFeature is imported rather than restated so the licence and the
 *  gate cannot name features differently. */
export type Feature = FreeFeature | LicenseFeature;

/** Every licensable feature, for iteration. Derived from one list. */
const LICENSABLE: readonly LicenseFeature[] =
  ['sync', 'alerts', 'findings', 'insights', 'tasks', 'team', 'toolkit', 'sso', 'audit'];

/** Free everywhere, in every edition, licensed or not. */
export const FREE_FEATURES: readonly Feature[] = ['memory', 'scan'];

/**
 * PLAN → features, for the hosted service. The single place packaging lives:
 * repackaging is an edit here, not a code change at any call site.
 *
 * Keys are matched by PREFIX so a new price (team-quarterly, solo-2027) needs no
 * entry — the same rule planGrantsTeam already used, kept deliberately.
 */
const PLAN_FEATURES: Array<{ prefix: string; features: readonly Feature[]; purchasable?: boolean }> = [
  { prefix: 'enterprise', features: ['memory', 'scan', 'sync', 'alerts', 'findings', 'insights', 'tasks', 'team', 'toolkit', 'sso', 'audit'] },
  { prefix: 'team',       features: ['memory', 'scan', 'sync', 'alerts', 'findings', 'insights', 'tasks', 'team', 'toolkit'] },
  { prefix: 'solo',       features: ['memory', 'scan', 'sync', 'alerts', 'findings', 'insights', 'tasks', 'toolkit'] },
  // The no-card trial grants the FULL product, team included: a trial is the
  // demo, and a demo that hides collaboration sells Solo to people who came
  // for Team. The clean states are: trialing = everything works; lapsed = the
  // free floor (team disappears); paid = exactly what the plan names. Invites
  // during a trial are capped in routes/team-artifacts.ts (no subscription =
  // no bought seats), so "try Team" cannot become "run a company on re-trials".
  // purchasable:false — a trial is granted, never bought, so featureRequired()
  // must not offer it as the tier to upgrade to.
  { prefix: 'trial',      features: ['memory', 'scan', 'sync', 'alerts', 'findings', 'insights', 'tasks', 'team', 'toolkit'], purchasable: false },
  // The FREE TIER — what a lapsed no-card trial resolves to (see effectivePlan in
  // util/billing.ts). Never bought, never granted by a webhook: it is the floor a
  // cloud tenant lands on when their entitlement stops being live. It keeps 'sync'
  // — the daily habit — but sync is METERED (limitsFor below), and search is
  // WINDOWED. Everything older stays stored and locked: the locked history is the
  // upgrade offer, so this plan deliberately does not include the analysis tiers.
  { prefix: 'free',       features: ['memory', 'scan', 'sync'], purchasable: false },
  // The SELF-HOST licence. Same grant as Solo, bought as a subscription, delivered
  // as a licence key rather than as access to our servers. Listed last so the
  // cheapest-tier scan in featureRequired() still names 'solo' for a cloud user —
  // telling a SaaS customer to go self-host would be a strange upgrade prompt.
  { prefix: 'selfhost',   features: ['memory', 'scan', 'sync', 'alerts', 'findings', 'insights', 'tasks', 'toolkit'], purchasable: false },
];

/**
 * What a recorded plan grants. Unknown or absent plans get the FREE set and
 * nothing more — fail closed, since the alternative hands paid features to a row
 * whose plan we failed to record (which is exactly what happened when
 * checkout.session.completed dropped the plan and every entitlement held NULL).
 */
export function planFeatures(plan: string | null | undefined): Set<Feature> {
  if (!plan) return new Set(FREE_FEATURES);
  const p = plan.toLowerCase();
  const hit = PLAN_FEATURES.find((e) => p.startsWith(e.prefix));
  return new Set(hit ? hit.features : FREE_FEATURES);
}

/**
 * What one person running their own server gets, free, forever.
 *
 * This is the Solo set, NOT the FREE set, and the difference is the whole
 * adoption argument. Charging a self-hoster for sync, findings, alerts and
 * insights taxes exactly the people who evaluate the product, write about it and
 * bring teams to it — while earning almost nothing, because a single-seat
 * self-host licence is too small to matter as revenue and too large to be
 * frictionless. They also supply their own hardware, Postgres, backups and
 * operations, so charging them the SAME price as the fully-hosted Solo plan is a
 * worse deal for more work.
 *
 * What is protected instead:
 *   - COLLABORATION ('team') — a second identity means a company, and a company
 *     has budget. identityLimit() already caps unlicensed self-host at one
 *     person, so this boundary is people, not machines.
 *
 *   - 'toolkit' and 'tasks' — in the hosted SOLO set, deliberately NOT in the free
 *     self-host set below. On capability grounds both are single-player and could
 *     sit here; the reason to withhold them is commercial, and it turns on the
 *     fact that this door only opens one way. Adding a feature to a free tier
 *     later is a gift nobody objects to. Taking one away is the open-core
 *     rug-pull story. So they stay out until there is a reason to move them,
 *     which keeps that option alive. A free self-hoster having less than a PAYING
 *     cloud customer needs no defence.
 *
 *     This is also what makes a ONE-seat self-host licence honest: without these
 *     two it granted 'team' to a deployment capped at one identity — nobody to
 *     collaborate with, nothing gained, money taken.
 *   - 'sso' and 'audit' — enterprise procurement features.
 *   - Reselling — Elastic License 2.0 forbids offering this as a hosted service,
 *     which is the actual moat. A $15 licence was never the thing stopping a
 *     competitor.
 *
 * The hosted SaaS is unaffected: it bills per plan and never reads this.
 */
export const SELFHOST_FREE_FEATURES: readonly Feature[] =
  ['memory', 'scan', 'sync', 'alerts', 'findings', 'insights'];

/**
 * What this DEPLOYMENT's licence grants, for self-host. The free tier is the
 * self-host free set above; a valid licence adds whatever it names.
 *
 * Self-host has no per-tenant billing, so this is deployment-wide by design.
 */
/**
 * May this deployment use an external identity provider?
 *
 * Pure so it can be tested: the gate itself runs at boot in server.ts, where a
 * wrong answer means either a locked-out operator or a feature given away. It was
 * given away — 'sso' sat in the plan map and on the pricing page with nothing
 * checking it, which is why this is a function with a test rather than an inline
 * condition.
 *
 * @param provider  the configured AUTH_PROVIDER
 * @param hosted    billingEnabled() — the hosted service, where the operator's own
 *                  IdP choice is not a customer entitlement
 * @param licensed  whether the deployment's licence grants 'sso'
 */
export function ssoAllowed(
  provider: string,
  opts: { hosted: boolean; licensed: boolean },
): boolean {
  if (provider !== 'keycloak') return true;   // built-in auth is always included
  if (opts.hosted) return true;               // our own deployment, not a grant
  return opts.licensed;
}

export function licenceFeatures(): Set<Feature> {
  // Self-host only. planFeatures() still starts an unknown CLOUD plan at
  // FREE_FEATURES — widening that would hand the paid tier to every tenant whose
  // plan failed to record, which is the exact bug the fail-closed default exists
  // to prevent.
  const out = new Set<Feature>(SELFHOST_FREE_FEATURES);

  // TWO paths, deliberately, and a feature from either counts.
  //
  //   offline key  — CHAT_RECALL_LICENSE, a signed grant. Works air-gapped, cannot
  //                  be revoked. Kept for customers who require it.
  //   activation   — CHAT_RECALL_LICENSE_SERIAL exchanged for a short-lived
  //                  entitlement. Revocable, countable, billable monthly.
  //
  // Union rather than precedence: a customer migrating from one to the other must
  // never lose access mid-flight because both were briefly present.
  const st = licenseState();
  if (st.valid) {
    // Read through hasFeature so signature/expiry checks are not duplicated here.
    for (const f of LICENSABLE) {
      if (hasFeature(f)) out.add(f);
    }
  }

  const online = activatedEntitlement();
  if (online) {
    for (const f of online.features) {
      if ((LICENSABLE as readonly string[]).includes(f)) out.add(f as Feature);
    }
  }
  return out;
}

/**
 * How many distinct human identities this deployment or tenant may hold.
 *
 * THE UNLICENSED CASE IS 1, NOT UNLIMITED. seatCheck() previously returned ok
 * when no seat count was known, treating "unlicensed" and "site licence" as the
 * same thing — so any number of people could each sign up on one free
 * deployment and get their own tenant. Invites were gated; self-registration was
 * not, which made the invite gate decorative.
 *
 * Cloud returns null (unlimited here): seats there are the subscription's
 * quantity, validated against real member count at checkout, so this is not the
 * place that decides it.
 */
export function identityLimit(): number | null {
  if (billingEnabled()) return null;         // cloud: the subscription decides

  const offlineSeats = licensedSeats();
  const online = activatedEntitlement();
  const onlineSeats = typeof online?.seats === 'number' && online.seats > 0
    ? Math.floor(online.seats) : null;

  // The most generous of the two, for the same reason licenceFeatures() unions:
  // a customer holding both must not be penalised for it.
  if (offlineSeats !== null || onlineSeats !== null) {
    return Math.max(offlineSeats ?? 0, onlineSeats ?? 0);
  }
  // No seat count anywhere. A valid grant with no seats is a site licence; nothing
  // at all is the free tier, which is ONE person.
  return (licenseState().valid || online) ? null : 1;
}

/**
 * The resolved feature set for a tenant.
 *
 * `plan` is the tenant's recorded plan on cloud, ignored on self-host. Passing it
 * in rather than looking it up keeps this pure and cheap: the callers already
 * hold the entitlement row.
 */
export function featuresFor(plan: string | null | undefined): Set<Feature> {
  return billingEnabled() ? planFeatures(plan) : licenceFeatures();
}

/** Whether a tenant on `plan` has `feature`. The only question callers ask. */
export function allows(plan: string | null | undefined, feature: Feature): boolean {
  return featuresFor(plan).has(feature);
}

/**
 * Whether one more identity may join, accounting for edition.
 *
 * seatCheck() in license.ts is the LICENCE primitive and returns ok when it knows
 * no seat count — which conflates "site licence" with "no licence at all". That is
 * why an unlicensed deployment accepted unlimited members. This wrapper resolves
 * the edition first and is what routes must call.
 */
export function identityCheck(current: number): { ok: true } | { ok: false; used: number; limit: number } {
  const limit = identityLimit();
  if (limit === null) {
    // Cloud, or a genuine site licence: defer to the licence primitive, which is
    // a no-op in both cases but keeps one code path.
    const r = seatCheck(current);
    return r.ok ? { ok: true } : { ok: false, used: r.used, limit: r.seats };
  }
  return current < limit ? { ok: true } : { ok: false, used: current, limit };
}

/**
 * Quantitative limits, the second axis next to the boolean feature set.
 *
 * Features answer "may this tenant use X at all"; limits answer "how much".
 * They exist for the free tier, whose whole design is metered rather than
 * withheld: sync keeps working (quota), search keeps working (window), and the
 * two costs that are actually metered upstream — summaries and embeddings —
 * are simply off. Embeddings being off is an INTERNAL cost control: vectors are
 * never a stated feature anywhere user-facing, so nothing here may leak into
 * pricing copy.
 *
 * Numbers are read live from env so a limit change is a config edit, not a
 * deploy — the same rule as FREE_TRIAL_DAYS.
 */
export interface PlanLimits {
  /** Days of history the search/list surfaces reach back. null = unlimited. */
  searchWindowDays: number | null;
  /** Sync payload bytes accepted per calendar month. null = unmetered. */
  syncBytesPerMonth: number | null;
  /** Total synced bytes before sync pauses (data is kept). null = uncapped. */
  syncStorageBytes: number | null;
  /** Whether this tenant's sessions receive AI summaries. */
  summaries: boolean;
  /** Whether this tenant's chunks are embedded. Internal cost control only. */
  embeddings: boolean;
  /** Multiplier on the per-tenant rate-limit budgets (middleware/rate-limit). */
  rateMultiplier: number;
}

const MB = 1024 * 1024;
const envNum = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

export const FULL_LIMITS: PlanLimits = Object.freeze({
  searchWindowDays: null,
  syncBytesPerMonth: null,
  syncStorageBytes: null,
  summaries: true,
  embeddings: true,
  rateMultiplier: 1,
});

/** The free tier's meters. 7-day window; 50 MB/month; 300 MB total — exactly six
 *  months of locked history at full quota, so the cap and the quota describe one
 *  lifecycle instead of two unrelated numbers. */
export function freeLimits(): PlanLimits {
  return {
    searchWindowDays: envNum('FREE_SEARCH_WINDOW_DAYS', 7),
    syncBytesPerMonth: envNum('FREE_SYNC_MB_PER_MONTH', 50) * MB,
    syncStorageBytes: envNum('FREE_STORAGE_MB', 300) * MB,
    summaries: false,
    embeddings: false,
    rateMultiplier: 0.2,
  };
}

/**
 * Limits for a RESOLVED plan (pass effectivePlan's answer, not the raw row).
 *
 * Fail-closed like planFeatures: an unknown or absent plan gets the free tier's
 * meters, not unlimited — the alternative hands unmetered ingest to a row whose
 * plan failed to record. Self-host never reaches this (util/billing.ts returns
 * FULL_LIMITS before asking); a paid or trialing plan is unmetered.
 */
export function limitsFor(plan: string | null | undefined): PlanLimits {
  if (!plan) return freeLimits();
  const p = plan.toLowerCase();
  if (p.startsWith('free')) return freeLimits();
  // Any OTHER known plan is unmetered; unknown plans fail closed to the meters.
  return PLAN_FEATURES.some((e) => p.startsWith(e.prefix)) ? FULL_LIMITS : freeLimits();
}

/**
 * The canonical LIMIT refusal, sibling of featureRequired() below and shaped the
 * same way on purpose: one payload the dashboard, the CLI and an MCP-driven agent
 * all relay verbatim. `used`/`limit` are bytes; `resetsAt` is when the monthly
 * meter turns over (absent for the total-storage cap, which does not reset).
 */
export function limitReached(kind: 'sync_quota' | 'sync_storage', used: number, limit: number, resetsAt?: number): {
  error: string; kind: string; used: number; limit: number; resetsAt?: number; requires: string; upgradeUrl: string;
} {
  const msg = kind === 'sync_quota'
    ? 'monthly sync quota reached — sync resumes next month, or upgrade for unmetered sync'
    : 'storage cap reached — sync is paused; your data is kept. Upgrade for unmetered sync, or delete data you no longer need';
  return {
    error: msg,
    kind,
    used,
    limit,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    requires: 'solo',
    upgradeUrl: process.env.TRIAL_UPGRADE_URL || 'https://chatrecall.dev/pricing',
  };
}

/**
 * The canonical refusal payload. One shape everywhere, so the dashboard, the CLI
 * and an MCP-driven agent all surface the same actionable sentence — an agent that
 * relays "this needs the Team plan" is a better upgrade prompt than a hidden
 * capability the model cannot mention.
 */
export function featureRequired(feature: Feature): {
  error: string; feature: Feature; requires: string; upgradeUrl: string;
} {
  // Scan from the END. PLAN_FEATURES is ordered richest-first so prefix matching
  // stays most-specific-first, which means a plain find() returns 'enterprise' for
  // anything Enterprise includes — i.e. it would tell someone who needs Team to buy
  // Enterprise. The CHEAPEST tier that grants the feature is the honest answer, and
  // that is the last matching entry.
  const tier = [...PLAN_FEATURES].reverse()
    .filter((e) => e.purchasable !== false)
    .find((e) => e.features.includes(feature));
  const requires = billingEnabled() ? (tier ? tier.prefix : 'solo') : 'a licence';
  return {
    error: `this feature requires ${billingEnabled() ? `the ${requires} plan` : requires}`,
    feature,
    requires,
    upgradeUrl: process.env.TRIAL_UPGRADE_URL || 'https://chatrecall.dev/pricing',
  };
}
