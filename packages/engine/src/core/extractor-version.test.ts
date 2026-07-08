import { describe, test, expect } from 'vitest';
import { extractorVersionForTool, extractorVersionForId, EXTRACTOR_VERSION } from './extractor-version.js';

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
