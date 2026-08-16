/**
 * Query Sanitizer — prevents prompt injection via search queries.
 *
 * Strips system prompt fragments, injection attempts, and overly long
 * queries before they hit search backends.
 */

export interface SanitizeResult {
  cleanQuery: string;
  wasSanitized: boolean;
  originalLength: number;
  cleanLength: number;
  reason?: string;
}

// Max query length (tokens ≈ chars/4, keep under ~200 tokens)
const MAX_QUERY_LENGTH = 800;

// Patterns that indicate system prompt injection attempts
const INJECTION_PATTERNS = [
  /you are a/i,
  /your (instructions|role|purpose|task|goal)/i,
  /system\s*prompt/i,
  /ignore\s+(all\s+)?previous/i,
  /disregard\s+(all\s+)?previous/i,
  /forget\s+(all\s+)?previous/i,
  /override\s+(all\s+)?instructions/i,
  /new\s+instructions/i,
  /\bACT AS\b/i,
  /\bpretend\s+(?:to\s+be|you're|you are)\b/i,
  /\bdo not\s+(?:follow|obey)\b/i,
  /\bDAN\s+mode\b/i,
  /\bjailbreak\b/i,
  /\bsystem:/i,
  /<\/?system[->]/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<<SYS>>/i,
  /<\|im_start\|>/i,
  /\bHuman:\s*$/i,
  /\bAssistant:\s*$/i,
];

/**
 * Global twins of the patterns above. `.test()` on a /g regex is stateful, so
 * the source list stays non-global for any caller that wants a predicate, and
 * only the stripper uses these.
 */
const INJECTION_PATTERNS_GLOBAL = INJECTION_PATTERNS.map(
  (p) => new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`),
);

// Characters/sequences to strip (potential FTS5/SQL injection).
// Double quotes are intentionally allowed — they are FTS5 phrase
// syntax ("erpc logs" matches the literal phrase) and the query is
// parameter-bound, so this can't escape into SQL.
const DANGEROUS_CHARS = /[;'\\`{}|<>]/g;

/**
 * Sanitize a search query before passing to search backends.
 *
 * - Truncates to MAX_QUERY_LENGTH
 * - Strips injection patterns
 * - Removes dangerous characters
 * - Collapses whitespace
 */
export function sanitizeQuery(query: string): SanitizeResult {
  const originalLength = query.length;
  let clean = query;
  let wasSanitized = false;
  let reason: string | undefined;

  // Truncate overly long queries
  if (clean.length > MAX_QUERY_LENGTH) {
    clean = clean.slice(0, MAX_QUERY_LENGTH);
    wasSanitized = true;
    reason = 'truncated';
  }

  // Check for injection patterns.
  //
  // Two things are load-bearing here. The patterns are applied GLOBALLY, so a
  // repeated payload is cleared in one pass — without /g, replace() removes a
  // single occurrence per round, and six copies of the same phrase survived a
  // five-round loop. And the rounds repeat to a fixed point, because a NESTED
  // payload reconstitutes itself: removing the inner match from
  // "ignignore all previousore all previous" splices the outer halves together
  // and rebuilds the phrase that was just stripped. Bounded so a pathological
  // input cannot spin.
  const stripInjections = (text: string): { text: string; changed: boolean } => {
    let out = text;
    let changed = false;
    for (let round = 0; round < 5; round++) {
      let changedThisRound = false;
      for (const pattern of INJECTION_PATTERNS_GLOBAL) {
        const before = out;
        out = out.replace(pattern, ' ');
        if (out !== before) { changedThisRound = true; changed = true; }
      }
      if (!changedThisRound) break;
    }
    return { text: out, changed };
  };

  {
    const stripped = stripInjections(clean);
    clean = stripped.text;
    if (stripped.changed) {
      wasSanitized = true;
      reason = reason ? `${reason}+injection_stripped` : 'injection_stripped';
    }
  }

  // Remove dangerous characters
  const beforeDangerous = clean;
  clean = clean.replace(DANGEROUS_CHARS, ' ');
  if (clean !== beforeDangerous) {
    wasSanitized = true;
    if (!reason) reason = 'dangerous_chars_stripped';
  }

  // Collapse whitespace
  clean = clean.replace(/\s+/g, ' ').trim();

  // If query was emptied by sanitization, keep first safe words from original
  if (!clean && query.trim()) {
    const safeWords = query
      .replace(/[^a-zA-Z0-9\s_.-]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 1)
      .slice(0, 10);
    // Re-strip: rebuilding from "safe words" happily reassembles the exact
    // phrase that was just removed, so `ignore all previous` used to survive
    // sanitisation by being the WHOLE query rather than part of one.
    clean = stripInjections(safeWords.join(' ')).text.replace(/\s+/g, ' ').trim();
    wasSanitized = true;
    reason = 'reconstructed_from_keywords';
  }

  return {
    cleanQuery: clean,
    wasSanitized,
    originalLength,
    cleanLength: clean.length,
    reason,
  };
}
