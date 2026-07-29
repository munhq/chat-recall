/**
 * fetch() with a hard timeout.
 *
 * Node's global `fetch` (undici) has NO caller-facing default timeout — a
 * connected-but-silent peer (half-open TCP, a hung reverse proxy, a wedged
 * server) makes the promise hang for undici's internal ~300s, or effectively
 * forever from the caller's view. The collector's upload path already guards
 * against this with an AbortController; every OTHER request the daemon makes
 * (capabilities handshake, tenant-config pulls, intent drain, code-index push,
 * auto-update checks) must too — otherwise ONE stalled endpoint wedges the whole
 * serialized sync tick. This is the single helper they all use.
 */
import { readFileSync } from 'node:fs';

// Injected by the bundler (scripts/bundle.mjs); falls back to package.json for
// tsx/dev runs.
declare const __CLI_VERSION__: string;
let CLI_VERSION = '0.0.0';
try {
  CLI_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: string }).version || CLI_VERSION;
} catch {
  try { if (typeof __CLI_VERSION__ === 'string') CLI_VERSION = __CLI_VERSION__; } catch { /* keep default */ }
}

/** This CLI's own version — the one the server compares against. */
export function cliVersion(): string { return CLI_VERSION; }

/**
 * Identity headers on every request this CLI makes to its server.
 *
 * The server stamps them onto the device row (see the auth middleware's device
 * heartbeat), which is what makes "this machine last synced 6 days ago and runs
 * 0.3.1" answerable at all. Before this the server knew a device token existed
 * and nothing else — so a machine on a CLI too old to self-update stayed stale
 * indefinitely and no UI could say so. Two short, non-identifying values.
 */
export function clientHeaders(): Record<string, string> {
  return {
    'x-chat-recall-cli': CLI_VERSION,
    'x-chat-recall-os': `${process.platform}-${process.arch}`,
  };
}

export function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  ms = 15_000,
): Promise<Response> {
  // Headers first so an explicit caller value always wins.
  const headers = new Headers(clientHeaders());
  new Headers(init.headers ?? {}).forEach((v, k) => headers.set(k, v));
  // Respect an explicit caller signal if given; otherwise arm a timeout.
  return fetch(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(ms) });
}
