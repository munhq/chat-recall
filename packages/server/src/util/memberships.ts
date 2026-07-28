/**
 * The one identity+memberships query behind both `/me` endpoints.
 *
 * `GET /api/me` (routes/teams.ts) and `GET /api/team/me`
 * (routes/team-artifacts.ts) run the identical `cp.listMemberships(user.sub)`
 * and differ only in how they name the fields on the way out:
 *
 *   /api/me       → { user, teams: [{ team_slug, name, role }] }        (raw rows)
 *   /api/team/me  → { user: {id,email}, memberships: [{teamId, teamName,
 *                     role, plan }] }                                   (renamed)
 *
 * Both shapes have live callers with committed contracts — the web client's
 * `MeInfo` and `engine/core/team-client.ts`'s `TeamMe` — so the routes stay, and
 * only the query is shared. Renaming happens at the edge, where it belongs.
 */

import { createControlPlane } from '../imports.js';

export interface MembershipRow {
  team_slug: string;
  name: string;
  role: string;
}

/** Raw membership rows for a Keycloak subject. Opens and closes its own
 *  control-plane connection, as both call sites did. */
export async function loadMemberships(userSub: string): Promise<MembershipRow[]> {
  const cp = await createControlPlane();
  try {
    return (await cp.listMemberships(userSub)) as MembershipRow[];
  } finally { await cp.close(); }
}

/**
 * Create a team owned by `userSub`, returning the raw control-plane row.
 *
 * Deliberately NOT entitlement-gated: team creation is the on-ramp to
 * subscribing. A cloud user logs in with no tenant, creates a team (= tenant),
 * THEN runs /api/billing/checkout for it — gating creation would deadlock that,
 * because checkout needs a membership to bill. The paid value (PUBLISH, INVITE)
 * is gated separately via entitledOr402.
 *
 * Both `POST /api/teams` and `POST /api/team` call this; they differ only in the
 * response envelope (`{slug,name,role}` vs `{team:{id,name}}`).
 */
export async function createTeamFor(
  userSub: string,
  // requireUser yields `string | null`; cp.createTeam wants `string | undefined`.
  email: string | null | undefined,
  name: string,
): Promise<{ slug: string; name: string }> {
  const cp = await createControlPlane();
  try {
    const t = await cp.createTeam(name, userSub, email ?? undefined);
    return { slug: t.slug, name: t.name };
  } finally { await cp.close(); }
}
