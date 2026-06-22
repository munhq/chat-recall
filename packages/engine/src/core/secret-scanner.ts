/**
 * Secret detection wrapper. Runs gitleaks + trufflehog as subprocesses
 * against a single session's raw source file and writes findings to
 * `secret_findings` (redacted previews only — raw secrets are NEVER
 * persisted).
 *
 * Called from the indexer's per-session compute path so new sessions
 * are scanned automatically. Falls back to a no-op when the binaries
 * aren't installed (the feature is opt-in: install gitleaks +
 * trufflehog into PATH and it lights up; otherwise the rest of the
 * indexer works unchanged).
 *
 * Why subprocesses (vs an in-process JS lib): the regex packs in
 * gitleaks/trufflehog are maintained by people who do this full-time.
 * Re-implementing them in TypeScript would be a permanent maintenance
 * tax that's never ahead of upstream.
 *
 * Secretlint deliberately omitted here — the test scan showed it
 * produced near-duplicate output with secretlint:database-connection
 * adding mostly false positives on chat-style text. trufflehog
 * already covers everything secretlint flagged that mattered.
 */

import { spawnSync, execFileSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StorageDriver } from './store/driver.js';

/** Last 4 chars only — never the raw secret. */
function mask(s: string | undefined | null): string {
  if (!s) return '';
  if (s.length <= 4) return '*'.repeat(s.length);
  return '*'.repeat(Math.min(s.length - 4, 60)) + s.slice(-4);
}

/**
 * Reject findings whose underlying text is just a UUID. Claude/Codex
 * JSONL emits a `"uuid":"..."` on every turn — the 8-4-4-4-12 hex shape
 * matches enough credential regexes (Dockerhub, NpmToken, generic
 * hash-shaped tokens) that without this filter ~40% of findings are
 * spurious. Detectors run on raw text so we can sniff the original
 * before masking.
 *
 * UUID v1-v5: `[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`
 * Loosened slightly to cover non-strict-RFC variants found in the wild.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function looksLikeUuid(raw: string): boolean {
  return UUID_RE.test(raw.trim());
}

/**
 * Resolve a tool from PATH. We don't hard-fail if missing — the
 * scanner is opt-in. Returns the absolute path, or `null` to signal
 * "skip this detector."
 */
function which(bin: string): string | null {
  try {
    const out = execFileSync('which', [bin], { encoding: 'utf-8' }).trim();
    return out || null;
  } catch { return null; }
}

interface RawFinding { rule: string; line: number; preview: string; }

function runGitleaks(binary: string, filePath: string): RawFinding[] {
  const reportPath = `${filePath}.gitleaks.json`;
  const r = spawnSync(binary,
    ['dir', filePath, '--no-banner', '--report-format', 'json',
     '--report-path', reportPath, '--exit-code', '0'],
    { encoding: 'utf-8', timeout: 60_000 },
  );
  if (r.status !== 0 && r.status !== 1) return [];
  let parsed: any[] = [];
  try { parsed = JSON.parse(readFileSync(reportPath, 'utf-8')) || []; } catch { /* missing or malformed */ }
  try { unlinkSync(reportPath); } catch { /* already gone */ }
  return parsed
    .filter((f) => !looksLikeUuid(f.Secret || f.Match || ''))
    .map((f) => ({
      rule: f.RuleID || f.Description || 'unknown',
      line: f.StartLine || 0,
      preview: mask(f.Secret || f.Match || ''),
    }));
}

interface RunOpts {
  /** When true, run trufflehog with --only-verified — calls issuing
   *  services to confirm keys are live. Acceptable to send keys to
   *  their own issuer (they already have them) but not all detectors
   *  support verification, and it requires outbound network. Off by
   *  default. */
  verifyOnly?: boolean;
}

function runTrufflehog(binary: string, filePath: string, opts: RunOpts = {}): Array<RawFinding & { verified?: boolean }> {
  // --only-verified: call out to AWS/GitHub/Stripe/etc. to confirm
  // a found key is currently live. Drops the noise dramatically —
  // most "leaks" in chat content are dead keys that have already
  // expired. Live ones are the actionable subset.
  // --no-verification: skip the call (default; safe for offline use).
  const verifyArgs = opts.verifyOnly ? ['--only-verified'] : ['--no-verification'];
  const r = spawnSync(binary,
    ['filesystem', filePath, ...verifyArgs, '--json'],
    { encoding: 'utf-8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0 && !r.stdout) return [];
  const out: Array<RawFinding & { verified?: boolean }> = [];
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      const raw = j.Raw || '';
      if (looksLikeUuid(raw)) continue;
      out.push({
        rule: j.DetectorName || 'unknown',
        line: j.SourceMetadata?.Data?.Filesystem?.line || 0,
        preview: mask(raw),
        // trufflehog reports `Verified: true` only when --verification
        // ran AND the call succeeded. With --only-verified set, every
        // returned finding is verified live by definition, so we tag
        // them all true; with --no-verification, leave undefined.
        verified: opts.verifyOnly ? true : (j.Verified === true ? true : undefined),
      });
    } catch { /* skip malformed line */ }
  }
  return out;
}

export interface ScanFinding { detector: string; rule: string; line: number; preview: string; verified?: boolean; }

/** A finding from a directory scan, carrying the file it was found in so the
 *  caller can map it back to a session (filename === session id). */
export interface DirScanFinding extends ScanFinding { file: string; }

/** gitleaks over a whole directory in ONE process — retains the `File` field
 *  so each finding maps back to its source file. The report is written OUTSIDE
 *  the scanned dir so gitleaks never scans its own output. */
function runGitleaksDir(binary: string, dir: string): Array<RawFinding & { file: string }> {
  const reportPath = `${dir}.gitleaks.json`;
  const r = spawnSync(binary,
    ['dir', dir, '--no-banner', '--report-format', 'json',
     '--report-path', reportPath, '--exit-code', '0'],
    { encoding: 'utf-8', timeout: 600_000, maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.status !== 0 && r.status !== 1) { try { unlinkSync(reportPath); } catch { /* none */ } return []; }
  let parsed: any[] = [];
  try { parsed = JSON.parse(readFileSync(reportPath, 'utf-8')) || []; } catch { /* missing or malformed */ }
  try { unlinkSync(reportPath); } catch { /* already gone */ }
  return parsed
    .filter((f) => !looksLikeUuid(f.Secret || f.Match || ''))
    .map((f) => ({
      rule: f.RuleID || f.Description || 'unknown',
      line: f.StartLine || 0,
      preview: mask(f.Secret || f.Match || ''),
      file: f.File || '',
    }));
}

/** trufflehog over a whole directory in ONE process — retains the filesystem
 *  `file` path so each finding maps back to its source file. */
function runTrufflehogDir(binary: string, dir: string, opts: RunOpts = {}): Array<RawFinding & { verified?: boolean; file: string }> {
  const verifyArgs = opts.verifyOnly ? ['--only-verified'] : ['--no-verification'];
  const r = spawnSync(binary,
    ['filesystem', dir, ...verifyArgs, '--json'],
    { encoding: 'utf-8', timeout: 600_000, maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.status !== 0 && !r.stdout) return [];
  const out: Array<RawFinding & { verified?: boolean; file: string }> = [];
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      const raw = j.Raw || '';
      if (looksLikeUuid(raw)) continue;
      out.push({
        rule: j.DetectorName || 'unknown',
        line: j.SourceMetadata?.Data?.Filesystem?.line || 0,
        preview: mask(raw),
        verified: opts.verifyOnly ? true : (j.Verified === true ? true : undefined),
        file: j.SourceMetadata?.Data?.Filesystem?.file || '',
      });
    } catch { /* skip malformed line */ }
  }
  return out;
}

/**
 * Scan an entire DIRECTORY of materialized files in ONE invocation per
 * detector (vs. one per file). Findings carry their source `file` so the
 * caller can group them by session (we name each file `<sessionId>.txt`).
 *
 * This is the batch path used by sync: writing N session texts into a temp
 * dir and calling this once is 2 process spawns total, instead of 2·N — the
 * spawn + detector-set-reload cost is what made per-session scanning slow.
 * Tenant rules are intentionally NOT applied here (they are cheap in-memory
 * regex the caller already runs per-session on the un-redacted text).
 */
export function scanDirForSecrets(
  dir: string,
  opts: { verifyOnly?: boolean } = {},
): DirScanFinding[] {
  if (!existsSync(dir)) return [];
  const gitleaks = which('gitleaks');
  const trufflehog = which('trufflehog');
  const out: DirScanFinding[] = [];
  if (gitleaks) for (const f of runGitleaksDir(gitleaks, dir)) out.push({ detector: 'gitleaks', ...f });
  if (trufflehog) for (const f of runTrufflehogDir(trufflehog, dir, { verifyOnly: opts.verifyOnly })) out.push({ detector: 'trufflehog', ...f });
  return out;
}

/**
 * Scan a single file with whatever detectors are installed on PATH (+ optional
 * tenant rules). Returns MASKED findings — raw secrets never leave this
 * function. Empty array when no detector binaries are present (the feature is
 * opt-in: install gitleaks/trufflehog and it lights up).
 *
 * Store-free by design: the thin collector calls this on the raw session file
 * (where the secrets actually are, before redaction) and SHIPS the findings in
 * the sync envelope; the server persists them via `replaceSecretFindings`.
 * `scanSessionForSecrets` below is the store-writing wrapper for local/in-process use.
 */
/**
 * Apply tenant-configurable regex rules directly to text. Used both by the
 * binary scanner (gitleaks/trufflehog) path and by callers that already have
 * raw text in memory and want in-process tenant-rule matching.
 */
export function scanTenantRules(text: string, tenantRules: Array<{ name: string; regex: string }>): ScanFinding[] {
  const out: ScanFinding[] = [];
  const lines = text.split('\n');
  for (const r of tenantRules) {
    let re: RegExp;
    try { re = new RegExp(r.regex, 'g'); } catch { continue; }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (!looksLikeUuid(m[0])) out.push({ detector: 'tenant', rule: r.name, line: i + 1, preview: mask(m[0]) });
        if (re.lastIndex === m.index) re.lastIndex++; // guard zero-width
      }
    }
  }
  return out;
}

export function scanFileForSecrets(
  filePath: string,
  opts: { verifyOnly?: boolean; tenantRules?: Array<{ name: string; regex: string }> } = {},
): ScanFinding[] {
  if (!existsSync(filePath)) return [];
  const gitleaks = which('gitleaks');
  const trufflehog = which('trufflehog');
  const out: ScanFinding[] = [];
  if (gitleaks) for (const f of runGitleaks(gitleaks, filePath)) out.push({ detector: 'gitleaks', ...f });
  if (trufflehog) for (const f of runTrufflehog(trufflehog, filePath, { verifyOnly: opts.verifyOnly })) out.push({ detector: 'trufflehog', ...f });
  if (opts.tenantRules && opts.tenantRules.length > 0) {
    try {
      const text = readFileSync(filePath, 'utf-8');
      out.push(...scanTenantRules(text, opts.tenantRules));
    } catch { /* unreadable */ }
  }
  return out;
}

// secret_findings schema now lives in MemoryStore.ensureSecretFindingsTable()
// so the scanner writer + dashboard readers share one StorageDriver path.

export interface ScanResult {
  sessionId: string;
  byDetector: Record<string, number>;
  total: number;
  /** True when at least one detector ran. False when all binaries are
   *  missing → caller should treat the scan as "not configured." */
  ran: boolean;
}

/**
 * Scan one session's source file. Re-scans of the same session
 * replace prior findings (DELETE-then-insert) so flapping content
 * doesn't accumulate stale rows.
 *
 * Returns counts per detector for caller logging. The full findings
 * land in `secret_findings`; readers go through MemoryStore APIs
 * (`secretFindingsForSession`).
 */
export async function scanSessionForSecrets(opts: {
  sessionId: string;
  filePath: string;
  /** Storage backend (sqlite|postgres) the findings + tenant rules go through. */
  store: StorageDriver;
  /** When true, run trufflehog with --only-verified. Findings will
   *  only include keys whose live-validity was confirmed via an
   *  outbound API call. Default false (offline-safe). */
  verifyOnly?: boolean;
}): Promise<ScanResult> {
  const result: ScanResult = { sessionId: opts.sessionId, byDetector: {}, total: 0, ran: false };

  if (!existsSync(opts.filePath)) return result;

  const gitleaks = which('gitleaks');
  const trufflehog = which('trufflehog');
  if (!gitleaks && !trufflehog) return result;

  const allFindings: Array<{ detector: string; verified?: boolean } & RawFinding> = [];
  if (gitleaks) {
    for (const f of runGitleaks(gitleaks, opts.filePath)) allFindings.push({ detector: 'gitleaks', ...f });
    result.ran = true;
  }
  if (trufflehog) {
    for (const f of runTrufflehog(trufflehog, opts.filePath, { verifyOnly: opts.verifyOnly })) {
      allFindings.push({ detector: 'trufflehog', ...f });
    }
    result.ran = true;
  }

  // ── Tenant-configurable rules ───────────────────────────────────
  // Read once, apply against the same source file in-process. No
  // subprocess overhead per rule, and tenant rules don't need
  // verification — they're customer-specific patterns the customer
  // already trusts.
  try {
    const tenantRules = (await opts.store.listSecretRules())
      .filter(r => r.enabled)
      .map(r => ({ name: r.name, regex: r.regex, severity: r.severity }));
    if (tenantRules.length > 0) {
      const text = readFileSync(opts.filePath, 'utf-8');
      const lines = text.split('\n');
      for (const r of tenantRules) {
        let re: RegExp;
        try { re = new RegExp(r.regex, 'g'); }
        catch { continue; /* malformed regex — skip rather than abort */ }
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          let m: RegExpExecArray | null;
          while ((m = re.exec(line)) !== null) {
            if (looksLikeUuid(m[0])) continue;
            allFindings.push({
              detector: 'tenant',
              rule: r.name,
              line: i + 1,
              preview: mask(m[0]),
            });
            if (re.lastIndex === m.index) re.lastIndex++; // guard zero-width
          }
        }
      }
      if (tenantRules.length > 0) result.ran = true;
    }
  } catch { /* tenant rules table not initialised — first run, no rules */ }

  for (const f of allFindings) {
    result.byDetector[f.detector] = (result.byDetector[f.detector] || 0) + 1;
    result.total++;
  }
  // Persist through the StorageDriver (sqlite local | postgres team/cloud)
  // instead of opening cache.db directly — keeps the scanner backend-agnostic.
  await opts.store.replaceSecretFindings(opts.sessionId, allFindings);

  return result;
}

/** True when at least one detector binary is available on PATH. */
export function isSecretScannerAvailable(): boolean {
  return !!which('gitleaks') || !!which('trufflehog');
}

// Tenant rules now read via StorageDriver.listSecretRules() (filtered by
// `enabled`) — see the call in scanSessionForSecrets above.
