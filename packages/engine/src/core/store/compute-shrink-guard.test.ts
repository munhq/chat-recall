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
