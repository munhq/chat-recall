/**
 * "You are running an old CLI" — the last-resort channel.
 *
 * Auto-update (auto-update.ts) handles the normal case, but it can only help a
 * client that already HAS it: anything older simply never asks, and a machine
 * whose `npm i -g` fails retries silently forever. Both cases end the same way —
 * a box quietly runs a months-old collector and nobody finds out until someone
 * notices missing data by hand.
 *
 * So: every CLI invocation prints ONE stderr line when the server it syncs to
 * advertises a newer release. Reading a cached probe keeps that free — the
 * actual capabilities call runs at most every 6h, detached, and never blocks or
 * fails a command.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@chat-recall/engine/core/paths.js';
import { compareVersions } from './auto-update.js';
import { fetchWithTimeout, cliVersion } from './http.js';

const CHECK_TTL_MS = 6 * 3600 * 1000;

/** The public registry, asked only for `dist-tags.latest`. */
const NPM_LATEST_URL = 'https://registry.npmjs.org/chat-recall';

export interface UpdateCheck {
  /** Newest version advertised by any server we sync to. */
  serverVersion: string;
  /**
   * Newest version on the public npm registry, when it could be reached.
   *
   * The server was the ONLY source, and it cannot be: `cli.version` comes from
   * `/app/install/cli-version.txt`, a file stamped into the server's Docker
   * image and cached for the life of the process. So the advertised version is
   * whatever was current when that IMAGE was built, and it stays that way until
   * the image is rebuilt and rolled. A release published to npm is invisible
   * until then — 0.5.32 was live on the registry while every CLI on earth was
   * still being told "0.5.31 is available", which is the one thing this file
   * exists to get right.
   *
   * Optional: absent on a cache written by an older CLI, and absent whenever
   * the registry cannot be reached, which is the normal state of an air-gapped
   * install and must degrade to exactly the old behaviour.
   */
  npmVersion?: string;
  /** When we last asked (epoch ms). */
  checkedAt: number;
}

/** The newest version known from any source, and where it can be had. */
export function newestKnown(c: UpdateCheck): { version: string; source: 'server' | 'npm' } {
  const npm = c.npmVersion ?? '0.0.0';
  return compareVersions(npm, c.serverVersion) > 0
    ? { version: npm, source: 'npm' }
    : { version: c.serverVersion, source: 'server' };
}

const checkPath = () => join(getDataDir(), 'update-check.json');

function readCheck(): UpdateCheck | null {
  try {
    const c = JSON.parse(readFileSync(checkPath(), 'utf-8')) as UpdateCheck;
    return c && typeof c.serverVersion === 'string' ? c : null;
  } catch { return null; }
}

function writeCheck(c: UpdateCheck): void {
  try { writeFileSync(checkPath(), JSON.stringify(c)); } catch { /* cache is a nicety */ }
}

/**
 * The pending-update line, or null when current/unknown. Pure read of the
 * cached probe — no I/O beyond one small file, safe on every command.
 */
export function updateNotice(): string | null {
  const c = readCheck();
  if (!c) return null;
  const own = cliVersion();
  const { version, source } = newestKnown(c);
  if (compareVersions(version, own) <= 0) return null;

  // Name the command that can ACTUALLY deliver this version. When npm is ahead
  // of the server, `chat-recall update` is same-origin and checksum-pinned
  // against the server's own tarball — it cannot install what the server does
  // not yet serve, so pointing at it would send the user in a circle.
  const how = source === 'npm'
    ? 'The server you sync to has not rolled it yet — install it with: npm install -g chat-recall@latest'
    : 'Auto-update should apply it; force it now with: chat-recall update';
  return `chat-recall ${version} is available (you have ${own}). ${how}`;
}

/** Newest version on npm, or null. Best-effort and always silent. */
async function fetchNpmLatest(): Promise<string | null> {
  // An air-gapped or offline install must behave exactly as it did before this
  // source existed, so every failure here is a null, never a throw.
  if (process.env.CHAT_RECALL_NO_NPM_CHECK === '1') return null;
  try {
    const res = await fetchWithTimeout(NPM_LATEST_URL, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    }, 5_000);
    if (!res.ok) return null;
    const body = (await res.json()) as { 'dist-tags'?: { latest?: string } };
    const v = body['dist-tags']?.latest;
    return typeof v === 'string' && v ? v : null;
  } catch { return null; }
}

/** Ask each logged-in server what it serves, and cache the newest. Best-effort. */
export async function refreshUpdateCheck(force = false): Promise<UpdateCheck | null> {
  const prev = readCheck();
  if (!force && prev && Date.now() - prev.checkedAt < CHECK_TTL_MS) return prev;
  let newest = '0.0.0';
  try {
    const { loadAllCredentials } = await import('./sync-client.js');
    for (const cred of loadAllCredentials()) {
      if (!cred.serverUrl) continue;
      const base = cred.serverUrl.replace(/\/+$/, '');
      try {
        const res = await fetchWithTimeout(`${base}/api/capabilities`, {
          headers: cred.token ? { authorization: `Bearer ${cred.token}` } : {},
        }, 5_000);
        if (!res.ok) continue;
        const caps = (await res.json()) as { cli?: { version?: string } | null };
        const v = caps?.cli?.version;
        if (v && compareVersions(v, newest) > 0) newest = v;
      } catch { /* one unreachable server must not poison the check */ }
    }
  } catch { return prev; }
  const npmVersion = await fetchNpmLatest();

  // Both sources unreachable → keep the previous answer rather than writing a
  // fresh cache that says "nothing is available".
  if (newest === '0.0.0' && !npmVersion) return prev;

  const next: UpdateCheck = {
    // A server that answered nothing must not erase what we last knew from one.
    serverVersion: newest !== '0.0.0' ? newest : (prev?.serverVersion ?? '0.0.0'),
    checkedAt: Date.now(),
  };
  if (npmVersion) next.npmVersion = npmVersion;
  writeCheck(next);
  return next;
}

/**
 * Print the notice (once per process) and kick a detached refresh.
 *
 * stderr, never stdout: piping `chat-recall search … | jq` must keep working.
 * The refresh is unref'd so it can never hold a short command open.
 */
let printed = false;
export function printUpdateNotice(): void {
  if (printed) return;
  printed = true;
  try {
    const msg = updateNotice();
    if (msg) console.error(`\n  ⚠  ${msg}\n`);
    const t = setTimeout(() => { void refreshUpdateCheck().catch(() => {}); }, 0);
    if (typeof t.unref === 'function') t.unref();
  } catch { /* a nudge must never break a command */ }
}
