/**
 * Refuse to ship a transcript over a connection anyone can read.
 *
 * ── The hole this closes ─────────────────────────────────────────────────
 * TLS to the hosted service was never in doubt — valid cert, HSTS for a year,
 * plain HTTP redirected. But NOTHING in the collector required it. A user who
 * typed `chat-recall login http://recall.mycompany.com` got exactly what they
 * asked for: every transcript on the machine, in cleartext, over the open
 * internet, with no warning at any point. `isLocalHost()` existed to relax
 * upload pacing for LAN targets, not to gate the scheme, so a public host over
 * plain HTTP passed every check.
 *
 * The payload makes this worse than a generic cleartext warning deserves. A sync
 * body carries whole transcripts: source code, file paths, and — despite
 * client-side redaction being good — whatever the detectors did not recognise as
 * a secret. This is the single highest-value thing the product ever puts on a
 * wire.
 *
 * ── Where the line is ────────────────────────────────────────────────────
 * Plain HTTP is fine to a host only YOU can reach, and that is the whole
 * exception. Loopback, mDNS/`.lan` names, RFC1918, IPv6 loopback and ULA, and
 * the CGNAT range Tailscale hands out — a self-hoster on any of those has no
 * public path to intercept. Everything else needs TLS.
 *
 * `CHAT_RECALL_ALLOW_INSECURE_HTTP=1` overrides it, for the real case this
 * would otherwise break: a corporate host reached through a VPN whose name and
 * address both look public. That is a deliberate, per-machine decision, which is
 * exactly the bar an override like this should meet.
 */

/** Hosts only reachable from the user's own machine or network. */
export function isPrivateHost(serverUrl: string): boolean {
  let host = '';
  try { host = new URL(serverUrl).hostname.toLowerCase(); } catch { return false; }
  // IPv6 arrives bracket-stripped from URL.hostname.
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) return true;
  if (/^10\./.test(host)) return true;                              // 10.0.0.0/8
  if (/^192\.168\./.test(host)) return true;                        // 192.168.0.0/16
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;         // 172.16.0.0/12
  if (/^127\./.test(host)) return true;                             // loopback/8
  // 100.64.0.0/10 — CGNAT, and what Tailscale assigns. A self-hoster reaching
  // their box over a tailnet is on a private path by construction.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;                 // IPv6 ULA fc00::/7
  if (/^fe80:/.test(host)) return true;                             // IPv6 link-local
  return false;
}

/** Explicit, per-machine opt-out for a VPN-reached host that looks public. */
export function insecureHttpAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CHAT_RECALL_ALLOW_INSECURE_HTTP || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Why this target must not be used, or null when it is safe.
 *
 * Pure, so both the login gate and the sync-time gate can share one rule and a
 * test can pin it without a network.
 */
export function transportRisk(
  serverUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let url: URL;
  try { url = new URL(serverUrl); } catch { return `not a valid server URL: ${serverUrl}`; }
  if (url.protocol === 'https:') return null;
  if (url.protocol !== 'http:') return `unsupported scheme '${url.protocol}' — use https://`;
  if (isPrivateHost(serverUrl)) return null;          // your own network
  if (insecureHttpAllowed(env)) return null;          // deliberate override
  return `refusing to sync to ${url.host} over plain HTTP — your transcripts, `
    + 'file paths and any secret the redactor did not catch would cross the '
    + `internet in cleartext. Use https://${url.host} instead. If this host is `
    + 'only reachable through a VPN, set CHAT_RECALL_ALLOW_INSECURE_HTTP=1.';
}

/** Throwing form, for the login path. */
export function assertTransportSafe(serverUrl: string, env: NodeJS.ProcessEnv = process.env): void {
  const risk = transportRisk(serverUrl, env);
  if (risk) throw new Error(risk);
}
