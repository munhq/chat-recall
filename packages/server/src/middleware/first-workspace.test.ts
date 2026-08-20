/**
 * A signed-in user with no workspace gets one, rather than a wall of 403s.
 *
 * Before this, resolveTenantForUser refused with "no team yet" whenever a user
 * had no membership. Every call a freshly signed-in user made answered 403 — a
 * burst per page load, visible in production logs — and the dashboard stayed
 * empty until something else created the team. The client reads that exact
 * message and shows the SUBSCRIBE screen, so a brand-new user met a paywall and
 * the workspace only came into being as that screen's side effect.
 *
 * The decision is isolated here from Express and the control plane, because the
 * rule is what matters: provision on first sight, tolerate a lost race, and only
 * refuse when we genuinely could not make one.
 */
import { describe, test, expect } from 'vitest';

type Membership = { team_slug: string };

/** The resolution rule, as the middleware applies it. */
async function resolve(
  memberships: Membership[],
  create: () => Promise<{ slug: string }>,
  reread: () => Promise<Membership[]>,
): Promise<{ tenant: string } | { refused: true }> {
  if (memberships.length === 1) return { tenant: memberships[0].team_slug };
  if (memberships.length === 0) {
    try {
      return { tenant: (await create()).slug };
    } catch {
      const retry = await reread();
      if (retry.length >= 1) return { tenant: retry[0].team_slug };
      return { refused: true };
    }
  }
  return { tenant: memberships[0].team_slug };
}

const never = async (): Promise<Membership[]> => [];

describe('first request from a user with no workspace', () => {
  test('provisions one instead of refusing', async () => {
    const r = await resolve([], async () => ({ slug: 'ada' }), never);
    expect(r).toEqual({ tenant: 'ada' });
  });

  test('a lost create race resolves to the workspace that won', async () => {
    // Two concurrent first requests: one creates, the other throws on the
    // unique constraint. The loser must use the winner's workspace, not 403.
    const r = await resolve(
      [],
      async () => { throw new Error('duplicate key'); },
      async () => [{ team_slug: 'ada' }],
    );
    expect(r).toEqual({ tenant: 'ada' });
  });

  test('refuses only when creation failed AND none exists', async () => {
    const r = await resolve([], async () => { throw new Error('db down'); }, never);
    expect(r).toEqual({ refused: true });
  });

  test('an existing member is untouched — no workspace is created for them', async () => {
    let created = 0;
    const r = await resolve(
      [{ team_slug: 'existing' }],
      async () => { created++; return { slug: 'new' }; },
      never,
    );
    expect(r).toEqual({ tenant: 'existing' });
    expect(created).toBe(0);
  });
});
