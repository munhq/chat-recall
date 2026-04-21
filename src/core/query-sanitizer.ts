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
  /\bsystem:\b/i,
  /<\/?system[->]/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<<SYS>>/i,
  /<\|im_start\|>/i,
  /\bHuman:\s*$/i,
  /\bAssistant:\s*$/i,
];

// Characters/sequences to strip (potential FTS5/SQL injection)
const DANGEROUS_CHARS = /[;'"\\`{}|<>]/g;

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

  // Check for injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(clean)) {
      // Strip the matching portion and everything after it
      clean = clean.replace(pattern, ' ');
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
    clean = safeWords.join(' ');
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
