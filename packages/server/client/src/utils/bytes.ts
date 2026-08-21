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
