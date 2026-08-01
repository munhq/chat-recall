/**
 * Hermetic install + resolution for the optional external secret detectors.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * The scanner used to find its binaries with `which`. That made the product's
 * behaviour a function of the customer's PATH, and it bit us hard: two
 * byte-identical trufflehog installs behaved differently purely because of
 * where they sat.
 *
 *     /usr/local/bin/trufflehog  (root-owned)  → +34MB in the temp dir per spawn
 *     ~/.local/bin/trufflehog    (user-owned)  →  nothing
 *
 * trufflehog is wrapped in jpillora/overseer, whose self-update path replaces
 * the binary in place; when the invoking user cannot write it, overseer copies
 * all 34MB into the temp dir, execs the copy, and never cleans up. A sync daemon
 * whose PATH resolved the root-owned install accreted 34MB per sync until a 31GB
 * tmpfs was full and every process needing /tmp broke.
 *
 * "Tell the customer to chown their binary" is not a product. So we stop asking
 * the machine where the binary is:
 *
 *   1. PINNED — one version per detector, chosen by us, recorded below.
 *   2. VERIFIED — the release archive's sha256 must match the manifest before
 *      anything is made executable, and the extracted binary's own sha256 is
 *      re-checked on use. A mirror serving different bytes gets nothing.
 *   3. USER-OWNED BY CONSTRUCTION — installed under `~/.chat-recall/bin`, which
 *      the invoking user owns. That removes the precondition for the leak
 *      instead of mitigating its symptom.
 *   4. ABSOLUTE-PATH INVOCATION — PATH is never consulted, so a stray install
 *      elsewhere on the machine can neither be picked up nor shadow ours.
 *
 * `--no-update` and the scoped TMPDIR in secret-scanner.ts stay as they are.
 * They are cheap, and defence in depth is the point: this file removes the
 * cause, those two bound the blast radius if a future detector misbehaves for
 * a reason we have not measured yet.
 *
 * ── Scope ────────────────────────────────────────────────────────────────
 * These binaries remain OPT-IN and OFF by default (CHAT_RECALL_EXTERNAL_SCANNERS)
 * and are a developer/CI/self-host tool, never part of the SaaS default path.
 * Detection every user depends on is the in-process engine in secret-redactor.ts.
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  existsSync, mkdirSync, mkdtempSync, chmodSync, renameSync, rmSync,
  writeFileSync, readFileSync, statSync, copyFileSync,
} from 'fs';
import { join } from 'path';
import { getDetectorBinDir } from './paths.js';
import { createLogger } from './logger.js';

const log = createLogger('detector-install');

export type DetectorName = 'trufflehog' | 'gitleaks';

interface AssetSpec {
  /** Release asset filename. */
  file: string;
  /** sha256 of the ASSET as published in the release's checksums.txt. */
  sha256: string;
}

interface DetectorSpec {
  version: string;
  /** `${repo}` on GitHub, used to build the release download URL. */
  repo: string;
  /** Path of the executable inside the archive. */
  member: string;
  /** Keyed by `${process.platform}-${process.arch}`. */
  assets: Record<string, AssetSpec>;
  /** SPDX id — recorded because it constrains what we may do with the tool. */
  license: string;
}

/**
 * Pinned releases. The sha256 values are copied verbatim from each release's
 * published `*_checksums.txt` (fetched 2026-08-01).
 *
 * Bumping a version means replacing BOTH the version and every hash — a
 * mismatch fails the install closed rather than falling back to whatever the
 * mirror served.
 */
export const DETECTOR_MANIFEST: Record<DetectorName, DetectorSpec> = {
  trufflehog: {
    version: '3.96.0',
    repo: 'trufflesecurity/trufflehog',
    member: 'trufflehog',
    license: 'AGPL-3.0',
    assets: {
      'linux-x64':    { file: 'trufflehog_3.96.0_linux_amd64.tar.gz',   sha256: '7105f1cd6577f058a9e39d0578f1a99c8a1e481e4d3512cd8a09acfe22a0fdc0' },
      'linux-arm64':  { file: 'trufflehog_3.96.0_linux_arm64.tar.gz',   sha256: '50acd4c7a3b8ebfe5083d8350956057030c44be3515dedd55b45263495c490b2' },
      'darwin-x64':   { file: 'trufflehog_3.96.0_darwin_amd64.tar.gz',  sha256: 'a30d8f1095e031a81a668e1582f2ed479c3b50476cef86317e0fb74210c33617' },
      'darwin-arm64': { file: 'trufflehog_3.96.0_darwin_arm64.tar.gz',  sha256: '87478306b95ca2420cfb844b7582383ac60b922e262350a0088e797f328d2e62' },
      'win32-x64':    { file: 'trufflehog_3.96.0_windows_amd64.tar.gz', sha256: 'fbf918c52a1f29be96344e1c4696fe019cfc34fb1184fab31cf3e8347917b43a' },
      'win32-arm64':  { file: 'trufflehog_3.96.0_windows_arm64.tar.gz', sha256: 'e8a8a2db3e479c420b6c12b0740e4ff013ebc672b35a730637937b56eb55562e' },
    },
  },
  gitleaks: {
    version: '8.30.1',
    repo: 'gitleaks/gitleaks',
    member: 'gitleaks',
    license: 'MIT',
    assets: {
      'linux-x64':    { file: 'gitleaks_8.30.1_linux_x64.tar.gz',    sha256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' },
      'linux-arm64':  { file: 'gitleaks_8.30.1_linux_arm64.tar.gz',  sha256: 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080' },
      'darwin-x64':   { file: 'gitleaks_8.30.1_darwin_x64.tar.gz',   sha256: 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709' },
      'darwin-arm64': { file: 'gitleaks_8.30.1_darwin_arm64.tar.gz', sha256: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5' },
      'win32-x64':    { file: 'gitleaks_8.30.1_windows_x64.zip',     sha256: 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e' },
    },
  },
};

/** Receipt written next to the binary recording exactly what we installed. */
export interface InstallReceipt {
  name: DetectorName;
  version: string;
  /** sha256 of the release archive we verified. */
  archiveSha256: string;
  /** sha256 of the extracted executable — re-checked before every use. */
  binarySha256: string;
  platform: string;
  installedAt: number;
}

const platformKey = (): string => `${process.platform}-${process.arch}`;
const exeSuffix = (): string => (process.platform === 'win32' ? '.exe' : '');

/** Absolute path the managed binary lives at (whether or not it exists yet). */
export function managedDetectorPath(name: DetectorName): string {
  return join(getDetectorBinDir(), name + exeSuffix());
}

function receiptPath(name: DetectorName): string {
  return join(getDetectorBinDir(), `${name}.receipt.json`);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readReceipt(name: DetectorName): InstallReceipt | null {
  try { return JSON.parse(readFileSync(receiptPath(name), 'utf-8')) as InstallReceipt; }
  catch { return null; }
}

/**
 * Verifying a 34MB binary costs ~50ms. That is fine once per process, and
 * absurd per spawn — so memoize on (path, size, mtime). Any change to the file
 * invalidates the entry and forces a re-hash, which is the property that
 * matters: a swapped binary can never be served from this cache.
 */
const verifiedCache = new Map<string, { size: number; mtimeMs: number; sha: string }>();

function verifiedSha(path: string): string | null {
  let st;
  try { st = statSync(path); } catch { return null; }
  const hit = verifiedCache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sha;
  const sha = sha256File(path);
  verifiedCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, sha });
  return sha;
}

/** Drop the verification memo (tests, and after an install). */
export function _clearDetectorVerifyCache(): void { verifiedCache.clear(); }

export type ResolveFailure =
  | 'not-installed'
  | 'unsupported-platform'
  | 'version-mismatch'
  | 'checksum-mismatch';

export interface ResolvedDetector {
  path: string;
  version: string;
  /** 'managed' = we installed it; 'configured' = operator-supplied directory. */
  source: 'managed' | 'configured';
}

/**
 * Operator escape hatch for containers that bake the binaries into the image:
 * a DIRECTORY of pre-installed detectors. Still absolute-path resolution —
 * this is a different place to look, NOT a return to PATH. Unverified by
 * design (the operator owns those bytes), so it is logged when used.
 */
function configuredDir(): string | null {
  const d = (process.env.CHAT_RECALL_DETECTOR_DIR || '').trim();
  return d || null;
}

/**
 * Resolve a detector to an absolute path, or explain why not.
 *
 * PATH is never consulted. A managed binary is served only when the receipt
 * matches the pinned version AND the bytes on disk still hash to what we
 * installed.
 */
export function resolveDetector(name: DetectorName): ResolvedDetector | { error: ResolveFailure } {
  const dir = configuredDir();
  if (dir) {
    const p = join(dir, name + exeSuffix());
    if (existsSync(p)) return { path: p, version: 'operator-supplied', source: 'configured' };
    return { error: 'not-installed' };
  }

  const spec = DETECTOR_MANIFEST[name];
  if (!spec.assets[platformKey()]) return { error: 'unsupported-platform' };

  const p = managedDetectorPath(name);
  if (!existsSync(p)) return { error: 'not-installed' };

  const receipt = readReceipt(name);
  if (!receipt) return { error: 'not-installed' };
  if (receipt.version !== spec.version) return { error: 'version-mismatch' };

  const sha = verifiedSha(p);
  if (!sha || sha !== receipt.binarySha256) return { error: 'checksum-mismatch' };

  return { path: p, version: receipt.version, source: 'managed' };
}

/** True when the detector is installed, pinned-current and hash-verified. */
export function isDetectorReady(name: DetectorName): boolean {
  return 'path' in resolveDetector(name);
}

export interface InstallResult {
  name: DetectorName;
  version: string;
  path: string;
  /** False when the pinned version was already installed and verified. */
  installed: boolean;
  binarySha256: string;
}

function downloadUrl(spec: DetectorSpec, asset: AssetSpec): string {
  return `https://github.com/${spec.repo}/releases/download/v${spec.version}/${asset.file}`;
}

/**
 * Extract one member from a .tar.gz or .zip using the system `tar`.
 *
 * bsdtar (macOS, and Windows 10 1803+) and GNU tar both read gzip tarballs, and
 * bsdtar also reads zips — which is why the Windows asset being a .zip needs no
 * second code path. `-C` keeps extraction inside the staging dir, and naming the
 * member means a hostile archive cannot write anywhere we did not ask for.
 */
function extractMember(archive: string, member: string, destDir: string): boolean {
  const r = spawnSync('tar', ['-xf', archive, '-C', destDir, member], { encoding: 'utf-8', timeout: 120_000 });
  if (r.status === 0 && existsSync(join(destDir, member))) return true;
  log.error({ status: r.status, stderr: (r.stderr || '').slice(0, 400), archive, member }, 'extract failed');
  return false;
}

/**
 * Download, verify and install a pinned detector into `~/.chat-recall/bin`.
 *
 * Fails closed at every step: a checksum mismatch, a missing member or a failed
 * extraction leaves the previous install (if any) untouched. The final move is
 * a rename within the same directory, so a concurrent resolve either sees the
 * old binary or the new one, never a partial file.
 */
export async function installDetector(
  name: DetectorName,
  opts: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<InstallResult> {
  const spec = DETECTOR_MANIFEST[name];
  const key = platformKey();
  const asset = spec.assets[key];
  if (!asset) {
    throw new Error(`${name} ${spec.version} has no published build for ${key}`);
  }

  if (!opts.force) {
    const existing = resolveDetector(name);
    if ('path' in existing && existing.source === 'managed') {
      return { name, version: existing.version, path: existing.path, installed: false, binarySha256: readReceipt(name)!.binarySha256 };
    }
  }

  const binDir = ensureDetectorBinDir();
  // Staging INSIDE the managed dir, not the system temp dir: it keeps the
  // rename atomic (same filesystem) and means a crashed install cannot leave
  // 34MB somewhere we do not clean.
  const staging = mkdtempSync(join(binDir, '.staging-'));
  try {
    const url = downloadUrl(spec, asset);
    const doFetch = opts.fetchImpl || fetch;
    const res = await doFetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
    const bytes = Buffer.from(await res.arrayBuffer());

    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== asset.sha256) {
      throw new Error(
        `checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${got}. ` +
        `Refusing to install — the release bytes are not the ones this version was pinned to.`,
      );
    }

    const archivePath = join(staging, asset.file);
    writeFileSync(archivePath, bytes);
    if (!extractMember(archivePath, spec.member, staging)) {
      throw new Error(`could not extract "${spec.member}" from ${asset.file} (is \`tar\` available?)`);
    }

    const extracted = join(staging, spec.member);
    chmodSync(extracted, 0o755);
    const binarySha256 = sha256File(extracted);

    const finalPath = managedDetectorPath(name);
    try {
      renameSync(extracted, finalPath);
    } catch {
      // Cross-device (bin dir symlinked elsewhere) — fall back to copy+chmod.
      copyFileSync(extracted, finalPath);
      chmodSync(finalPath, 0o755);
    }

    const receipt: InstallReceipt = {
      name, version: spec.version, archiveSha256: asset.sha256, binarySha256,
      platform: key, installedAt: Date.now(),
    };
    writeFileSync(receiptPath(name), JSON.stringify(receipt, null, 2));
    _clearDetectorVerifyCache();

    log.info({ name, version: spec.version, path: finalPath }, 'detector installed');
    return { name, version: spec.version, path: finalPath, installed: true, binarySha256 };
  } finally {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** Remove a managed detector and its receipt. Never touches anything outside
 *  the managed bin dir. */
export function removeDetector(name: DetectorName): boolean {
  let removed = false;
  for (const p of [managedDetectorPath(name), receiptPath(name)]) {
    try { if (existsSync(p)) { rmSync(p, { force: true }); removed = true; } } catch { /* ignore */ }
  }
  _clearDetectorVerifyCache();
  return removed;
}

export interface DetectorStatus {
  name: DetectorName;
  pinnedVersion: string;
  license: string;
  supported: boolean;
  state: 'ready' | 'configured' | ResolveFailure;
  path: string | null;
}

/** What `chat-recall detectors status` renders. */
export function detectorStatus(): DetectorStatus[] {
  return (Object.keys(DETECTOR_MANIFEST) as DetectorName[]).map((name) => {
    const spec = DETECTOR_MANIFEST[name];
    const r = resolveDetector(name);
    return {
      name,
      pinnedVersion: spec.version,
      license: spec.license,
      supported: !!spec.assets[platformKey()],
      state: 'path' in r ? (r.source === 'managed' ? 'ready' : 'configured') : r.error,
      path: 'path' in r ? r.path : null,
    };
  });
}

/** Ensure the managed bin dir exists (install + status both need it). */
export function ensureDetectorBinDir(): string {
  const d = getDetectorBinDir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o755 });
  return d;
}
