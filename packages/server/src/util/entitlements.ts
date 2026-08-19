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
  ['sync', 'alerts', 'findings', 'insights', 'team', 'toolkit', 'sso', 'audit'];

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
  { prefix: 'enterprise', features: ['memory', 'scan', 'sync', 'alerts', 'findings', 'insights', 'team', 'toolkit', 'sso', 'audit'] },
  { prefix: 'team',       features: ['memory', 'scan', 'sync', 'alerts', 'findings', 'insights', 'team', 'toolkit'] },
  { prefix: 'solo',       features: ['memory', 'scan', 'sync', 'alerts', 'findings', 'insights'] },
  // The no-card trial. Same grant as Solo, so the trial actually demonstrates the
  // product — a trial limited to the free tier sells nothing. It does NOT begin with
  // 'team', so planGrantsTeam() stays false and collaboration remains paid.
  // purchasable:false — a trial is granted, never bought, so featureRequired() must
  // not offer it as the tier to upgrade to. Without this it became the cheapest
  // match and told users to "buy the trial plan".
  { prefix: 'trial',      features: ['memory', 'scan', 'sync', 'alerts', 'findings', 'insights'], purchasable: false },
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
 * What this DEPLOYMENT's licence grants, for self-host. The free tier is the
 * FREE set; a valid licence adds whatever it names.
 *
 * Self-host has no per-tenant billing, so this is deployment-wide by design.
 */
export function licenceFeatures(): Set<Feature> {
  const out = new Set<Feature>(FREE_FEATURES);

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
