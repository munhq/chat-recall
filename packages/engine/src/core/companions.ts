/**
 * Companion-tools manager for chat-recall.
 *
 * Right now there is exactly one companion: `codeindex` — a separate MCP server
 * (Zig binary) that provides code-level lookup (find_symbol, find_callers,
 * plan_change, get_change_impact, etc.). Chat-recall remembers what you've done
 * across sessions; codeindex understands what's currently in your code. Together
 * they prevent the agent from blindly recreating code that already exists.
 *
 * The chat-recall web UI is detect-only: it finds an existing `codeindex` on
 * PATH (or at `~/.local/bin/codeindex`) and registers it as an MCP server. Auto
 * download is opt-in via the CLI's `--with-codeindex` flag and only succeeds
 * when the codeindex release is reachable for the user (release artifacts may
 * live in a private repo at any given time — the CLI surfaces 404s honestly
 * instead of pretending the install succeeded).
 *
 * Failure mode is **non-fatal**: if codeindex can't be installed (no prebuilt
 * for this OS/arch, network down, repo private, etc.), we report it clearly
 * but do NOT block chat-recall itself. Codeindex is a companion, not a dep.
 */
import { existsSync, mkdirSync, statSync, chmodSync, unlinkSync, renameSync, createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveOnPath, isOnPath } from './which.js';

const CODEINDEX_REPO = 'munhq/codeindex';
const CODEINDEX_VERSION = 'v0.2.0';

/**
 * sha256 of every published asset, pinned here rather than fetched.
 *
 * WHY PINNED AND NOT FETCHED. This downloads a ~53 MB executable and makes it
 * runnable on a developer's machine. A checksum served from the same host as
 * the binary proves nothing — whoever can swap one can swap the other. These
 * were computed from the real assets and recorded in source, so they are
 * verified once at review time and then again on every install, and a mirror,
 * a proxy or a re-uploaded release serving different bytes gets refused.
 *
 * detector-install.ts already worked this way for gitleaks and trufflehog;
 * codeindex was the one binary we fetched and executed unverified.
 *
 * WHEN BUMPING CODEINDEX_VERSION: download each asset, `sha256sum` it, and
 * replace these. A stale hash fails closed — an install error, never a silent
 * downgrade to unverified.
 *
 * Keyed by `${arch}-${platform}` exactly as detectPlatform() builds it.
 */
const CODEINDEX_SHA256: Record<string, string> = {
  'x86_64-linux': 'b43a1de6e7b838ed769c0ee41a5ba3b8ab5c5afbcac8a1d63ccee3a55cbd3739',
  'aarch64-linux': '3bfe847b4874be6a704c75fc041fe0fd719432df05621159dd7d4e7fabe82759',
  'x86_64-macos': 'bf0b20f18f4b3af009415f72d6ef0272452a9a4b3d47fc159d68fcf71deb1c02',
  'aarch64-macos': '39a4c9fd204fcca02c46eb628acadd77e80fb59769a8361d5e1279f7493684bd',
};

/** The expected digest for an artifact name, or null when we have none. */
export function expectedCodeindexSha256(artifact: string): string | null {
  // `codeindex-x86_64-linux` -> `x86_64-linux`
  return CODEINDEX_SHA256[artifact.replace(/^codeindex-/, '')] ?? null;
}

/** Where we install the binary. Aligns with codeindex's own install.sh. */
export const CODEINDEX_INSTALL_DIR = join(homedir(), '.local', 'bin');
/**
 * Executability on Windows is the FILE EXTENSION, not a mode bit — spawn() of
 * an extensionless path is ENOENT there. detector-install.ts already does this
 * (exeSuffix); this file did not, so a Windows codeindex could never be
 * resolved even once a build exists. There is no Windows build today (the
 * cross-compile fails on POSIX signal and stdin APIs in codeindex itself), so
 * this is groundwork rather than a live fix — but it is the half that belongs
 * in this repo, and leaving it wrong guarantees a second bug report later.
 */
export const CODEINDEX_BIN_NAME = process.platform === 'win32' ? 'codeindex.exe' : 'codeindex';
export const CODEINDEX_BIN_PATH = join(CODEINDEX_INSTALL_DIR, CODEINDEX_BIN_NAME);

export interface CodeindexStatus {
  installed: boolean;
  path?: string;
  version?: string;
  size?: number;
  /** Could `chat-recall init` install it on this platform? */
  prebuiltAvailable: boolean;
  /** Platform suffix the GH release uses (e.g. "x86_64-linux"). */
  artifactName?: string;
  /** Why the install can't proceed automatically, if applicable. */
  unsupportedReason?: string;
}

/**
 * Map Node's `process.arch`/`platform` to the artifact suffix used by
 * codeindex's release pipeline (`codeindex-${arch}-${os}`).
 *
 * As of codeindex v0.1.0, only x86_64-linux ships prebuilt — Mac/arm64/Windows
 * users need to build from source via Zig. We surface this honestly rather
 * than failing with a confusing 404.
 */
export function detectPlatform(): { artifact?: string; reason?: string } {
  const arch = process.arch;
  const platform = process.platform;
  const archMap: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' };
  // 'macos', not 'darwin' — that is what the release artifacts are called.
  // The old value built the name codeindex-aarch64-darwin, which does not
  // exist, so even a widened prebuilt list would have 404'd on every Mac.
  const platformMap: Record<string, string> = { linux: 'linux', darwin: 'macos', win32: 'windows' };
  const a = archMap[arch];
  const p = platformMap[platform];
  if (!a || !p) {
    return { reason: `Unsupported platform: ${arch}-${platform}` };
  }
  // What v0.2.0 actually publishes. This said x86_64-linux only, pinned to a
  // comment about v0.1.0, long after the release matrix grew — so every Mac,
  // Intel and Apple Silicon alike, was told to install Zig and build from
  // source, and got NO code intelligence at all: no findings, no hotspots, no
  // actions, no security scan. On the largest developer platform this product
  // has. Keep this in step with .github/workflows/release.yml in munhq/codeindex.
  const prebuiltCombos = new Set([
    'x86_64-linux', 'aarch64-linux', 'x86_64-macos', 'aarch64-macos',
  ]);
  const artifact = `codeindex-${a}-${p}`;
  if (!prebuiltCombos.has(`${a}-${p}`)) {
    return {
      artifact,
      reason: `No prebuilt binary for ${a}-${p}. Install Zig and build from source: https://github.com/${CODEINDEX_REPO}`,
    };
  }
  return { artifact };
}

export function checkCodeindexStatus(): CodeindexStatus {
  const platform = detectPlatform();
  const status: CodeindexStatus = {
    installed: false,
    prebuiltAvailable: !!platform.artifact && !platform.reason,
    artifactName: platform.artifact,
    unsupportedReason: platform.reason,
  };
  // Look in $PATH first, then in our default install dir.
  // resolveOnPath, not `command -v`: that is not a Windows command, so the
  // probe threw and every Windows user was told codeindex was not installed.
  let foundPath: string | null = resolveOnPath(CODEINDEX_BIN_NAME);
  if (!foundPath) {
    // Our own install dir, trying the platform's executable suffixes.
    foundPath = resolveOnPath(CODEINDEX_BIN_PATH);
  }

  if (foundPath) {
    status.installed = true;
    status.path = foundPath;
    try { status.size = statSync(foundPath).size; } catch {}
    try {
      // codeindex --version prints a single line; tolerate the binary not
      // implementing the flag yet (older builds).
      const out = execSync(`"${foundPath}" --version`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
      status.version = out.slice(0, 60);
    } catch { /* version detection optional */ }
  }
  return status;
}

/**
 * Download a release artifact to disk. Uses `gh` if available (handles auth +
 * retries cleanly); falls back to plain HTTPS (which works because the release
 * is public) when `gh` is missing.
 */
async function downloadArtifact(artifact: string, dest: string): Promise<void> {
  // Prefer gh because it gives consistent UX, retries, and rate-limit handling.
  const hasGh = isOnPath('gh');

  if (hasGh) {
    // dest is quoted: it sits under the user's home, and "C:\\Users\\First Last"
    // or "/Users/First Last" would otherwise split into two arguments.
    execSync(`gh release download ${CODEINDEX_VERSION} --repo ${CODEINDEX_REPO} -p ${artifact} -O "${dest}"`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return;
  }

  // Plain HTTPS fallback.
  const url = `https://github.com/${CODEINDEX_REPO}/releases/download/${CODEINDEX_VERSION}/${artifact}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error('Download returned empty body');
  const file = createWriteStream(dest);
  await new Promise<void>((resolve, reject) => {
    const reader = res.body!.getReader();
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          file.write(value);
        }
        file.end();
        file.on('finish', () => resolve());
        file.on('error', reject);
      } catch (e) { reject(e); }
    };
    pump();
  });
}

/**
 * Install codeindex if not already present. Returns the resulting status —
 * caller decides how to surface to the user.
 */
export async function installCodeindex(opts: { force?: boolean } = {}): Promise<CodeindexStatus> {
  const status = checkCodeindexStatus();
  if (status.installed && !opts.force) return status;
  if (!status.prebuiltAvailable) return status;

  mkdirSync(CODEINDEX_INSTALL_DIR, { recursive: true });
  const tmpPath = `${CODEINDEX_BIN_PATH}.partial`;
  try {
    await downloadArtifact(status.artifactName!, tmpPath);

    // VERIFY BEFORE IT CAN RUN. The order matters: hash first, chmod second,
    // rename last, so bytes we have not vouched for are never executable and
    // never occupy the real path.
    //
    // Only DOWNLOADS are checked. A binary already on PATH, or one the user
    // built from source, is theirs — we did not fetch it and it is not ours to
    // second-guess. Refusing those would break every contributor running a
    // local build.
    const expected = expectedCodeindexSha256(status.artifactName!);
    if (!expected) {
      throw new Error(
        `No pinned checksum for ${status.artifactName} — refusing to install an unverified binary. `
        + `Add its sha256 to CODEINDEX_SHA256 in companions.ts.`,
      );
    }
    const actual = createHash('sha256').update(readFileSync(tmpPath)).digest('hex');
    if (actual !== expected) {
      throw new Error(
        `Checksum mismatch for ${status.artifactName}.\n`
        + `  expected ${expected}\n  actual   ${actual}\n`
        + `Refusing to install. The release may have been re-uploaded, or something is serving different bytes.`,
      );
    }

    chmodSync(tmpPath, 0o755);
    // Atomic rename so a crashed download never leaves a half-baked binary.
    // Synchronous — must complete before checkCodeindexStatus() runs.
    renameSync(tmpPath, CODEINDEX_BIN_PATH);
  } catch (err) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    throw err;
  }
  return checkCodeindexStatus();
}

/** Remove the codeindex binary we installed (does not touch any other path). */
export function uninstallCodeindex(): { removed: boolean; path: string } {
  if (existsSync(CODEINDEX_BIN_PATH)) {
    unlinkSync(CODEINDEX_BIN_PATH);
    return { removed: true, path: CODEINDEX_BIN_PATH };
  }
  return { removed: false, path: CODEINDEX_BIN_PATH };
}

/**
 * Add (or remove) a codeindex MCP server entry in ~/.mcp.json so Claude Code
 * picks it up. Mirrors what codeindex's install.sh does, but routes through
 * the same JSON file we already manage for chat-recall.
 */
export function registerCodeindexMcp(mcpJsonPath: string, binaryPath: string): { added: boolean } {
  let cfg: Record<string, any> = {};
  if (existsSync(mcpJsonPath)) {
    try { cfg = JSON.parse(readFileSync(mcpJsonPath, 'utf-8')); } catch { cfg = {}; }
  }
  cfg.mcpServers = cfg.mcpServers || {};
  if (cfg.mcpServers['codeindex']) return { added: false };
  cfg.mcpServers['codeindex'] = { command: binaryPath, args: ['--mcp'] };
  writeFileSync(mcpJsonPath, JSON.stringify(cfg, null, 2));
  return { added: true };
}

export function unregisterCodeindexMcp(mcpJsonPath: string): { removed: boolean } {
  if (!existsSync(mcpJsonPath)) return { removed: false };
  let cfg: Record<string, any>;
  try { cfg = JSON.parse(readFileSync(mcpJsonPath, 'utf-8')); } catch { return { removed: false }; }
  if (!cfg.mcpServers?.['codeindex']) return { removed: false };
  delete cfg.mcpServers['codeindex'];
  writeFileSync(mcpJsonPath, JSON.stringify(cfg, null, 2));
  return { removed: true };
}
