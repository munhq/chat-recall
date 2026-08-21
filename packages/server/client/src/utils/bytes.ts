/**
 * Byte formatting for the sync meters, in one place.
 *
 * The server meters sync in BYTES (util/entitlements.ts limitReached sends
 * `used`/`limit` as bytes); people think about their quota in MB. Two surfaces
 * render the same numbers — the quota notice on the sync card and any future
 * usage row — and a copy each would let them disagree on the same meter.
 */

const MB = 1024 * 1024;

/**
 * Bytes → "N MB". Whole megabytes drop the decimal; small values keep one so
 * "0.4 MB used" never rounds to a lying "0 MB". Values ≥ 100 MB round to whole
 * numbers — at that size the decimal is noise.
 */
export function formatMB(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  const mb = bytes / MB;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  const one = Math.round(mb * 10) / 10;
  return `${Number.isInteger(one) ? one.toFixed(0) : one.toFixed(1)} MB`;
}

/** The free plan's default search window. The server reads the live value from
 *  FREE_SEARCH_WINDOW_DAYS and sends it as ent.limits.searchWindowDays /
 *  window_days — always prefer those; this constant only covers the moment
 *  before any payload has answered. */
export const DEFAULT_FREE_WINDOW_DAYS = 7;

/**
 * General byte formatter (binary units, matching formatMB): the admin fleet
 * view and the account meters must render the SAME number for the same bytes —
 * a decimal formatter here made a 300 MB cap read as 314 MB one page over.
 */
export function formatBytes(n?: number | null): string {
  if (n == null || !Number.isFinite(n) || n === 0) return '—';
  const KB = 1024, GB = 1024 * 1024 * 1024;
  if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
  if (n >= KB * 1024) return formatMB(n);
  if (n >= KB) return `${(n / KB).toFixed(1)} KB`;
  return `${Math.round(n)} B`;
}
