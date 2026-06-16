/**
 * High-precision vs fuzzy secret-detector policy.
 *
 * The built-in regex detectors and most named-service detectors are
 * structure-anchored (a recognizable prefix/shape) → high precision: when they
 * fire it's almost always a real credential. A handful of detectors are
 * "fuzzy" — they match generic high-entropy strings, UUIDs, base64 blobs, hex
 * hashes, or example connection strings, and produce mostly false positives on
 * chat-assistant content. Surfacing those trains the user to ignore the whole
 * Security view.
 *
 * Policy: fuzzy detectors are OFF by default. Findings from them are dropped at
 * the collector (never shipped) AND at server ingestion (defense for older
 * collectors). Set CHAT_RECALL_INCLUDE_FUZZY=1 to keep them (e.g. for an
 * exhaustive audit where false positives are acceptable).
 *
 * The list mirrors the "noise tier" the Security UI already collapsed — now
 * promoted to a real, shared, server-side default instead of a client-only
 * cosmetic hide.
 */

/**
 * Detector rules that match generic/example content far more often than real
 * secrets. Compared case-insensitively against the rule name; covers both the
 * gitleaks lowercase (`generic-api-key`) and trufflehog TitleCase (`Box`) forms.
 */
export const FUZZY_RULES: ReadonlySet<string> = new Set([
  'generic-api-key',   // gitleaks: any high-entropy string → the #1 FP source
  'curl-auth-header',  // matches any `Authorization:` header value, incl. examples
  'uri',               // trufflehog URI: matches any URL with creds-looking parts
  'box',               // trufflehog Box: matches base64/UUID-shaped strings
  'dockerhub',         // FP-prone on image refs / digests
  'npmtoken',          // overlaps UUIDs
  'shortcut',          // FP-prone fuzzy matcher
  'privacy',           // FP-prone fuzzy matcher
  'miro',              // FP-prone fuzzy matcher
]);

/** True when this (detector, rule) finding is from a fuzzy/low-precision rule. */
export function isFuzzyFinding(_detector: string, rule: string): boolean {
  if (!rule) return false;
  return FUZZY_RULES.has(rule.toLowerCase());
}

/** Whether fuzzy findings should be kept this run (default: no). */
export function keepFuzzyFindings(): boolean {
  const v = process.env.CHAT_RECALL_INCLUDE_FUZZY;
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Filter a list of findings to high-precision only, unless the env opt-in is
 * set. `pick` maps an item to its (detector, rule) — works for both the
 * collector's `{detector, rule, ...}` and any server-side row shape.
 */
export function dropFuzzyFindings<T>(items: T[], pick: (t: T) => { detector: string; rule: string }): T[] {
  if (keepFuzzyFindings()) return items;
  return items.filter((t) => {
    const { detector, rule } = pick(t);
    return !isFuzzyFinding(detector, rule);
  });
}
