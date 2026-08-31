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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchWithTimeout } from './http.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
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

/** The higher of two versions, treating an unparseable one as older. */
export function newerOf(a: string, b: string | null): string {
  if (!b) return a;
  if (!a) return b;
  return compareVersions(a, b) >= 0 ? a : b;
}

/**
 * The version currently ON DISK, read fresh every call.
 *
 * Deliberately not cached and deliberately not the module-load constant: the
 * whole point is to notice that an update already landed underneath a
 * long-running process. Returns null when the manifest cannot be read, which
 * leaves the caller's own value in charge rather than inventing one.
 */
export function installedVersion(): string | null {
  try {
    // dist/auto-update.js → dist/../package.json, i.e. the manifest of the
    // package this file was loaded from, whatever npm has since written there.
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf-8');
    return (JSON.parse(raw) as { version?: string }).version || null;
  } catch {
    return null;
  }
}

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
  /** Version actually on disk after the install — the post-condition check. */
  verify?: () => string | null;
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
  // DELETE THE STAGING DIR ON EVERY EXIT PATH. This leaked: the tarball was
  // written and never removed, on success and on both failure returns below.
  // The updater runs on every sync, so on one machine it had left 5,889
  // directories holding 5.1 GB of near-identical tarballs in /tmp. npm has
  // copied what it needs by the time `install` returns, so nothing after this
  // reads `tgz`.
  const dir = mkdtempSync(join(tmpdir(), 'cr-update-'));
  const discardStaging = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  const tgz = join(dir, 'chat-recall.tgz');
  writeFileSync(tgz, buf);
  try { deps.install(tgz); }
  catch (e) { discardStaging(); return { updated: false, reason: `install failed: ${e instanceof Error ? e.message : e}` }; }
  discardStaging();

  // VERIFY THE BYTES ON DISK, because "npm exited 0" is not "the user now runs
  // the new version". This reported `updated 0.5.18 → 0.5.24` on every sync for
  // six releases while the copy on PATH never changed — npm had succeeded into a
  // different prefix (see realInstall). An unverified success is the worst
  // possible outcome: it silences the update notice too, so nothing ever
  // complains again.
  //
  // `verify` is injectable so a test can drive both outcomes; the default reads
  // the manifest of the package THIS file was loaded from.
  const landed = (deps.verify ?? installedVersion)();
  if (landed && plan.to && compareVersions(landed, plan.to) < 0) {
    return {
      updated: false,
      reason: `install reported success but ${landed} is still on disk (wanted ${plan.to}) — `
        + 'the package that runs is not the one npm wrote. Reinstall by hand: '
        + `npm install -g ${plan.url}`,
    };
  }

  try { deps.restart(deps.platform ?? process.platform); } catch { /* daemon will pick up new bin on its next natural restart */ }
  return { updated: true, reason: `updated ${plan.from} → ${plan.to}`, from: plan.from, to: plan.to };
}

/* ── real side effects (defaults) ─────────────────────────────────── */

async function realDownload(url: string): Promise<Buffer> {
  const res = await fetchWithTimeout(url, {}, 120_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
/**
 * The npm prefix the RUNNING copy was installed into.
 *
 * `<prefix>/lib/node_modules/chat-recall/dist/auto-update.js` → `<prefix>`.
 * Returns null when this file is not inside a node_modules tree (a source
 * checkout, a bundled binary), where there is nothing to reinstall over.
 */
export function runningPrefix(moduleUrl = import.meta.url): string | null {
  const here = fileURLToPath(moduleUrl);
  const marker = `${sep}node_modules${sep}`;
  const at = here.lastIndexOf(marker);
  if (at === -1) return null;
  // <prefix>/lib/node_modules/... → strip the trailing `/lib` too, because that
  // is what `npm --prefix` expects.
  const beforeNodeModules = here.slice(0, at);
  return beforeNodeModules.endsWith(`${sep}lib`)
    ? beforeNodeModules.slice(0, -4)
    : beforeNodeModules;
}

/**
 * Install the new tarball OVER THE COPY THAT IS RUNNING.
 *
 * ── The silent no-op this fixes ───────────────────────────────────────────
 * This was `npm install -g`, with a `--prefix ~/.local` fallback only if that
 * THREW. On a machine with nvm, plain `npm install -g` succeeds — into nvm's
 * prefix — so the fallback never ran, and a CLI living in `~/.local` (which is
 * where install.sh puts it whenever the global prefix is not writable, i.e.
 * exactly the population the fallback exists for) was never replaced. Measured
 * on a real machine:
 *
 *   ~/.nvm/versions/node/v23.9.0/lib/node_modules/chat-recall  0.5.24  (not on PATH)
 *   ~/.local/lib/node_modules/chat-recall                      0.5.18  (on PATH)
 *
 * The updater reported `✓ updated 0.5.18 → 0.5.24` truthfully — it HAD installed
 * 0.5.24 — while every command kept running 0.5.18, and it did so again on every
 * sync, for every release. A self-updater that installs somewhere the user never
 * runs is worse than none: it reports success forever.
 *
 * So target the prefix this file was loaded from, and fall back to npm's own
 * global only when that cannot be determined.
 */
function realInstall(tgz: string): void {
  const prefix = runningPrefix();
  if (prefix) {
    execSync(`npm install -g --prefix "${prefix}" "${tgz}"`, { stdio: 'ignore' });
    return;
  }
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

  // THE VERSION ON DISK WINS, and this is not a refinement — it is the fix for a
  // permanent reinstall loop.
  //
  // Callers pass a version captured when their MODULE was imported. A process
  // that has been alive since before an update therefore reports the old number
  // forever, while the package it was launched from has already been replaced.
  // So it asks the server, sees "newer available", installs a version that is
  // ALREADY INSTALLED, and restarts the watch service — then does it again on
  // the next tick, and the next, because nothing about the running process ever
  // changes. Observed in the field: seven long-lived MCP servers reinstalling the
  // CLI and bouncing the daemon every 2-3 seconds, indefinitely.
  //
  // Re-reading the manifest at DECISION time closes it: once the bytes on disk
  // satisfy the server, the answer is "already current" no matter how stale the
  // process asking is. The stale process keeps running old code until it is
  // restarted, which is correct and harmless — what must not happen is it
  // thrashing the machine trying to fix itself.
  const effectiveOwn = newerOf(ownVersion, installedVersion());

  const plan = planAutoUpdate(base, caps, effectiveOwn, process.env.CHAT_RECALL_AUTO_UPDATE);
  if (!plan.update) return { updated: false, reason: plan.reason };
  const result = await executeAutoUpdate(plan, {
    download: deps?.download ?? realDownload,
    install: deps?.install ?? realInstall,
    restart: deps?.restart ?? realRestart,
    platform: deps?.platform,
  });

  // A self-update that KEEPS failing is the worst failure mode this system has:
  // the machine silently runs an old collector forever, and the only trace was a
  // reason string that two of the three call sites threw away
  // (`void runAutoUpdate(…).catch(() => {})`). Report it so the failure is
  // visible server-side instead of being discovered months later by hand.
  // Dynamic import: client-events → sync-client → auto-update is a cycle at
  // module scope, and telemetry must never be load-order-sensitive.
  if (!result.updated) {
    try {
      const { reportClientEvent } = await import('./client-events.js');
      reportClientEvent('auto_update_failed', { message: `${plan.from} → ${plan.to}: ${result.reason}` });
    } catch { /* telemetry is best-effort */ }
  }
  return result;
}
