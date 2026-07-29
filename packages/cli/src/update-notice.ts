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

interface UpdateCheck {
  /** Newest version advertised by any server we sync to. */
  serverVersion: string;
  /** When we last asked (epoch ms). */
  checkedAt: number;
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
  if (compareVersions(c.serverVersion, own) <= 0) return null;
  return `chat-recall ${c.serverVersion} is available (you have ${own}). `
    + `Auto-update should apply it; force it now with: chat-recall update`;
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
  if (newest === '0.0.0') return prev;
  const next = { serverVersion: newest, checkedAt: Date.now() };
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
