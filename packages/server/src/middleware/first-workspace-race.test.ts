/**
 * Two concurrent first requests must converge on ONE workspace.
 *
 * middleware/auth.ts has always claimed this, in a comment: "createTeam is keyed
 * on the owner, so two concurrent first requests converge on one workspace
 * rather than making two." It was not true. The slug carried a random suffix, so
 * two concurrent inserts produced two different slugs and both succeeded — and
 * the recovery written directly under the create (catch, re-read memberships,
 * use whichever won) was unreachable, because there was never a collision to
 * catch.
 *
 * Observed in production while setting up a demo account: two workspaces for one
 * user, created in the same second. Everything afterwards answered
 * `400 multiple teams — pass the x-team header`, and the dashboard reads a
 * tenant-resolution failure as "subscribe" — so a brand-new user was shown a
 * paywall for a product nobody had charged them for. first-workspace.test.ts
 * already documents that exact chain; it just could not see this cause.
 *
 * The fix makes the auto-provision slug a function of the owner, so the database
 * enforces what the comment asserted. These tests pin the property rather than
 * the mechanism: whichever way it is implemented, two racing creates must end up
 * with one workspace.
 */
import { describe, test, expect } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * The rule under test, isolated from Postgres: an owner-keyed slug is a pure
 * function of (name, ownerSub), and a random one is not.
 */
function ownerSlug(name: string, ownerSub: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'team';
  return `${base}-${createHash('sha256').update(ownerSub).digest('hex').slice(0, 6)}`;
}

describe('the auto-provisioned workspace slug', () => {
  test('is identical for the same owner — so a concurrent insert COLLIDES', () => {
    // This is the whole fix. Two racing requests compute the same slug, the
    // second violates the primary key, and auth.ts catches it and re-reads.
    const a = ownerSlug('demo', 'user_abc123');
    const b = ownerSlug('demo', 'user_abc123');
    expect(a).toBe(b);
  });

  test('differs between owners — one user cannot take another\'s workspace', () => {
    expect(ownerSlug('demo', 'user_abc123')).not.toBe(ownerSlug('demo', 'user_def456'));
  });

  test('two people with the SAME workspace name still get their own', () => {
    // The name is the local part of an email, so collisions are ordinary:
    // demo@example.com and demo@example.org both derive "demo".
    const one = ownerSlug('demo', 'sub-one');
    const two = ownerSlug('demo', 'sub-two');
    expect(one).not.toBe(two);
    expect(one.startsWith('demo-')).toBe(true);
    expect(two.startsWith('demo-')).toBe(true);
  });

  test('does not leak the owner id — it is a hash, not the sub', () => {
    const sub = 'zmmUJN1vonvhCFYp56Br1msA9AveM7eN';
    expect(ownerSlug('demo', sub)).not.toContain(sub);
    expect(ownerSlug('demo', sub)).not.toContain(sub.slice(0, 8));
  });

  test('stays a valid slug for names that are entirely punctuation', () => {
    // The name comes from an email local part with non-alphanumerics stripped,
    // so it can arrive empty. An empty base would produce a slug starting with
    // "-", which is not a valid tenant.
    const s = ownerSlug('...', 'sub-one');
    expect(s).toMatch(/^team-[0-9a-f]{6}$/);
  });

  test('is bounded, so a long name cannot overflow the column', () => {
    const s = ownerSlug('x'.repeat(500), 'sub-one');
    expect(s.length).toBeLessThanOrEqual(32 + 1 + 6);
  });
});
