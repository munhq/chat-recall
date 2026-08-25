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
import { readFileSync, existsSync } from 'node:fs';
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

  test('free self-host withholds NOTHING that Solo has — every single-player feature is free', () => {
    // Until 2026-08-22 this withheld 'tasks' and 'toolkit'. Both are
    // single-player, so the gate contradicted the rule the pricing page states:
    // you pay when a second person is involved. It also protected nothing —
    // multi-user needs a real auth provider, which middleware/auth.ts refuses to
    // start without a licence.
    //
    // The assertion is now the strong one: free self-host IS the Solo set. If a
    // feature ever appears here, someone has taken something away from a free
    // tier, which is the one direction this door does not open — say so in the
    // changelog and in the pricing copy before changing this line.
    const solo = new Set(planFeatures('solo-monthly'));
    const withheld = [...solo].filter((f) => !SELFHOST_FREE_FEATURES.includes(f)).sort();
    expect(withheld).toEqual([]);
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
 * The registry that decides it lives in packages/engine/src/mcp/tools.ts. The README
 * states a number and is checked here. The marketing pages and llms.txt also
 * state one; those are checked by the site repo's parity script, since that is
 * where they now live — and llms.txt is the worst place to be wrong, because it
 * exists so AI crawlers quote it verbatim.
 */
describe('advertised MCP tool count ↔ the registry', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  // recall_help is excluded ON PURPOSE, matching the storefront's
  // check-parity.mjs: it is a DIRECTORY of the other tools, not a capability,
  // and the two checkers counting it differently made the README and the
  // pricing site disagree by exactly one forever. The number a page quotes is
  // what the product can DO.
  const registered = new Set(
    [...readFileSync(resolve(repoRoot, 'packages/engine/src/mcp/tools.ts'), 'utf-8')
      .matchAll(/name: '(recall_[a-z_]+)'/g)].map((m) => m[1])
      .filter((n) => n !== 'recall_help'),
  ).size;

  test('the registry is non-trivial (guards a broken regex)', () => {
    expect(registered).toBeGreaterThan(40);
  });

  // Every file that states a count, not just the README: the registry
  // manifests are the surfaces agents read to decide whether to install, and
  // they shipped an off-by-one on day one because only the README was pinned.
  //
  // CLAUDE.md is here because it drifted the other way — it said 54 while the
  // manifests still said 53, so the file that TELLS AN AGENT how this repo works
  // was the only accurate one and nothing noticed. It is documentation an agent
  // reads every session; a wrong number there is a wrong number in the model's
  // head.
  //
  // CLAUDE.md is OPTIONAL: .gitignore excludes it, so it exists on a developer's
  // machine and never in CI. Checked when present, skipped when not — which is
  // the right way round, because the drift happened locally and CI could never
  // have seen it either way. Reading it unconditionally is what broke this
  // build the first time.
  test.each(['README.md', 'server.json', 'smithery.yaml', 'docs/REGISTRIES.md', 'CLAUDE.md'])(
    '%s states the real count everywhere it states one', (file) => {
      const path = resolve(repoRoot, file);
      if (!existsSync(path)) return;      // untracked local file — nothing to check
      const found = [...readFileSync(path, 'utf-8')
        .matchAll(/(\d+)\s+(?:MCP\s+)?tools\b/g)]
        .map((m) => Number(m[1]))
        // Small numbers are other counts (the codeindex companion set of 4,
        // the lean profile's 25) — only the headline capability count is pinned.
        .filter((n) => n > 30);
      expect(found.length).toBeGreaterThan(0);
      for (const n of found) expect(n).toBe(registered);
    });
});
