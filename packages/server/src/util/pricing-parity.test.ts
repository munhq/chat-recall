/**
 * What this file can still prove, now that the pricing page lives elsewhere.
 *
 * The marketing generator moved to the private operator repo, because a
 * self-hoster building this repo must not end up serving chatrecall.dev's
 * storefront. It took the TIERS map with it, so the page↔gate comparison cannot
 * run here any more: half of it is not in this checkout.
 *
 * That comparison still exists and still blocks a bad deploy — it runs in
 * munhq/chat-recall-site as `check-parity.mjs`, before the image is built, with
 * both halves present. It reads PLAN_FEATURES and SELFHOST_FREE_FEATURES out of
 * entitlements.ts below, so changing packaging here without changing the page
 * there fails the deploy rather than shipping a wrong price. Do not weaken the
 * shapes it parses (`PLAN_FEATURES` entries, the two exported arrays) without
 * updating that script.
 *
 * What remains here is everything provable from the product alone.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planFeatures, FREE_FEATURES, SELFHOST_FREE_FEATURES } from './entitlements.js';

describe('entitlement resolver — the floor and the self-host grant', () => {
  test('the cloud floor stays fail-closed', () => {
    // Guards the regression that widening self-host could have caused: handing
    // the paid tier to every cloud tenant whose plan failed to record.
    expect([...FREE_FEATURES].sort()).toEqual(['memory', 'scan']);
    expect([...planFeatures(null)].sort()).toEqual([...FREE_FEATURES].sort());
    expect([...planFeatures('nonsense-plan')].sort()).toEqual([...FREE_FEATURES].sort());
  });

  test('a self-hoster gets nearly the Solo set for nothing, not the cloud floor', () => {
    // The adoption argument: running your own server is free and covers the whole
    // memory product — index, search, sync, findings, alerts, analytics.
    const solo = new Set(planFeatures('solo-monthly'));
    for (const f of SELFHOST_FREE_FEATURES) {
      expect([...solo], `free self-host grants ${f}, which Solo must also have`).toContain(f);
    }
    // ...and it is emphatically more than the cloud floor.
    expect([...SELFHOST_FREE_FEATURES].sort()).not.toEqual([...FREE_FEATURES].sort());
  });

  test('free self-host withholds exactly the two single-player extras, and nothing else', () => {
    // A DELIBERATE divergence, not drift. 'toolkit' and 'tasks' are single-player
    // and could be free here on capability grounds, but the door opens one way:
    // adding to a free tier later is a gift, removing is the rug-pull story. They
    // are also what a one-seat self-host licence unlocks, which is what stops that
    // licence being a payment for nothing.
    //
    // If this list ever grows beyond those two, the divergence has stopped being a
    // decision and started being drift — which is what this test exists to catch.
    const solo = new Set(planFeatures('solo-monthly'));
    const withheld = [...solo].filter((f) => !SELFHOST_FREE_FEATURES.includes(f)).sort();
    expect(withheld).toEqual(['tasks', 'toolkit']);
  });

  test('every paid tier is a superset of the one below', () => {
    const order = ['solo-monthly', 'team-monthly', 'enterprise-monthly'];
    for (let i = 1; i < order.length; i++) {
      const lower = planFeatures(order[i - 1]);
      const upper = planFeatures(order[i]);
      for (const f of lower) {
        expect([...upper], `${order[i]} is missing ${f} from ${order[i - 1]}`).toContain(f);
      }
    }
  });
});

/**
 * The advertised TOOL COUNT, which has drifted twice.
 *
 * The registry that decides it lives in packages/cli/src/mcp.ts. The README
 * states a number and is checked here. The marketing pages and llms.txt also
 * state one; those are checked by the site repo's parity script, since that is
 * where they now live — and llms.txt is the worst place to be wrong, because it
 * exists so AI crawlers quote it verbatim.
 */
describe('advertised MCP tool count ↔ the registry', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const registered = new Set(
    [...readFileSync(resolve(repoRoot, 'packages/cli/src/mcp.ts'), 'utf-8')
      .matchAll(/name: '(recall_[a-z_]+)'/g)].map((m) => m[1]),
  ).size;

  test('the registry is non-trivial (guards a broken regex)', () => {
    expect(registered).toBeGreaterThan(40);
  });

  test('README.md states the real count everywhere it states one', () => {
    const found = [...readFileSync(resolve(repoRoot, 'README.md'), 'utf-8')
      .matchAll(/(\d+)\s+(?:MCP\s+)?tools\b/g)]
      .map((m) => Number(m[1]))
      // '4 tools' in the README is the codeindex companion set, not ours.
      .filter((n) => n > 10);
    expect(found.length).toBeGreaterThan(0);
    for (const n of found) expect(n).toBe(registered);
  });
});
