/**
 * Provider-quota detection for summary/indexer workers.
 *
 * Stays in src/core so unit tests can import it; the auto-indexer
 * re-imports the helpers from here instead of redefining them.
 */

export function isQuotaError(msg: string): boolean {
  return /QUOTA_EXHAUSTED|429|exhausted your capacity|rate.?limit/i.test(msg);
}

/**
 * Parse the retry-after window out of a Gemini-style error message.
 * Recognises:
 *   - "Your quota will reset after 1h20m49s."
 *   - "retryDelayMs: 4849385.100621"
 * Returns ms or null if nothing parseable.
 */
export function parseQuotaRetryMs(msg: string): number | null {
  const dur = msg.match(/reset after\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
  if (dur && (dur[1] || dur[2] || dur[3])) {
    const h = Number(dur[1] || 0), m = Number(dur[2] || 0), s = Number(dur[3] || 0);
    const ms = ((h * 3600) + (m * 60) + s) * 1000;
    if (ms > 0) return ms;
  }
  const rd = msg.match(/retryDelayMs[^0-9]*([0-9]+(?:\.[0-9]+)?)/);
  if (rd) {
    const ms = Math.round(Number(rd[1]));
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}
