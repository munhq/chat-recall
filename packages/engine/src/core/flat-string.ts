/**
 * Force a string to be a standalone copy, detached from whatever it was cut from.
 *
 * WHY THIS EXISTS — the 2026-08-22 watch-daemon OOM.
 *
 * V8 does not copy on `.slice()` or `.trim()`. For any result of 13 characters
 * or more it allocates a SlicedString: a {parent, offset, length} view that
 * keeps the ENTIRE original string alive. A 200-character preview cut from a
 * 500 KB chat message therefore retains all 500 KB, and it is invisible in a
 * profiler that only looks at the short string's own length.
 *
 * The daemon builds one SessionRef per session up front — about 15,700 of them
 * on this developer's machine — and each carries a `firstPrompt` preview cut
 * exactly that way. A heap snapshot taken at the limit showed 300 MB of the
 * 374 MB heap held through `firstPrompt -> sliced string -> parent`, and a full
 * Mark-Compact freed nothing, because every byte was genuinely reachable.
 *
 * A Buffer round-trip is the one reliable way to get a flat copy: `String(s)`,
 * `s.repeat(1)` and `` `${s}` `` all return the same SlicedString, and
 * `(s + ' ').slice(0, -1)` just builds a new slice over a new parent. The cost
 * is proportional to the SHORT string, so it is negligible next to the
 * megabytes it lets the collector reclaim.
 *
 * Use this whenever a short excerpt of a large string outlives the large one.
 */
export function flatString(s: string): string {
  if (!s) return '';
  // Short strings are already flat: V8 only builds a SlicedString at or above
  // SlicedString::kMinLength (13), so anything below that costs nothing to skip.
  if (s.length < 13) return s;
  return Buffer.from(s, 'utf8').toString('utf8');
}
