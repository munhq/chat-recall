/**
 * Secret detection wrapper. Runs gitleaks + trufflehog as subprocesses
 * against a single session's raw source file and writes findings to
 * `secret_findings` (redacted previews only — raw secrets are NEVER
 * persisted).
 *
 * ────────────────────────────────────────────────────────────────────
 * THESE DETECTORS ARE OPT-IN AND DEFAULT OFF. Set
 * `CHAT_RECALL_EXTERNAL_SCANNERS=1` to enable them.
 *
 * Detection that the product's privacy guarantee depends on lives
 * elsewhere and is NOT affected by this switch: `secret-redactor.ts`
 * runs in-process on every user, always, with no external dependency.
 * What the binaries here add is *enrichment* of the findings dashboard.
 *
 * They are off by default because running third-party binaries inside a
 * customer's sync daemon has costs we do not control:
 *   - Coverage becomes device-dependent (laptop with trufflehog and
 *     laptop without produce different findings for the same session).
 *   - We inherit their process behaviour. trufflehog ships wrapped in
 *     jpillora/overseer, which copies its own 34MB binary into $TMPDIR
 *     on every spawn and never removes it — 451 copies (15GB) filled a
 *     31GB tmpfs on a dev machine and broke every process needing /tmp.
 *   - Scanning takes place BEFORE redaction, so it needs raw session
 *     text on disk (see the caller's bounded batch dir).
 * Legitimate homes for them: a developer/CI machine, or a self-hosted
 * deployment where the operator owns the data and the container.
 * ────────────────────────────────────────────────────────────────────
 *
 * Why subprocesses (vs an in-process JS lib) when they ARE enabled: the
 * regex packs in gitleaks/trufflehog are maintained by people who do
 * this full-time. Re-implementing them in TypeScript would be a
 * permanent maintenance tax that's never ahead of upstream.
 *
 * Secretlint deliberately omitted here — the test scan showed it
 * produced near-duplicate output with secretlint:database-connection
 * adding mostly false positives on chat-style text. trufflehog
 * already covers everything secretlint flagged that mattered.
 */

import { spawnSync, execFileSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdtempSync, rmSync } from 'fs';
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
 * Master switch for the external detector binaries. DEFAULT OFF — see the
 * file header for why. Read on every call (not cached) so a daemon that is
 * restarted with the flag picks it up, and so tests can flip it.
 *
 * Only the binaries are gated. Builtin redaction, the builtin findings scan
 * and tenant regex rules are unaffected: they are in-process, dependency-free
 * and run for every user.
 */
export function externalScannersEnabled(): boolean {
  const v = (process.env.CHAT_RECALL_EXTERNAL_SCANNERS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** `which`, but returns null whenever external detectors are disabled — one
 *  choke point so no code path can spawn a detector behind the gate's back. */
function whichDetector(bin: string): string | null {
  return externalScannersEnabled() ? which(bin) : null;
}

/**
 * Resolve a tool from PATH — cross-platform. Unix uses `which`; Windows uses
 * the `where` builtin (which.exe doesn't exist there). `where` returns the full
 * path incl. the `.exe`, which the subsequent spawnSync executes directly, and
 * can list multiple matches (one per line) — we take the first. We don't
 * hard-fail if missing: the scanner is opt-in. Returns the path, or `null` to
 * skip this detector.
 */
function which(bin: string): string | null {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, [bin], { encoding: 'utf-8' }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    return first || null;
  } catch { return null; }
}

interface RawFinding { rule: string; line: number; preview: string; }

/**
 * Run a scanner subprocess in a PRIVATE temp dir, then delete it.
 *
 * `--no-update` is not a sufficient defence. trufflehog is wrapped in
 * jpillora/overseer, which copies the 34MB binary to $TMPDIR/overseer-<hash>
 * as part of process startup — before the app ever looks at its flags — and
 * never removes it. Continuous scanning therefore accretes 34MB per spawn: 451
 * copies (15GB) were found on one machine, which filled a 31GB tmpfs to 100%
 * and broke every process that needed /tmp.
 *
 * Rather than depend on a flag whose behaviour we don't control, we give the
 * child its own TMPDIR. Whatever it drops there is ours, and we delete the
 * whole directory when it exits. This is robust to any future scanner that
 * scribbles in the temp dir for reasons of its own.
 */
function spawnScoped(binary: string, args: string[], opts: Parameters<typeof spawnSync>[2] & object) {
  const scratch = mkdtempSync(join(tmpdir(), 'cr-scan-tmp-'));
  try {
    return spawnSync(binary, args, {
      ...opts,
      // TMPDIR covers POSIX; TEMP/TMP are the Windows spellings.
      env: { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch },
    } as never);
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function runGitleaks(binary: string, filePath: string): RawFinding[] {
  const reportPath = `${filePath}.gitleaks.json`;
  const r = spawnScoped(binary,
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
  // --no-update is NOT optional here. Without it trufflehog's self-updater
  // (overseer) copies its own 34MB binary to /tmp/overseer-<hash> on EVERY
  // invocation and never removes it. Measured on this machine: a real scan
  // leaves one copy, the same scan with --no-update leaves none. With scanning
  // running continuously that filled a 31GB tmpfs to 100% and took the shell
  // down with ENOSPC. This path is per-FILE, so it is the worse of the two.
  const r = spawnScoped(binary,
    ['filesystem', filePath, ...verifyArgs, '--json', '--no-update'],
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
  // spawnScoped, not spawnSync: gitleaks has no known temp-dir habit today, but
  // the whole point of the scoped TMPDIR is not having to know that per binary.
  const r = spawnScoped(binary,
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
  // --no-update: see runTrufflehog above. Every invocation without it leaves a
  // 34MB copy of the trufflehog binary in /tmp that nothing ever cleans up.
  const r = spawnScoped(binary,
    ['filesystem', dir, ...verifyArgs, '--json', '--no-update'],
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
 *
 * Returns [] unless CHAT_RECALL_EXTERNAL_SCANNERS is set — callers must treat
 * an empty result as "the optional enrichment did not run", never as "clean".
 */
export function scanDirForSecrets(
  dir: string,
  opts: { verifyOnly?: boolean } = {},
): DirScanFinding[] {
  if (!existsSync(dir)) return [];
  const gitleaks = whichDetector('gitleaks');
  const trufflehog = whichDetector('trufflehog');
  const out: DirScanFinding[] = [];
  if (gitleaks) for (const f of runGitleaksDir(gitleaks, dir)) out.push({ detector: 'gitleaks', ...f });
  if (trufflehog) for (const f of runTrufflehogDir(trufflehog, dir, { verifyOnly: opts.verifyOnly })) out.push({ detector: 'trufflehog', ...f });
  return out;
}

/**
 * Scan a single file with the external detectors (+ optional tenant rules).
 * Returns MASKED findings — raw secrets never leave this function. The
 * detectors run only when CHAT_RECALL_EXTERNAL_SCANNERS is set AND the binary
 * is on PATH; tenant rules run regardless (in-process regex).
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
  const gitleaks = whichDetector('gitleaks');
  const trufflehog = whichDetector('trufflehog');
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
  /** True when at least one detector ran (external binary or tenant rules).
   *  False when the external detectors are disabled/absent AND no tenant rules
   *  exist → caller should treat the scan as "not configured." */
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

  // External detectors are opt-in (CHAT_RECALL_EXTERNAL_SCANNERS=1). When they
  // are off — or simply not installed — tenant rules below still run: they are
  // in-process regex and are the customer's own configured patterns.
  const gitleaks = whichDetector('gitleaks');
  const trufflehog = whichDetector('trufflehog');

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
  // Nothing ran → do NOT persist. replaceSecretFindings is delete-then-insert,
  // so writing an empty set here would erase a previous real scan's findings
  // simply because this machine has the detectors switched off.
  if (!result.ran) return result;
  // Persist through the StorageDriver (sqlite local | postgres team/cloud)
  // instead of opening cache.db directly — keeps the scanner backend-agnostic.
  await opts.store.replaceSecretFindings(opts.sessionId, allFindings);

  return result;
}

/** True when the external detectors are ENABLED (CHAT_RECALL_EXTERNAL_SCANNERS)
 *  and at least one binary is on PATH. False by default — callers use this to
 *  decide whether to do the expensive raw-text materialization at all. */
export function isSecretScannerAvailable(): boolean {
  return !!whichDetector('gitleaks') || !!whichDetector('trufflehog');
}

// Tenant rules now read via StorageDriver.listSecretRules() (filtered by
// `enabled`) — see the call in scanSessionForSecrets above.
