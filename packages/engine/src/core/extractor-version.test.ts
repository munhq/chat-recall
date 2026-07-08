import { describe, test, expect } from 'vitest';
import { extractorVersionForTool, extractorVersionForId, toolOfId, EXTRACTOR_VERSION } from './extractor-version.js';

describe('toolOfId — works for item ids (plans/tasks), not just sessions', () => {
  test('derives the tool from the id prefix', () => {
    expect(toolOfId('agy_plan_c4d7feab_implementation_plan')).toBe('agy');
    expect(toolOfId('gemini_plan_sess_investigation')).toBe('gemini');
    expect(toolOfId('opencode_plan_x')).toBe('opencode');
    expect(toolOfId('auth-rework')).toBe('claude'); // bare claude plan name
  });
  test('an agy item is version-stale against a base-seeded ledger, others are not', () => {
    // Seeded (unrecorded) tools default to base; only agy was bumped → only agy
    // items re-ship on the first run after the bump.
    const seed = EXTRACTOR_VERSION;
    expect(seed < extractorVersionForId('agy_plan_x')).toBe(true);   // agy re-ships
    expect(seed < extractorVersionForId('claude-plan')).toBe(false); // claude skips
    expect(seed < extractorVersionForId('gemini_plan_x')).toBe(false);
  });
});

describe('per-tool extractor version', () => {
  test('a tool-specific bump does NOT raise other tools (no blanket resync)', () => {
    const claude = extractorVersionForTool('claude');
    const agy = extractorVersionForTool('agy');
    expect(claude).toBe(EXTRACTOR_VERSION);            // base — unchanged
    expect(extractorVersionForTool('gemini')).toBe(EXTRACTOR_VERSION);
    expect(extractorVersionForTool('opencode')).toBe(EXTRACTOR_VERSION);
    expect(agy).toBe(EXTRACTOR_VERSION + 2);           // only agy bumped
  });

  test('derives the tool from the prefixed session id', () => {
    expect(extractorVersionForId('agy_abc')).toBe(EXTRACTOR_VERSION + 2);
    expect(extractorVersionForId('gemini_abc')).toBe(EXTRACTOR_VERSION);
    expect(extractorVersionForId('f8268be2-uuid')).toBe(EXTRACTOR_VERSION); // claude, no prefix
  });

  test('a v=BASE ledger row re-ships ONLY for the bumped tool', () => {
    const rowV = EXTRACTOR_VERSION; // what every session recorded before the agy bump
    expect(rowV < extractorVersionForTool('claude')).toBe(false); // skip
    expect(rowV < extractorVersionForTool('agy')).toBe(true);     // re-ship
  });
});
