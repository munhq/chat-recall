/**
 * Honest relevance display for search results.
 *
 * Backstory: chat-recall uses two search backends — FTS5 (BM25 ranks like
 * −2 to −12) and LanceDB vector (L2 distances on 768-dim vectors that can
 * span 50–500). Both pass through the same `score = 1/(1+|x|)` normalization,
 * which produces wildly different absolute ranges. The previous display
 * (`score * 100`) made every vector result round to 0/100 — useless.
 *
 * Fix: compare each result's score against the top result in *this* query
 * batch and report a tier. The user gets a meaningful "this match was strong
 * vs. weak relative to the others" without us pretending the absolute number
 * means anything.
 */

export type ScoreTier = 'strong' | 'good' | 'weak' | 'unranked';

/** Threshold: ratio relative to the top score that still counts as "strong". */
const STRONG_RATIO = 0.85;
/** Threshold above which a result is at least "good". */
const GOOD_RATIO = 0.55;

/**
 * Tier a single result against the best score in its batch.
 *
 * `topScore` is the highest score among the results being displayed (results
 * are typically already sorted descending — `topScore` is `results[0].score`).
 * Returns 'unranked' when there's no usable signal (top score ≤ 0).
 */
export function tierFor(score: number, topScore: number): ScoreTier {
  if (!Number.isFinite(topScore) || topScore <= 0) return 'unranked';
  if (!Number.isFinite(score) || score < 0) return 'weak';
  const ratio = score / topScore;
  if (ratio >= STRONG_RATIO) return 'strong';
  if (ratio >= GOOD_RATIO) return 'good';
  return 'weak';
}

/**
 * Bulk-tier a sorted (desc) result set. Returns tiers indexed parallel to
 * the input. Cheaper than calling `tierFor` per element when the caller
 * already has the array.
 */
export function tierAll<T extends { score: number }>(results: T[]): ScoreTier[] {
  if (results.length === 0) return [];
  const top = results[0].score;
  return results.map(r => tierFor(r.score, top));
}
