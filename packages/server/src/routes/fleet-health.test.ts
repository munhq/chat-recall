/**
 * The fleet panel exists because healthy and broken look identical everywhere
 * else. Its value is entirely in the WARNINGS, so what must be right is that
 * every real failure mode from 2026-08-02..04 produces one, and that a healthy
 * device produces none — a panel that always warns is a panel people stop
 * reading.
 *
 * These call the REAL `classifyDevice`. A first version of this file
 * re-implemented the route's logic inside its own harness, which meant it could
 * pass while the endpoint was broken: it was comparing a copy of the code with
 * itself. Extracting the classifier as a pure function is what made testing the
 * actual behaviour possible without a Postgres fleet.
 */
import { describe, test, expect } from 'vitest';
import { classifyDevice, compareCliVersions } from './fleet-health.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const dev = (o: Partial<Parameters<typeof classifyDevice>[0]> = {}) => ({
  deviceId: 'laptop', os: 'linux', cliVersion: '1.2.3', lastSeenAt: NOW - 60_000, ...o,
});
const act = (sessions = 100) => ({ sessions, lastSyncAt: NOW - 60_000 });
const src = (o: Record<string, unknown> = {}) => ({
  id: 'src_000000000000', tool: 'claude', path: '/h/.claude', sessions: 0, device: 'laptop', ...o,
} as Parameters<typeof classifyDevice>[2][number]);

describe('a healthy device produces NO warnings', () => {
  test('recent contact, sessions stored, every folder decided', () => {
    const h = classifyDevice(dev(), act(1200), [src({ decision: 'primary', sessions: 1200 })], NOW);
    expect(h.warnings).toEqual([]);
    expect(h.folders).toEqual({ syncing: 1, pending: 0, declined: 0 });
    expect(h.sessions).toBe(1200);
  });

  test('a weekend of no contact is not a warning', () => {
    const h = classifyDevice(dev({ lastSeenAt: NOW - 2 * DAY }), act(3), [src({ decision: 'primary' })], NOW);
    expect(h.warnings).toEqual([]);
  });

  test('a declined folder is a decision, not a problem', () => {
    const h = classifyDevice(dev(), act(3), [
      src({ decision: 'primary' }),
      src({ id: 'src_000000000001', decision: 'declined', sessions: 900, path: '/h/.claude-work' }),
    ], NOW);
    expect(h.warnings).toEqual([]);
    expect(h.folders.declined).toBe(1);
  });
});

describe('each real failure mode surfaces', () => {
  test('a folder nobody decided about — the case that stranded a work session', () => {
    const h = classifyDevice(dev(), act(10), [
      src({ decision: 'primary', sessions: 10 }),
      src({ id: 'src_000000000002', decision: 'pending', sessions: 342, path: '/h/.claude-work' }),
    ], NOW);
    // The session COUNT is what makes it actionable rather than a shrug.
    expect(h.warnings[0]).toBe('1 transcript folder waiting for a decision (342 sessions not being synced)');
    expect(h.folders.pending).toBe(1);
  });

  test('a device that stopped reporting', () => {
    const h = classifyDevice(dev({ lastSeenAt: NOW - 9 * DAY }), act(5), [src({ decision: 'primary' })], NOW);
    expect(h.warnings.join(' ')).toMatch(/no contact for 9 days/);
  });

  test('connected but storing nothing — distinct from being offline', () => {
    // The shape that looks fine in every other view: daemon alive and talking,
    // no data landing.
    const h = classifyDevice(dev(), null, [src({ decision: 'primary' })], NOW);
    expect(h.warnings.join(' ')).toMatch(/connected but has not stored any sessions/);
  });

  test('a CLI too old to report folders', () => {
    const h = classifyDevice(dev(), act(5), [], NOW);
    expect(h.warnings.join(' ')).toMatch(/has not reported which transcript folders/);
  });

  test('a device that never connected says so, and nothing else', () => {
    const h = classifyDevice(dev({ lastSeenAt: null }), null, [], NOW);
    expect(h.warnings.join(' ')).toMatch(/never connected/);
    // "never connected" must not also claim it is storing nothing or hiding
    // folders — one cause, one line, or the panel becomes noise.
    expect(h.warnings).toHaveLength(1);
  });
});

describe('warnings are scoped to the right device', () => {
  test("another device's pending folder is not reported here", () => {
    const h = classifyDevice(dev(), act(5), [
      src({ decision: 'primary' }),
      src({ id: 'src_000000000003', decision: 'pending', sessions: 500, device: 'other-machine' }),
    ], NOW);
    expect(h.folders.pending).toBe(0);
    expect(h.warnings).toEqual([]);
  });

  test('plural wording is correct for two folders', () => {
    const h = classifyDevice(dev(), act(5), [
      src({ decision: 'primary' }),
      src({ id: 'src_000000000004', decision: 'pending', sessions: 1 }),
      src({ id: 'src_000000000005', decision: 'pending', sessions: 1 }),
    ], NOW);
    expect(h.warnings[0]).toBe('2 transcript folders waiting for a decision (2 sessions not being synced)');
  });

  test('a pending folder with no sessions yet still warns, without a count', () => {
    const h = classifyDevice(dev(), act(5), [
      src({ decision: 'primary' }),
      src({ id: 'src_000000000006', decision: 'pending', sessions: 0 }),
    ], NOW);
    expect(h.warnings[0]).toBe('1 transcript folder waiting for a decision');
  });
});

/**
 * TELEMETRY WARNINGS — the failures only the device can see.
 *
 * Each of these completes a sync successfully from the server's point of view:
 * the walk finishes, rows arrive, the ledger advances. That is precisely why none
 * of them was visible before, and why they belong in the panel whose whole
 * purpose is that healthy and broken look identical everywhere else.
 */
const tel = (o: Partial<NonNullable<Parameters<typeof classifyDevice>[4]>> = {}) => ({
  breakerTrips: 0, failuresByClass: {}, worstFailureStreak: 0, breakerTripsAllLocal: false,
  autoUpdateProblems: 0, oversizedSessions: 0,
  oversizedWorstMb: 0, rssPeakMb: null, lastScanMs: null, recentScanMs: [], ...o,
});

describe('telemetry adds warnings the server cannot see on its own', () => {
  // ABSENCE IS NORMAL: a free plan, an opted-out machine, or a CLI predating
  // this all report nothing, and the card must look exactly as it did before.
  test('no telemetry means no change and no telemetry field', () => {
    const h = classifyDevice(dev(), act(), [src({ decision: 'primary' })], NOW);
    expect(h.warnings).toEqual([]);
    expect(h.telemetry).toBeUndefined();
  });

  test('reported-but-clean telemetry still produces no warnings', () => {
    const h = classifyDevice(dev(), act(), [src({ decision: 'primary' })], NOW,
      tel({ rssPeakMb: 494, lastScanMs: 1234 }));
    expect(h.warnings).toEqual([]);
    // Carried through for the numbers line, which is not a warning.
    expect(h.telemetry?.rssPeakMb).toBe(494);
  });

  test('a tripped breaker says what it costs, not just that it happened', () => {
    const h = classifyDevice(dev(), act(), [src({ decision: 'primary' })], NOW,
      tel({ breakerTrips: 2 }));
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('stopped trying a sync target 2 times');
    expect(h.warnings[0]).toContain('not reaching that server');
  });

  // The one that would have caught the client-4-vs-server-2 mismatch without
  // anyone reading a log file.
  test('rate limiting is surfaced as a slowness cause, not a generic failure', () => {
    const h = classifyDevice(dev(), act(), [src({ decision: 'primary' })], NOW,
      tel({ failuresByClass: { rate_limited: 3526 } }));
    expect(h.warnings[0]).toContain('3526 uploads rate-limited');
    expect(h.warnings[0]).toContain('first sync will take much longer');
  });

  test('auth failures point at the token, which is the actionable cause', () => {
    const h = classifyDevice(dev(), act(), [src({ decision: 'primary' })], NOW,
      tel({ failuresByClass: { auth: 4 } }));
    expect(h.warnings[0]).toContain('token may be revoked');
  });

  test('a refused plain-HTTP target says nothing is arriving', () => {
    const h = classifyDevice(dev(), act(), [src({ decision: 'primary' })], NOW,
      tel({ failuresByClass: { insecure_transport: 1 } }));
    expect(h.warnings[0]).toContain('plain HTTP');
  });

  // Real case: two 117MB OpenCode sessions on the maintainer's machine. The
  // warning must say what is LOST (the raw archive) and what still works
  // (search), because "too large" alone reads as data loss.
  test('oversized sessions name the cost and the size', () => {
    const h = classifyDevice(dev(), act(), [src({ decision: 'primary' })], NOW,
      tel({ oversizedSessions: 2, oversizedWorstMb: 117 }));
    expect(h.warnings[0]).toContain('2 sessions too large to archive');
    expect(h.warnings[0]).toContain('117MB');
    expect(h.warnings[0]).toContain('searchable');
  });

  test('singular and plural both read correctly', () => {
    const one = classifyDevice(dev(), act(), [src({ decision: 'primary' })], NOW,
      tel({ breakerTrips: 1, oversizedSessions: 1, oversizedWorstMb: 70 }));
    expect(one.warnings.join(' ')).toContain('1 time after');
    expect(one.warnings.join(' ')).toContain('1 session too large');
  });

  // Server-visible and device-visible problems must coexist, ordered with the
  // server's first — those are the ones that stop data arriving at all.
  test('telemetry warnings come after the server-side ones', () => {
    const h = classifyDevice(
      dev({ lastSeenAt: NOW - 5 * DAY }), null, [], NOW,
      tel({ breakerTrips: 1 }),
    );
    expect(h.warnings[0]).toContain('no contact');
    expect(h.warnings.some((w) => w.includes('stopped trying'))).toBe(true);
  });

  test('a zero count is never reported as a problem', () => {
    const h = classifyDevice(dev(), act(), [src({ decision: 'primary' })], NOW,
      tel({ breakerTrips: 0, oversizedSessions: 0, failuresByClass: { rate_limited: 0, auth: 0 } }));
    expect(h.warnings).toEqual([]);
  });

  /**
   * THE CASE THAT MADE THIS PANEL LIE.
   *
   * A device reported 270 billing refusals and 652 "insecure transport" in one
   * week. The insecure-transport count was a misclassification in the collector
   * (a 402 body carries an upgrade URL, and the classifier matched `https`), and
   * the billing refusals — the real, actionable condition — produced NO warning
   * at all, because only three classes had a sentence written for them.
   *
   * So the panel's single loudest line accused a LAN box on http:// of leaking
   * transcripts, while the true cause, a paused meter, was invisible.
   */
  test('a billing refusal is a warning of its own, not silence', () => {
    const h = classifyDevice(dev(), act(), [src({ decision: 'primary' })], NOW,
      tel({ failuresByClass: { payment_required: 270 } }));
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('270 uploads refused for billing');
    expect(h.warnings[0]).toContain('paused');
    // And it must NOT claim a transport problem it does not have.
    expect(h.warnings[0]).not.toContain('plain HTTP');
  });

  test('a class nobody wrote a sentence for is still visible', () => {
    const h = classifyDevice(dev(), act(), [src({ decision: 'primary' })], NOW,
      tel({ failuresByClass: { refused: 72, dns: 1 } }));
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('72× refused');
    expect(h.warnings[0]).toContain('1× dns');
  });

  // A dead box in your own study and an unreachable hosted service are the same
  // COUNT and different problems. The collector reports which; say it.
  test('an all-private failure names the network it is on', () => {
    const lan = classifyDevice(dev(), act(), [src({ decision: 'primary' })], NOW,
      tel({ breakerTrips: 3, breakerTripsAllLocal: true, worstFailureStreak: 109 }));
    expect(lan.warnings[0]).toContain('a sync target on your own network');
    expect(lan.warnings[0]).toContain('109 consecutive failures');

    const wan = classifyDevice(dev(), act(), [src({ decision: 'primary' })], NOW,
      tel({ breakerTrips: 3, breakerTripsAllLocal: false }));
    expect(wan.warnings[0]).not.toContain('your own network');
  });

  test('a device that cannot update itself says so', () => {
    const h = classifyDevice(dev(), act(), [src({ decision: 'primary' })], NOW,
      tel({ autoUpdateProblems: 7 }));
    expect(h.warnings[0]).toContain('self-update did not run 7 times');
    expect(h.warnings[0]).toContain('cannot pick up fixes');
  });
});

/**
 * VERSION DRIFT — the failure that hides behind all the others.
 *
 * A device sat on CLI 0.5.24 for six releases with auto-update disabled in its
 * unit file. Every other number it reported was correct and none of them could
 * say the thing that mattered: it was not running the collector whose fixes the
 * operator had already shipped.
 */
describe('a device behind the server it syncs to', () => {
  test('is warned about, with both versions named', () => {
    const h = classifyDevice(dev({ cliVersion: '0.5.24' }), act(), [src({ decision: 'primary' })], NOW,
      undefined, '0.5.30');
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('on CLI 0.5.24 while this server ships 0.5.30');
  });

  test('a current device is not warned', () => {
    const h = classifyDevice(dev({ cliVersion: '0.5.30' }), act(), [src({ decision: 'primary' })], NOW,
      undefined, '0.5.30');
    expect(h.warnings).toEqual([]);
  });

  test('a device AHEAD of the server is not warned — a dev box is not a fault', () => {
    const h = classifyDevice(dev({ cliVersion: '0.6.0' }), act(), [src({ decision: 'primary' })], NOW,
      undefined, '0.5.30');
    expect(h.warnings).toEqual([]);
  });

  test('an unknown version on either side warns about nothing', () => {
    expect(classifyDevice(dev({ cliVersion: null }), act(), [src({ decision: 'primary' })], NOW,
      undefined, '0.5.30').warnings).toEqual([]);
    expect(classifyDevice(dev({ cliVersion: '0.5.24' }), act(), [src({ decision: 'primary' })], NOW,
      undefined, null).warnings).toEqual([]);
  });

  // The whole reason this is not a string compare: '0.5.9' > '0.5.30' as text.
  test('versions compare NUMERICALLY per segment', () => {
    expect(compareCliVersions('0.5.9', '0.5.30')).toBe(-1);
    expect(compareCliVersions('0.5.30', '0.5.9')).toBe(1);
    expect(compareCliVersions('0.5.30', '0.5.30')).toBe(0);
    expect(compareCliVersions('v0.5.30', '0.5.30')).toBe(0);
    expect(compareCliVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareCliVersions('0.5', '0.5.0')).toBe(0);
    // An unparseable segment compares as 0 rather than inventing an order.
    expect(compareCliVersions('dev', '0.0.0')).toBe(0);
  });
});
