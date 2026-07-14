/**
 * CLI self-update from the logged-in server.
 *
 * The watch daemon calls runAutoUpdate() on a cadence: it asks /api/capabilities
 * for the server's packed CLI version + tarball sha256, and if the server is
 * newer AND auto-update is enabled, downloads the tarball FROM THE SAME ORIGIN,
 * verifies the checksum, `npm i -g`s it, and restarts the watch service.
 *
 * Safety:
 *   - same-origin only (URL derived from the credential base, never caps input)
 *   - checksum-pinned (install only if sha256 matches the advertised value)
 *   - default ON for every edition; opt OUT with CHAT_RECALL_AUTO_UPDATE=0
 *
 * The decision + checksum logic is pure; the side effects (download/install/
 * restart) are injected so they can be validated without a real global install.
 */
import { execSync } from 'node:child_process';
import { fetchWithTimeout } from './http.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

export interface CliRelease { version: string; sha256: string; }
export interface Caps { edition?: string; cli?: CliRelease | null; }

/** semver-ish compare: -1 (a<b), 0 (a==b), 1 (a>b). Ignores prerelease tags. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Enabled = explicit flag wins; else default ON for EVERY edition.
 *
 * Cloud used to default OFF, which — with nothing at install/init ever turning
 * it on — meant SaaS customers silently ran a stale, buggy collector forever
 * and never received fixes. That's a dead end, not a security posture. The
 * update is same-origin only and sha256-pinned to what the server advertises,
 * so default-on just means "trust the server you're already syncing to." Set
 * CHAT_RECALL_AUTO_UPDATE=0 to opt out.
 */
export function isAutoUpdateEnabled(_edition: string | undefined, flag: string | undefined): boolean {
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  if (flag === '1' || flag === 'true' || flag === 'on') return true;
  return true;
}

export const tarballUrl = (base: string) => `${base.replace(/\/+$/, '')}/install/chat-recall.tgz`;

export interface UpdatePlan {
  update: boolean;
  reason: string;
  url?: string;
  sha256?: string;
  from?: string;
  to?: string;
}

/** Pure: decide whether to update, and to what — no I/O. */
export function planAutoUpdate(base: string, caps: Caps, ownVersion: string, flag: string | undefined): UpdatePlan {
  const rel = caps.cli;
  if (!rel || !rel.version || !rel.sha256) return { update: false, reason: 'server advertises no CLI release' };
  if (!isAutoUpdateEnabled(caps.edition, flag)) return { update: false, reason: `auto-update disabled (edition ${caps.edition ?? '?'})` };
  if (compareVersions(rel.version, ownVersion) <= 0) return { update: false, reason: `already current (own ${ownVersion} >= server ${rel.version})` };
  return { update: true, reason: `server ${rel.version} > own ${ownVersion}`, url: tarballUrl(base), sha256: rel.sha256, from: ownVersion, to: rel.version };
}

export interface UpdateDeps {
  download: (url: string) => Promise<Buffer>;
  install: (tgzPath: string) => void;
  restart: (platform: NodeJS.Platform) => void;
  platform?: NodeJS.Platform;
}

export interface UpdateResult { updated: boolean; reason: string; from?: string; to?: string; }

/** Execute a plan: download → checksum-verify → install → restart. */
export async function executeAutoUpdate(plan: UpdatePlan, deps: UpdateDeps): Promise<UpdateResult> {
  if (!plan.update || !plan.url || !plan.sha256) return { updated: false, reason: plan.reason };
  let buf: Buffer;
  try { buf = await deps.download(plan.url); }
  catch (e) { return { updated: false, reason: `download failed: ${e instanceof Error ? e.message : e}` }; }
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== plan.sha256) return { updated: false, reason: `checksum mismatch (expected ${plan.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…) — NOT installing` };
  const dir = mkdtempSync(join(tmpdir(), 'cr-update-'));
  const tgz = join(dir, 'chat-recall.tgz');
  writeFileSync(tgz, buf);
  try { deps.install(tgz); }
  catch (e) { return { updated: false, reason: `install failed: ${e instanceof Error ? e.message : e}` }; }
  try { deps.restart(deps.platform ?? process.platform); } catch { /* daemon will pick up new bin on its next natural restart */ }
  return { updated: true, reason: `updated ${plan.from} → ${plan.to}`, from: plan.from, to: plan.to };
}

/* ── real side effects (defaults) ─────────────────────────────────── */

async function realDownload(url: string): Promise<Buffer> {
  const res = await fetchWithTimeout(url, {}, 120_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
function realInstall(tgz: string): void {
  // Prefer a global install; fall back to a user prefix when global isn't
  // writable (same policy as install.sh).
  try { execSync(`npm install -g "${tgz}"`, { stdio: 'ignore' }); }
  catch { execSync(`npm install -g --prefix "${process.env.HOME}/.local" "${tgz}"`, { stdio: 'ignore' }); }
}
function realRestart(platform: NodeJS.Platform): void {
  if (platform === 'linux') execSync('systemctl --user restart chat-recall-watch.service', { stdio: 'ignore' });
  else if (platform === 'darwin') execSync('launchctl kickstart -k gui/$(id -u)/com.chat-recall.watch', { stdio: 'ignore', shell: '/bin/bash' });
  else if (platform === 'win32') execSync('schtasks /End /TN chat-recall-watch & schtasks /Run /TN chat-recall-watch', { stdio: 'ignore' });
}

/**
 * Full flow for one logged-in server. Best-effort — any failure returns a
 * reason and never throws into the daemon loop.
 */
export async function runAutoUpdate(
  base: string,
  authHeaders: Record<string, string>,
  ownVersion: string,
  deps?: Partial<UpdateDeps>,
): Promise<UpdateResult> {
  let caps: Caps;
  try {
    const res = await fetchWithTimeout(`${base.replace(/\/+$/, '')}/api/capabilities`, { headers: authHeaders });
    if (!res.ok) return { updated: false, reason: `capabilities HTTP ${res.status}` };
    caps = (await res.json()) as Caps;
  } catch (e) { return { updated: false, reason: `capabilities unreachable: ${e instanceof Error ? e.message : e}` }; }

  const plan = planAutoUpdate(base, caps, ownVersion, process.env.CHAT_RECALL_AUTO_UPDATE);
  if (!plan.update) return { updated: false, reason: plan.reason };
  return executeAutoUpdate(plan, {
    download: deps?.download ?? realDownload,
    install: deps?.install ?? realInstall,
    restart: deps?.restart ?? realRestart,
    platform: deps?.platform,
  });
}
