/**
 * The no-card trial waits for a confirmed email address.
 *
 * The trial is the only thing that grants ingest, embeddings and summaries, so it
 * is the only thing a bot signup could make expensive. It is gated here rather
 * than on sign-in on purpose: better-auth's requireEmailVerification blocks the
 * FIRST login, so one flaky SMTP send would lock a new user out of an account
 * they had just created.
 *
 * The properties that matter, and that a future refactor must not lose:
 *   1. Unconfirmed address ⇒ no trial row is written at all.
 *   2. Confirming later ⇒ the trial starts then, at full length.
 *   3. A trial ALREADY running is never revoked by this check.
 *   4. A control plane with no way to answer (self-host, tests) does not gate.
 */
import { describe, test, expect } from 'vitest';
import { ensureTrial, trialLengthDays } from './trial.js';

type Ent = {
  status?: string; plan?: string | null; currentPeriodEnd?: number | null;
} | null;

/** Minimal control plane: an entitlement row plus a verification answer. */
function fakeCp(opts: { verified?: boolean; existing?: Ent; omitVerifyFn?: boolean }) {
  let row: Ent = opts.existing ?? null;
  const cp: any = {
    getEntitlement: async () => row,
    setEntitlement: async (_t: string, patch: Record<string, unknown>) => {
      row = { ...(row ?? {}), ...patch } as Ent;
    },
  };
  if (!opts.omitVerifyFn) cp.hasVerifiedMember = async () => !!opts.verified;
  return { cp, get row() { return row; } };
}

describe('ensureTrial + email confirmation', () => {
  test('an unconfirmed address gets NO trial, and no row is written', async () => {
    const f = fakeCp({ verified: false });
    const ent = await ensureTrial(f.cp, 'tenant-a');
    expect(ent).toBeNull();
    // Nothing persisted: the tenant must be able to get a full trial later, and a
    // half-written row would make ensureTrial's "already had its trial" check
    // refuse them for ever.
    expect(f.row).toBeNull();
  });

  test('confirming later starts the trial then, at full length', async () => {
    const f = fakeCp({ verified: false });
    expect(await ensureTrial(f.cp, 'tenant-b')).toBeNull();

    f.cp.hasVerifiedMember = async () => true;      // they clicked the link
    const now = 1_800_000_000_000;
    const ent = await ensureTrial(f.cp, 'tenant-b', now);

    expect(ent?.status).toBe('trialing');
    expect(ent?.plan).toBe('trial');
    const days = Math.round(((ent?.currentPeriodEnd ?? 0) - now) / 86_400_000);
    expect(days).toBe(trialLengthDays());
  });

  test('a trial already running is never revoked, even if verification now says no', async () => {
    // Guards the ordering inside ensureTrial: the existing-row branch returns
    // BEFORE the verification check. If those two were ever swapped, a live
    // trial would vanish the moment this lookup failed or a member was removed.
    const live = { status: 'trialing', plan: 'trial', currentPeriodEnd: Date.now() + 86_400_000 };
    const f = fakeCp({ verified: false, existing: live });
    const ent = await ensureTrial(f.cp, 'tenant-c');
    expect(ent?.status).toBe('trialing');
    expect(ent?.currentPeriodEnd).toBe(live.currentPeriodEnd);
  });

  test('a lapsed row is not re-granted, confirmed or not', async () => {
    const lapsed = { status: 'canceled', plan: 'solo-monthly', currentPeriodEnd: Date.now() - 86_400_000 };
    for (const verified of [true, false]) {
      const f = fakeCp({ verified, existing: lapsed });
      const ent = await ensureTrial(f.cp, 'tenant-d');
      expect(ent?.status, `verified=${verified}`).toBe('canceled');
    }
  });

  test('a control plane that cannot answer does not gate', async () => {
    // Self-host has no auth tables to ask, and the test doubles elsewhere in the
    // suite do not implement this method. Denying every trial there would be a
    // far worse failure than the abuse the gate prevents.
    const f = fakeCp({ omitVerifyFn: true });
    const ent = await ensureTrial(f.cp, 'tenant-e');
    expect(ent?.status).toBe('trialing');
  });
});
