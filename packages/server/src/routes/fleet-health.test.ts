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
import { classifyDevice } from './fleet-health.js';

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
