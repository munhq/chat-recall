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
import { resolve } from 'node:path';
import { planFeatures, FREE_FEATURES, type Feature } from './entitlements.js';

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

  test('the free tier advertises exactly what needs no plan', () => {
    expect(tiers.free.sort()).toEqual([...FREE_FEATURES].sort());
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
