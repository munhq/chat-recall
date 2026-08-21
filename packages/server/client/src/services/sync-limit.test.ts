/**
 * A full free-tier meter must not present as a broken product OR as a paywall.
 *
 * The server answers a full sync meter with 402 { error, kind, used, limit,
 * resetsAt?, requires, upgradeUrl } (util/entitlements.ts limitReached). That is
 * a third kind of 402 — the tenant is fine, one meter is full — so the client
 * must recognise it (SyncLimitError), keep the numbers, and never confuse it
 * with a feature gate or the whole-account paywall.
 */
import { describe, it, expect } from 'vitest';
import { throwForResponse, parseSyncLimit, SyncLimitError, FeatureGateError } from './api';

/** A Response whose statusText is '' — what HTTP/2 actually delivers. */
function res(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

const QUOTA_BODY = {
  error: 'monthly sync quota reached — sync resumes next month, or upgrade for unmetered sync',
  kind: 'sync_quota',
  used: 52_428_800,
  limit: 52_428_800,
  resetsAt: 1_756_684_800_000,
  requires: 'solo',
  upgradeUrl: 'https://chatrecall.dev/pricing',
};

describe('parseSyncLimit', () => {
  it('recognises both meter kinds and carries the numbers through', () => {
    const p = parseSyncLimit(QUOTA_BODY);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('sync_quota');
    expect(p!.used).toBe(52_428_800);
    expect(p!.limit).toBe(52_428_800);
    expect(p!.resetsAt).toBe(1_756_684_800_000);

    const storage = parseSyncLimit({ error: 'storage cap reached', kind: 'sync_storage', used: 1, limit: 2 });
    expect(storage!.kind).toBe('sync_storage');
    // The storage cap does not reset — the field is honestly absent, not 0.
    expect(storage!.resetsAt).toBeUndefined();
  });

  it('returns null for anything that is not a limit payload', () => {
    expect(parseSyncLimit(null)).toBeNull();
    expect(parseSyncLimit('sync_quota')).toBeNull();
    expect(parseSyncLimit({ error: 'subscription required' })).toBeNull();
    // A feature-level 402 carries `feature`, never `kind` — it is a gate.
    expect(parseSyncLimit({ error: 'needs team', feature: 'toolkit', requires: 'team' })).toBeNull();
    // Right kind, wrong shape: without numbers there is nothing to render.
    expect(parseSyncLimit({ kind: 'sync_quota', used: '50', limit: 100 })).toBeNull();
  });
});

describe('throwForResponse on a limit-level 402', () => {
  it('throws a SyncLimitError carrying the meter, not a bare failure', async () => {
    await expect(throwForResponse(res(402, QUOTA_BODY), 'Sync refused'))
      .rejects.toBeInstanceOf(SyncLimitError);

    const err = await throwForResponse(res(402, QUOTA_BODY), 'x').catch((e) => e as SyncLimitError);
    expect(err.kind).toBe('sync_quota');
    expect(err.used).toBe(52_428_800);
    expect(err.limit).toBe(52_428_800);
    expect(err.resetsAt).toBe(1_756_684_800_000);
    expect(err.upgradeUrl).toBe('https://chatrecall.dev/pricing');
    expect(err.message).toMatch(/quota/);
  });

  it('still resolves a feature-level 402 to a FeatureGateError — the kinds never cross', async () => {
    const gate = await throwForResponse(
      res(402, { error: 'this feature requires the team plan', feature: 'toolkit', requires: 'team' }),
      'x',
    ).catch((e) => e);
    expect(gate).toBeInstanceOf(FeatureGateError);
    expect(gate).not.toBeInstanceOf(SyncLimitError);
  });

  it('leaves a whole-account 402 as an ordinary error', async () => {
    const err = await throwForResponse(res(402, { error: 'subscription required' }), 'Failed')
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(SyncLimitError);
    expect(err).not.toBeInstanceOf(FeatureGateError);
    expect(err.message).toBe('Failed: subscription required');
  });
});
