/**
 * The derived-row shrink guard. `raw_sessions` was shrink-protected but
 * `compute_cache` was not, and both are written in the same sync — so a
 * truncated transcript left the raw archive intact while thinning the `markers`
 * row, which is how the UI and `recall_user_prompts` came to disagree about the
 * same session (1035 messages / 67 prompts vs 3 prompts).
 */
import { describe, test, expect } from 'vitest';
import { markersPromptCount, computeShrinkRefused } from './caches.js';

const markers = (n: number) => ({
  sessionId: 's1',
  prompts: Array.from({ length: n }, (_, i) => ({ line: i + 1, text: `p${i}`, markers: [] })),
  summary: {},
});
const reader = (stored: unknown | null) => async () => (stored === null ? null : { data: stored });

describe('markersPromptCount', () => {
  test('counts a markers payload', () => {
    expect(markersPromptCount(markers(67))).toBe(67);
    expect(markersPromptCount(markers(0))).toBe(0);
  });

  test('returns null for anything not shaped like markers', () => {
    for (const v of [null, undefined, {}, { prompts: 'nope' }, { prompts: 3 }, 42, 'x']) {
      expect(markersPromptCount(v)).toBeNull();
    }
  });
});

describe('computeShrinkRefused', () => {
  test('refuses a thinner markers payload — the actual bug', async () => {
    // 67 prompts stored, a truncated transcript recomputes 3.
    expect(await computeShrinkRefused('markers', markers(3), reader(markers(67)))).toBe(true);
  });

  test('allows growth and allows an equal count', async () => {
    expect(await computeShrinkRefused('markers', markers(67), reader(markers(3)))).toBe(false);
    expect(await computeShrinkRefused('markers', markers(9), reader(markers(9)))).toBe(false);
  });

  test('allows the first write, when nothing is stored yet', async () => {
    expect(await computeShrinkRefused('markers', markers(1), reader(null))).toBe(false);
  });

  test('never guards other compute kinds — they change shape rather than grow', async () => {
    for (const kind of ['diff', 'outcome', 'commits']) {
      expect(await computeShrinkRefused(kind, markers(1), reader(markers(500)))).toBe(false);
    }
  });

  test('does not guard when either side is malformed', async () => {
    expect(await computeShrinkRefused('markers', { prompts: 'bad' }, reader(markers(9)))).toBe(false);
    expect(await computeShrinkRefused('markers', markers(1), reader({ nope: true }))).toBe(false);
  });

  test('zero prompts cannot wipe a populated row', async () => {
    expect(await computeShrinkRefused('markers', markers(0), reader(markers(67)))).toBe(true);
  });
});

describe('computeShrinkRefused across markers versions', () => {
  const v2 = (n: number) => ({ ...markers(n), v: 2 });

  test('THE FAILURE: a version 2 row with fewer prompts replaces a version 1 row', async () => {
    // Version 1 counted harness text as prompts: 45 stored, 25 are the person's.
    expect(await computeShrinkRefused('markers', v2(25), reader(markers(45)))).toBe(false);
  });

  test('a version 1 row never replaces a version 2 row', async () => {
    expect(await computeShrinkRefused('markers', markers(45), reader(v2(25)))).toBe(true);
  });

  test('within version 2 the count rule holds', async () => {
    expect(await computeShrinkRefused('markers', v2(3), reader(v2(25)))).toBe(true);
    expect(await computeShrinkRefused('markers', v2(26), reader(v2(25)))).toBe(false);
  });

  // A subagent transcript: version 1 counted its task prompt, and the current
  // reader finds no prompt of the person in it.
  test('a newer version with zero prompts replaces an older populated row', async () => {
    expect(await computeShrinkRefused('markers', v2(0), reader(markers(1)))).toBe(false);
  });

  test('within one version, zero prompts cannot wipe a populated row', async () => {
    expect(await computeShrinkRefused('markers', v2(0), reader(v2(45)))).toBe(true);
  });
});
