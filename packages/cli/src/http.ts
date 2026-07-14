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
export function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  ms = 15_000,
): Promise<Response> {
  // Respect an explicit caller signal if given; otherwise arm a timeout.
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(ms) });
}
