/**
 * Pre-index secret redactor.
 *
 * Replaces detected secrets in indexed content with `[REDACTED:type]`
 * sentinels BEFORE the chunks land in `memory_chunks_fts` or
 * `content_cache`. The original session JSONL on disk is owned by
 * Claude Code and is never touched — redaction here only affects
 * derived data we control.
 *
 * Why regex (not gitleaks/trufflehog subprocess)?
 *   - Runs in-process at write time. Subprocess per chunk = death.
 *   - Lower fidelity but covers the common high-stakes patterns
 *     (AWS, GitHub PATs, Slack tokens, JWTs, private key blocks).
 *   - The full detector pass still runs separately to populate
 *     `secret_findings`; redaction is a complementary in-process
 *     scrub, not a replacement.
 *
 * Enable via either:
 *   - `CHAT_RECALL_REDACT_INDEX=true`     (env, wins)
 *   - `privacy.redactIndex = true` in settings.json (UI toggle)
 *
 * Default OFF locally (raw JSONLs already contain the secrets —
 * redacting our index has limited value when the source remains
 * unchanged) and recommended ON for SaaS / sync deployments where
 * the index leaves the user's machine.
 *
 * `privacy.redactionRules` from settings is appended onto the
 * built-in DEFAULT_REDACTION_RULES — user-defined rules can add
 * tenant-specific shapes without losing the curated baseline.
 */
import { loadSettings, settingsFilePath } from './settings.js';
import { statSync } from 'fs';
import { createHash } from 'crypto';

export interface RedactionRule {
  /** label used in the sentinel (`[REDACTED:label]`) */
  label: string;
  /** regex matching the secret pattern */
  pattern: RegExp;
}

/**
 * Curated patterns covering the high-confidence secret shapes we saw
 * in the test corpus. Conservative on regex breadth: false-positive
 * redactions destroy useful content (you can't search for an AWS key
 * after we've turned it into [REDACTED]), so each pattern is anchored
 * by a recognizable prefix or context.
 */
export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  // AWS access tokens. Prefix-anchored: AKIA, ASIA, ABIA (long-term,
  // STS, EC2). Always exactly 16 hex/alphanumeric after the prefix.
  { label: 'aws-access-token', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  // GitHub personal access tokens.
  { label: 'github-pat',       pattern: /\bghp_[A-Za-z0-9]{36}\b/g },
  // GitHub fine-grained PATs.
  { label: 'github-fine',      pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  // GitHub OAuth.
  { label: 'github-oauth',     pattern: /\bgho_[A-Za-z0-9]{36}\b/g },
  // GitHub app + refresh.
  { label: 'github-app',       pattern: /\b(?:ghs|ghu|ghr)_[A-Za-z0-9]{36}\b/g },
  // Slack bot/user/app tokens.
  { label: 'slack-token',      pattern: /\bxox[abopr]-[A-Za-z0-9-]{10,}\b/g },
  // Slack incoming webhook URL.
  { label: 'slack-webhook',    pattern: /\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+\b/g },
  // Stripe live + test keys.
  { label: 'stripe-key',       pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g },
  // Anthropic.
  { label: 'anthropic-key',    pattern: /\bsk-ant-[a-zA-Z0-9_-]{40,}\b/g },
  // OpenAI.
  { label: 'openai-key',       pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  // Google API key (AIza…).
  { label: 'google-api-key',   pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Generic JWT — three base64url segments.
  { label: 'jwt',              pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  // Private key blocks (PEM). Strips between BEGIN/END markers.
  { label: 'private-key',      pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g },
  // npm tokens (uuid-shaped — overlap with our UUID filter; intentional).
  { label: 'npm-token',        pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
];

/** Truthy when redaction is requested via env. Env wins over settings. */
function isEnvRedactionRequested(): boolean | null {
  const v = process.env.CHAT_RECALL_REDACT_INDEX;
  if (v === undefined) return null;
  return v === '1' || v === 'true' || v === 'yes';
}

interface CacheEntry { mtimeMs: number; enabled: boolean; rules: RedactionRule[]; }
let cache: CacheEntry | null = null;

/**
 * Load `privacy.redactIndex` and compile any custom regex rules. Cached
 * by settings.json mtime so repeated calls are O(1) on the hot path.
 * Invalid user regexes are dropped silently (logged once would be nicer
 * but the redactor sits below the logger; not worth the import cycle).
 */
function settingsView(): { enabled: boolean; rules: RedactionRule[] } {
  let mtimeMs = -1;
  try { mtimeMs = statSync(settingsFilePath()).mtimeMs; } catch { /* missing → defaults */ }
  if (cache && cache.mtimeMs === mtimeMs) return cache;

  let enabled = false;
  const extra: RedactionRule[] = [];
  try {
    const s = loadSettings();
    enabled = !!s.privacy?.redactIndex;
    for (const r of s.privacy?.redactionRules ?? []) {
      try { extra.push({ label: r.label, pattern: new RegExp(r.pattern, 'g') }); } catch { /* bad regex */ }
    }
  } catch { /* settings unreadable → defaults */ }

  cache = { mtimeMs, enabled, rules: [...DEFAULT_REDACTION_RULES, ...extra] };
  return cache;
}

/** Public flag — true if env asks OR settings opt-in. */
export function isRedactionEnabled(): boolean {
  const env = isEnvRedactionRequested();
  if (env !== null) return env;
  return settingsView().enabled;
}

/** Force a re-read on next call. Used by tests. */
export function _resetRedactorCache(): void { cache = null; }

/**
 * Apply all redaction rules to a string. Returns the input unchanged
 * when redaction is disabled OR no rules match — cheap enough to
 * call unconditionally on every chunk.
 *
 * `count` is mutated: callers can roll up "we redacted N strings
 * across this session" for telemetry.
 */
export function redactSecrets(text: string, opts: { rules?: RedactionRule[]; count?: { redactions: number }; force?: boolean } = {}): string {
  // `force` bypasses the global toggle — the sync uploader must ALWAYS redact
  // before anything leaves the machine, even when index-time redaction is off.
  if (!opts.force && !isRedactionEnabled()) return text;
  if (!text) return text;
  // Default rule set = baseline + user-added rules from settings. Caller
  // can still override entirely via `opts.rules` if they need a clean set.
  const rules = opts.rules || settingsView().rules;
  let out = text;
  for (const r of rules) {
    out = out.replace(r.pattern, () => {
      if (opts.count) opts.count.redactions++;
      return `[REDACTED:${r.label}]`;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Privacy helpers driven by settings.privacy.* — distinct from the secret
// redactor above because they apply unconditionally when their setting is on
// (no env override, no rule list).
// ---------------------------------------------------------------------------

interface PrivacyCacheEntry {
  mtimeMs: number;
  redactToolOutputs: boolean;
  redactFilePaths: boolean;
}
let privacyCache: PrivacyCacheEntry | null = null;

function privacyView(): PrivacyCacheEntry {
  let mtimeMs = -1;
  try { mtimeMs = statSync(settingsFilePath()).mtimeMs; } catch { /* defaults */ }
  if (privacyCache && privacyCache.mtimeMs === mtimeMs) return privacyCache;
  let redactToolOutputs = false, redactFilePaths = false;
  try {
    const s = loadSettings();
    redactToolOutputs = !!s.privacy?.redactToolOutputs;
    redactFilePaths   = !!s.privacy?.redactFilePaths;
  } catch { /* defaults */ }
  privacyCache = { mtimeMs, redactToolOutputs, redactFilePaths };
  return privacyCache;
}

/** Public for tests. */
export function _resetPrivacyCache(): void { privacyCache = null; }

export function isToolOutputRedactionEnabled(): boolean { return privacyView().redactToolOutputs; }
export function isFilePathRedactionEnabled():  boolean { return privacyView().redactFilePaths; }

/**
 * Replace any absolute filesystem path embedded in chunk text with a
 * stable 12-char sha256 prefix. The hashing is one-way so the index
 * can't reconstruct the original path; identical paths still collide
 * to the same hash so search keeps grouping by project.
 *
 * Matches POSIX absolute paths (`/foo/bar/baz`) and Windows
 * (`C:\\foo\\bar`) shapes. Skips inside `[REDACTED:...]` sentinels so
 * we don't double-process secret previews.
 */
const PATH_REGEX = /(?<![A-Za-z0-9_])(?:\/[^\s'"`<>]+|[A-Za-z]:\\[^\s'"`<>]+)/g;

export function redactFilePaths(text: string): string {
  if (!text) return text;
  return text.replace(PATH_REGEX, (m) => {
    if (m.startsWith('[REDACTED:')) return m;
    const h = createHash('sha256').update(m).digest('hex').slice(0, 12);
    return `[path:${h}]`;
  });
}

/**
 * Apply all enabled privacy filters to chunk text in one pass:
 *   - secret redactor (existing)
 *   - file-path hashing (privacy.redactFilePaths)
 *
 * Tool-output redaction is NOT applied here — it operates on a
 * tool-call result body before chunking, so the session chunker
 * calls `redactToolResultBody()` directly.
 */
export function applyChunkPrivacy(text: string): string {
  let out = redactSecrets(text);
  if (privacyView().redactFilePaths) out = redactFilePaths(out);
  return out;
}

/**
 * Replace a tool-call result body with a fixed placeholder. Used in the
 * session chunker when `privacy.redactToolOutputs` is on — tool outputs
 * are the most common accidental-secret carrier (curl bodies, env dumps,
 * cat of credential files) and dropping them wholesale is safer than
 * trying to scrub.
 */
export function redactToolResultBody(toolName: string, body: string): string {
  if (!body) return body;
  return `[redacted: ${toolName} output, ${body.length} chars]`;
}
