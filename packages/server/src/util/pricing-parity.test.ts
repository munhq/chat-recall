/**
 * The pricing page and the gate must describe the same product.
 *
 * build-marketing.mjs is a static generator that cannot import this TypeScript
 * resolver, so it keeps its own TIERS map. That is a second copy of one truth —
 * the exact shape that produced four drifted price literals (the structured data
 * still advertised Solo at $10 after it rose to $15) and two divergent team gates.
 * Since the duplication cannot be removed, it is asserted instead: this test reads
 * the generator and fails if either side changes alone.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planFeatures, FREE_FEATURES, SELFHOST_FREE_FEATURES, type Feature } from './entitlements.js';

const GENERATOR = resolve(
  import.meta.dirname, '../../client/scripts/build-marketing.mjs',
);

/** The TIERS map as the generator declares it, read out of the source. */
function tiersFromGenerator(): Record<string, Feature[]> {
  const src = readFileSync(GENERATOR, 'utf8');
  const out: Record<string, Feature[]> = {};
  // Each tier declares `features: ['a', 'b', …]` inside its own block.
  const blocks = src.matchAll(/^\s{2}(free|solo|team|enterprise):\s*\{([\s\S]*?)^\s{2}\},/gm);
  for (const b of blocks) {
    const feats = /features:\s*\[([^\]]*)\]/.exec(b[2]);
    expect(feats, `tier ${b[1]} declares no features`).toBeTruthy();
    out[b[1]] = feats![1]
      .split(',')
      .map((f) => f.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean) as Feature[];
  }
  return out;
}

describe('pricing page ↔ entitlement resolver parity', () => {
  const tiers = tiersFromGenerator();

  test('the generator declares all four tiers', () => {
    expect(Object.keys(tiers).sort()).toEqual(['enterprise', 'free', 'solo', 'team']);
  });

  test('the free card advertises exactly what a self-hoster gets for nothing', () => {
    // That card is titled "Self-hosted, free", so it must match the SELF-HOST
    // free set — not FREE_FEATURES, which is the CLOUD floor for a tenant whose
    // plan is absent or unrecognised. The two are deliberately different now:
    // running your own server is free and full, while a cloud row with no plan
    // fails closed to memory+scan.
    expect(tiers.free.sort()).toEqual([...SELFHOST_FREE_FEATURES].sort());
  });

  test('the cloud floor stays fail-closed, and is NOT what the free card shows', () => {
    // Guards the regression that widening self-host could have caused: handing
    // the paid tier to every cloud tenant whose plan failed to record.
    expect([...FREE_FEATURES].sort()).toEqual(['memory', 'scan']);
    expect([...planFeatures(null)].sort()).toEqual([...FREE_FEATURES].sort());
  });

  for (const plan of ['solo', 'team', 'enterprise'] as const) {
    test(`${plan}: the page advertises exactly what the gate grants`, () => {
      // planFeatures is what requireFeature() actually consults, so this compares
      // the marketing claim against the enforcement, not against another claim.
      const granted = [...planFeatures(`${plan}-monthly`)].sort();
      expect(tiers[plan].sort()).toEqual(granted);
    });
  }

  test('every tier is a superset of the one below — no feature is lost by upgrading', () => {
    const order = ['free', 'solo', 'team', 'enterprise'] as const;
    for (let i = 1; i < order.length; i++) {
      const lower = new Set(tiers[order[i - 1]]);
      for (const f of lower) {
        expect(tiers[order[i]], `${order[i]} is missing ${f} from ${order[i - 1]}`).toContain(f);
      }
    }
  });

  test('each paid tier lists exactly five bullets, so the cards stay level', () => {
    const src = readFileSync(GENERATOR, 'utf8');
    for (const plan of ['solo', 'team', 'enterprise']) {
      const block = new RegExp(`^\\s{2}${plan}:\\s*\\{([\\s\\S]*?)^\\s{2}\\},`, 'm').exec(src);
      const bullets = block![1].match(/^\s{6}'/gm) ?? [];
      expect(bullets.length, `${plan} bullet count`).toBe(5);
    }
  });
});

/**
 * The advertised TOOL COUNT, which has now drifted twice.
 *
 * The marketing pages, llms.txt and the README each state a number, and the
 * registry that decides it lives in packages/cli/src/mcp.ts. llms.txt is the
 * worst place for it to be wrong: it exists specifically so AI crawlers quote it
 * verbatim, so a stale number is repeated as fact by the assistants this product
 * is discovered through.
 */
describe('advertised MCP tool count ↔ the registry', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const registered = new Set(
    [...readFileSync(resolve(repoRoot, 'packages/cli/src/mcp.ts'), 'utf-8')
      .matchAll(/name: '(recall_[a-z_]+)'/g)].map((m) => m[1]),
  ).size;

  const claims = (file: string): number[] =>
    [...readFileSync(resolve(repoRoot, file), 'utf-8').matchAll(/(\d+)\s+(?:MCP\s+)?tools\b/g)]
      .map((m) => Number(m[1]))
      // '4 tools' in the README is the codeindex companion set, not ours.
      .filter((n) => n > 10);

  test('the registry is non-trivial (guards a broken regex)', () => {
    expect(registered).toBeGreaterThan(40);
  });

  for (const f of ['packages/server/client/scripts/build-marketing.mjs', 'README.md']) {
    test(`${f} states the real count everywhere it states one`, () => {
      const found = claims(f);
      expect(found.length).toBeGreaterThan(0);
      for (const n of found) expect(n).toBe(registered);
    });
  }
});
