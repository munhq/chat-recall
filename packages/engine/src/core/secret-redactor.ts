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
  // NOTE: this matches only the access-key-ID, NOT the secret key value —
  // the `env-secret` rule below covers AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN.
  { label: 'aws-access-token', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  // AWS STS session tokens. These are long base64 blobs with NO `NAME=` context
  // when pasted bare into prose/code, so `env-secret` misses them — but they
  // reliably start with one of a handful of base64 prefixes (the encoded
  // `{"...` JSON header). Prefix-anchored → low false-positive. This is the
  // bare-value form that leaked (`search('IQoJEXAMPLEfakeSESSIONtokenNOTreal01234567890abcDEF==...')`).
  { label: 'aws-session-token', pattern: /\b(?:IQoJ|FwoG|FwoH|FQoG|FQoH|FwoD)[A-Za-z0-9/+]{40,}={0,2}/g },
  // Env/shell-assignment secrets — a VAR whose name ends in KEY/SECRET/TOKEN/
  // PASSWORD/CREDENTIAL, then `=`/`:`, then the value. Zero-width lookbehind so
  // only the VALUE is redacted (the var name stays for context). This is the
  // dominant real-world leak vector (`export` dumps, .env files, `curl -H`,
  // tool output) and is exactly what leaked AWS_SECRET_ACCESS_KEY and
  // AWS_SESSION_TOKEN in cleartext while the access-key-ID rule above caught
  // only the (least-sensitive) ID.
  // Suffix list deliberately broad: DB_PASS (our own helm chart's name!),
  // NPM_AUTH, SENTRY_DSN, SESSION/COOKIE secrets and BEARER vars all leaked
  // past the original KEY/SECRET/TOKEN/PASSWORD-only list. Values under 12
  // chars don't redact, so flag-ish vars (BYPASS=true) stay readable.
  { label: 'env-secret',       pattern: /(?<=\b[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PWD|CREDENTIAL|AUTH|DSN|SESSION|COOKIE|BEARER|SIGNATURE)S?["']?[ \t]{0,3}[:=][ \t]{0,3}["']?)[A-Za-z0-9/+_.~=:@-]{12,}/g },
  // Credentials embedded in a connection URL: scheme://user:PASSWORD@host.
  // Redacts only the password segment (keeps scheme/user/host for context).
  //
  // Scheme-agnostic on purpose. The old rule allowlisted eight DB schemes, so
  // `https://user:pass@host`, `ssh://`, `ftp://`, `smtp://` and every other
  // userinfo URL walked through in cleartext — and a `jdbc:postgresql://…`
  // prefix broke the \b anchor for the one family it did cover. Any scheme
  // followed by userinfo is a credential, so match the shape, not a list.
  { label: 'url-password',     pattern: /(?<=\b[a-zA-Z][a-zA-Z0-9+.-]{1,31}:\/\/[^:@\s/]{1,64}:)[^@\s/]{1,256}(?=@)/g },
  // Bare AWS secret-access-key VALUE: EXACTLY 40 base64 chars, word-bounded,
  // containing upper+lower+digit. This is the gitleaks heuristic — the mixed-case
  // requirement excludes 40-char lowercase-hex git SHAs, and the exact-40 bound
  // excludes longer blobs/tokens. It catches the value when it appears bare in
  // prose with NO `NAME=` and NO nearby context word (e.g. inside a markdown
  // table or quoted in analysis) — the residual leak path the env-secret and
  // contextual rules both miss. Placed AFTER env-secret/url-password so the
  // keyed/URL forms keep their more-specific labels.
  { label: 'aws-secret-key',   pattern: /(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+]))(?=[A-Za-z0-9/+]*[a-z])(?=[A-Za-z0-9/+]*[A-Z])(?=[A-Za-z0-9/+]*[0-9])[A-Za-z0-9/+]{40}/g },
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
  // OpenAI. The `[-_]` class is what admits the modern project-scoped keys:
  // `sk-proj-…` has only four alphanumerics before a hyphen, so the old
  // `sk-[A-Za-z0-9]{20,}` could never match one. Same for `sk-svcacct-`.
  { label: 'openai-key',       pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
  // Google API key (AIza…).
  { label: 'google-api-key',   pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Generic JWT — three base64url segments.
  { label: 'jwt',              pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  // Private key blocks (PEM). Strips between BEGIN/END markers. The label part
  // is a free word run rather than a fixed list, so ENCRYPTED PRIVATE KEY and
  // SSH2 ENCRYPTED PRIVATE KEY are covered without another enumeration.
  { label: 'private-key',      pattern: /-----BEGIN (?:[A-Z0-9 ]{0,32})PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9 ]{0,32})PRIVATE KEY(?: BLOCK)?-----/g },
  // PuTTY private keys are not PEM and carry the material on Private-Lines.
  { label: 'putty-key',        pattern: /PuTTY-User-Key-File-\d[\s\S]*?Private-MAC:[ \t]*[A-Fa-f0-9]+/g },
  // npm tokens (uuid-shaped — overlap with our UUID filter; intentional).
  { label: 'npm-token',        pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // .npmrc auth lines: //registry.npmjs.org/:_authToken=VALUE (the key is not
  // ALL-CAPS, so the env-secret rule above never matched it). The leading `:`
  // is required — it is what makes this npmrc syntax rather than any shell var
  // ending in _AUTH, which env-secret already owns and labels better.
  { label: 'npmrc-auth',       pattern: /(?<=:_(?:authToken|password|auth)[ \t]*=[ \t]*)\S{12,}/gi },
  // HTTP Authorization headers. env-secret requires an ALL-CAPS name, and
  // `Authorization` is mixed case, so both Bearer and Basic walked straight
  // through — including short opaque tokens the contextual pass also misses
  // (it needs 32+ chars AND mixed-case-plus-digit).
  { label: 'auth-header',      pattern: /(?<=\bauthorization[ \t]*:[ \t]*(?:bearer|basic|token)[ \t]+)\S{8,}/gi },
  // Vendor tokens with unambiguous prefixes. Each is a fixed literal, so a
  // false positive is essentially impossible and the cost of listing is low.
  { label: 'gitlab-pat',       pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'slack-app-token',  pattern: /\bxapp-\d-[A-Za-z0-9-]{10,}\b/g },
  { label: 'sendgrid-key',     pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { label: 'mailgun-key',      pattern: /\bkey-[a-f0-9]{32}\b/g },
  { label: 'digitalocean-pat', pattern: /\bdop_v1_[a-f0-9]{64}\b/g },
  { label: 'huggingface-token',pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { label: 'shopify-token',    pattern: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g },
  { label: 'pypi-token',       pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}\b/g },
  { label: 'twilio-sid',       pattern: /\b(?:AC|SK)[a-f0-9]{32}\b/g },
  { label: 'discord-bot-token',pattern: /\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g },
  { label: 'telegram-bot-token',pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{32,}\b/g },
  { label: 'doppler-token',    pattern: /\bdp\.(?:pt|st|sa|ct)\.[A-Za-z0-9_-]{20,}\b/g },
  // Azure Storage SAS signature — the `sig=` parameter is the actual secret.
  { label: 'azure-sas',        pattern: /(?<=[?&]sig=)[A-Za-z0-9%/+=]{20,}/g },
];

// ---------------------------------------------------------------------------
// Contextual bare-secret detection.
//
// The rules above need the secret to be SHAPED (recognizable prefix) or KEYED
// (`NAME=value`). Neither catches a bare AWS-secret-key VALUE pasted into
// prose/code — exactly how the real leak escaped: `search('Fake0Secret0Example0Key0NotReal0abcdEF12…')`
// with no `AWS_SECRET_ACCESS_KEY=` in front of it. A naive "redact any 40-char
// base64" rule would shred git SHAs, base64 blobs, and ids. So instead we
// require BOTH: (a) a secret-context word shortly before the token, and (b) the
// token itself looking like a real secret (>=32 base64 chars, mixed case + a
// digit — which excludes lowercase-hex SHAs and all-lower base64url ids).
// ---------------------------------------------------------------------------
const SECRET_CONTEXT_RE = /\b(?:secret|password|passwd|credential|access[ _-]?key|private[ _-]?key|api[ _-]?key|auth(?:oriz\w*)?|bearer|token)\b/gi;
// Charset includes base64url (-/_) — bare base64url secrets used to slip
// through because only classic base64 was matched.
const HIGH_ENTROPY_TOKEN_RE = /[A-Za-z0-9/+_-]{32,}/g;

/**
 * A bare token is "secret-shaped" when long AND either mixed-case-with-digit
 * (classic base64 secrets) or PURE HEX (many real API keys are 32/40/64-char
 * hex — the original mixed-case requirement waved every one of them through).
 * Hex checksums (git SHAs, digests) can false-positive here, but this only
 * fires within 80 chars of an explicit secret-context word — "commit abc123…"
 * has no such word, "api key 3f2a…" does. A redacted checksum in derived
 * data is a paper cut; a leaked hex credential is the product failing at the
 * one thing its Security page sells.
 */
function looksLikeSecretToken(t: string): boolean {
  if (t.length < 32) return false;
  if (/^[a-f0-9]+$/i.test(t)) return true; // pure hex, 32+ chars
  return /[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t);
}

/**
 * Find bare high-entropy secret VALUES that sit just after a secret-context
 * word (within an 80-char window). Returns absolute [start,end) ranges in
 * `text`, de-duplicated and non-overlapping. Used by BOTH the redactor and the
 * detector so redaction and `secret_findings` stay in lockstep.
 */
export function findContextualSecrets(text: string): { start: number; end: number }[] {
  if (!text) return [];
  const ranges: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  SECRET_CONTEXT_RE.lastIndex = 0;
  while ((m = SECRET_CONTEXT_RE.exec(text)) !== null) {
    const winStart = m.index + m[0].length;
    const window = text.slice(winStart, winStart + 80);
    HIGH_ENTROPY_TOKEN_RE.lastIndex = 0;
    let tm: RegExpExecArray | null;
    while ((tm = HIGH_ENTROPY_TOKEN_RE.exec(window)) !== null) {
      if (!looksLikeSecretToken(tm[0])) continue;
      // Pure-hex tokens are also what checksums look like. When the text
      // BETWEEN the context word and the token names a checksum ("the secret
      // commit is <sha>", "token cache hash <digest>"), it's a reference,
      // not a credential — skip it. "api key 3f2a…" has no such word and
      // stays redacted.
      if (/^[a-f0-9]+$/i.test(tm[0]) && /\b(?:commit|sha-?\d*|hash|digest|checksum|uuid|guid|etag|blob|ref)\b/i.test(window.slice(0, tm.index))) {
        continue;
      }
      ranges.push({ start: winStart + tm.index, end: winStart + tm.index + tm[0].length });
      break; // first qualifying token per context word is enough
    }
  }
  // De-dupe / drop overlaps (multiple context words can point at the same token).
  ranges.sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r.start < last.end) { last.end = Math.max(last.end, r.end); continue; }
    out.push({ ...r });
  }
  return out;
}

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

// ---------------------------------------------------------------------------
// Server-served rule pack.
//
// Detection has to run on the client (the server never receives unredacted
// text), but the RULES don't have to ship with the client. A tenant rule marked
// `redact` is installed here at the start of a sync and joins the redaction set
// for this process, so coverage can be improved from the dashboard without
// waiting for every device to upgrade its CLI.
//
// Two invariants, both deliberate:
//   1. ADD-ONLY. A pack can never remove or weaken DEFAULT_REDACTION_RULES. A
//      compromised or fat-fingered server can therefore make us redact more,
//      never less — the same fail-safe direction as the sync exclusions union.
//   2. VALIDATED. A remote regex runs against every string we ship, so an
//      over-broad one would shred the product's usefulness (and a pathological
//      one would hang the walk). Rules that fail the checks below are dropped
//      individually; the rest of the pack still installs.
// ---------------------------------------------------------------------------

/** A rule as it arrives from the server (regex as a string, not a RegExp).
 *  `source` only decides the sentinel label: `pack:` for rules chat-recall
 *  curates and ships to every tenant, `tenant:` for ones this customer wrote.
 *  Keeping them distinguishable matters when someone asks "why was this
 *  redacted?" — the answer is a different conversation in each case. */
export interface ServerRuleSpec { name: string; regex: string; flags?: string; redact?: boolean; source?: 'tenant' | 'pack' }

/** Rejected rule + why, returned to the caller for logging. */
export interface RejectedRule { name: string; reason: string }

/** Text that must NEVER match a redaction rule. A pattern that fires on
 *  ordinary prose or a git SHA is over-broad, and applying it would replace
 *  legitimate content with sentinels across the whole corpus. */
const CANARY = 'the quick brown fox jumps over the lazy dog 0123456789 '
  + 'commit 8ba1f109551bd432803012645ac136ddd475d0fb src/index.ts:42';

const MAX_PACK_RULES = 200;
const MAX_PATTERN_LEN = 512;

let serverPack: { version: string; rules: RedactionRule[] } | null = null;

/** Validate one server rule; returns the compiled rule or a rejection reason. */
function compileServerRule(spec: ServerRuleSpec): RedactionRule | RejectedRule {
  const name = spec.name || '(unnamed)';
  if (!spec.regex) return { name, reason: 'empty pattern' };
  if (spec.regex.length > MAX_PATTERN_LEN) return { name, reason: `pattern longer than ${MAX_PATTERN_LEN} chars` };
  let re: RegExp;
  try {
    // 'g' is required (we replace every occurrence); anything else the server
    // asked for is dropped — 'i'/'m'/'s' are fine, but we don't accept 'y'/'d'
    // whose lastIndex/indices semantics would change the replace behaviour.
    const flags = 'g' + (spec.flags || '').replace(/[^ims]/g, '');
    re = new RegExp(spec.regex, flags);
  } catch (e) {
    return { name, reason: `invalid regex: ${e instanceof Error ? e.message : e}` };
  }
  if (re.test('')) return { name, reason: 'matches the empty string (would redact everything)' };
  re.lastIndex = 0;
  if (re.test(CANARY)) return { name, reason: 'matches benign text — too broad' };
  re.lastIndex = 0;
  return { label: `${spec.source === 'pack' ? 'pack' : 'tenant'}:${name}`, pattern: re };
}

/**
 * Would this rule be accepted as a REDACTING rule? Same checks the collector
 * applies, exposed so the server can reject an over-broad rule at write time —
 * otherwise the dashboard would happily save a rule that every client silently
 * drops, which looks like coverage the operator does not have.
 */
export function validateRedactionRule(spec: ServerRuleSpec): { ok: true } | { ok: false; reason: string } {
  const out = compileServerRule(spec);
  return 'reason' in out ? { ok: false, reason: out.reason } : { ok: true };
}

/**
 * Install the server's rule pack for this process. Returns what was accepted
 * and what was rejected (callers log the rejections — a silently ignored rule
 * looks like coverage the operator does not actually have).
 *
 * Idempotent: installing again replaces the previous pack, never the builtins.
 */
export function installServerRulePack(
  pack: { version?: string; rules: ServerRuleSpec[] },
): { version: string; accepted: number; rejected: RejectedRule[] } {
  const rejected: RejectedRule[] = [];
  const rules: RedactionRule[] = [];
  for (const spec of pack.rules || []) {
    if (rules.length >= MAX_PACK_RULES) {
      rejected.push({ name: spec.name || '(unnamed)', reason: `pack exceeds ${MAX_PACK_RULES} rules` });
      continue;
    }
    const out = compileServerRule(spec);
    if ('reason' in out) rejected.push(out); else rules.push(out);
  }
  const version = pack.version || '';
  serverPack = { version, rules };
  return { version, accepted: rules.length, rejected };
}

/** Version string of the installed pack, or null when none is installed. */
export function serverRulePackVersion(): string | null {
  return serverPack ? (serverPack.version || 'unversioned') : null;
}

/** Drop the installed pack (tests, and `logout`). */
export function _clearServerRulePack(): void { serverPack = null; }

/** Builtins + settings rules + the installed server pack, in that order. The
 *  baseline always comes first so its labels win on overlapping matches. */
function activeRules(): RedactionRule[] {
  const base = settingsView().rules;
  return serverPack && serverPack.rules.length > 0 ? [...base, ...serverPack.rules] : base;
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
  // Default rule set = baseline + user-added rules from settings + the
  // server-served pack. Caller can still override entirely via `opts.rules` if
  // they need a clean set.
  const rules = opts.rules || activeRules();
  let out = text;
  for (const r of rules) {
    out = out.replace(r.pattern, () => {
      if (opts.count) opts.count.redactions++;
      return `[REDACTED:${r.label}]`;
    });
  }
  // Second pass: bare secret values near a context word (not caught by the
  // shape/keyed rules above). Replace right-to-left so earlier indices stay
  // valid as we splice. Runs on the post-rule string — keyed values are already
  // sentinels by now, so this only fires on what the rules missed.
  const ctx = findContextualSecrets(out);
  for (let i = ctx.length - 1; i >= 0; i--) {
    const { start, end } = ctx[i];
    if (opts.count) opts.count.redactions++;
    out = out.slice(0, start) + '[REDACTED:secret-context]' + out.slice(end);
  }
  return out;
}

/** Masked finding from the in-process pattern engine. */
export interface RedactorFinding { rule: string; line: number; preview: string; }

/** Last-4-only mask — the raw secret is never returned. */
function maskSecret(s: string): string {
  if (!s) return '';
  if (s.length <= 4) return '*'.repeat(s.length);
  return '*'.repeat(Math.min(s.length - 4, 60)) + s.slice(-4);
}

/**
 * Run the redaction rule set over `text` as a DETECTOR: one masked finding per
 * match (rule label + 1-based line + last-4 preview). Same patterns that drive
 * redaction, but REPORTED instead of (or in addition to) being masked.
 *
 * This is the UNIVERSAL scanner: pure in-process regex, zero external
 * dependencies, so EVERY user (incl. vanilla SaaS users) gets secret findings —
 * unlike the optional gitleaks/trufflehog binaries which most users won't have.
 * The collector ships these to the server's `secret_findings`.
 */
export function scanTextForFindings(text: string, opts: { rules?: RedactionRule[] } = {}): RedactorFinding[] {
  if (!text) return [];
  // activeRules(), not settingsView().rules: a rule served by the server must
  // both REDACT and be REPORTED. Using the narrower set here meant a pack rule
  // silently scrubbed text without ever producing a finding — so the dashboard
  // showed nothing while the redaction that fired was the only evidence a
  // credential had been there at all. Also what makes the server's re-scan
  // ("today's rules over stored text") actually mean today's rules.
  const rules = opts.rules || activeRules();
  const findings: RedactorFinding[] = [];
  // One secret = one finding, even when several rules recognise it. The server
  // rule pack deliberately overlaps the builtins in places (a pack rule may be
  // BROADER for the same vendor), and without this the same leaked key would be
  // counted twice, inflating both the occurrence count and the "how many
  // detectors agree" signal the dashboard sorts on. Keyed by exact span, so a
  // genuinely different (merely overlapping) match still reports.
  const seenSpans = new Set<string>();
  for (const r of rules) {
    const re = new RegExp(r.pattern.source, r.pattern.flags.includes('g') ? r.pattern.flags : r.pattern.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const span = `${m.index}:${m[0].length}`;
      if (!seenSpans.has(span)) {
        seenSpans.add(span);
        const line = text.slice(0, m.index).split('\n').length; // 1-based, handles multi-line patterns
        findings.push({ rule: r.label, line, preview: maskSecret(m[0]) });
      }
      if (re.lastIndex === m.index) re.lastIndex++; // guard zero-width (lookbehind matches)
    }
  }
  // Contextual bare-secret findings (same detector the redactor uses).
  for (const { start, end } of findContextualSecrets(text)) {
    const line = text.slice(0, start).split('\n').length;
    findings.push({ rule: 'secret-context', line, preview: maskSecret(text.slice(start, end)) });
  }
  return findings;
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
