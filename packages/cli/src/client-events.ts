/**
 * Client failure/health reporting.
 *
 * Fire-and-forget POST of a REDACTED event to the logged-in server(s) so the
 * operator sees when recall breaks — instead of finding out because a customer
 * complains. On by default (this is a paid product; you need to know when it's
 * broken); opt OUT with CHAT_RECALL_TELEMETRY=0. Never throws, short timeout —
 * telemetry must never affect the thing it's observing.
 *
 * What's sent: error kind, a redacted+trimmed message, the tool, CLI version,
 * OS. NO transcript content; secrets scrubbed via the redactor; home paths
 * collapsed to ~. Sent to the SAME server(s) the collector already syncs to
 * (SaaS → visible to the operator; self-host → stays on their box).
 */
import { readFileSync } from 'node:fs';
import { loadAllCredentials } from './sync-client.js';
import { redactSecrets } from '@chat-recall/engine/core/secret-redactor.js';

let CLI_VERSION = '0.0.0';
try {
  CLI_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: string }).version || CLI_VERSION;
} catch { /* keep default */ }

function scrub(msg: string): string {
  if (!msg) return '';
  // Collapse home paths so we don't leak usernames / dir structure, then run
  // the secret redactor (force: catches tokens/keys even outside "= value").
  const noHome = msg.replace(/\/(?:home|Users)\/[^/\s]+/g, '~');
  let out = noHome;
  try { out = redactSecrets(noHome, { force: true, count: { redactions: 0 } }); } catch { /* redactor optional */ }
  return out.slice(0, 2000);
}

export function isTelemetryEnabled(): boolean {
  const f = process.env.CHAT_RECALL_TELEMETRY;
  return !(f === '0' || f === 'false' || f === 'off');
}

/**
 * Report a client failure/health event. Best-effort, non-blocking, never throws.
 * `kind`: mcp_crash | mcp_unhandled | sync_error | auth_error | tool_error |
 *         index_failed | startup | …
 */
export function reportClientEvent(kind: string, opts: { tool?: string; message?: string } = {}): void {
  if (!isTelemetryEnabled()) return;
  try {
    const targets = loadAllCredentials();
    if (!targets.length) return;
    const body = JSON.stringify({
      events: [{
        ts: Date.now(),
        kind: String(kind).slice(0, 64),
        tool: (opts.tool || '').slice(0, 64),
        cliVersion: CLI_VERSION,
        os: `${process.platform}-${process.arch}`,
        message: scrub(opts.message || ''),
      }],
    });
    for (const t of targets) {
      if (!t.serverUrl) continue;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (t.token) headers.authorization = `Bearer ${t.token}`;
      // Fire-and-forget: short timeout, swallow every error. Reporting a failure
      // must not itself fail the process or block the caller.
      void fetch(`${t.serverUrl.replace(/\/+$/, '')}/api/client-events`, {
        method: 'POST', headers, body, signal: AbortSignal.timeout(3000),
      }).catch(() => { /* best-effort */ });
    }
  } catch { /* never let telemetry break anything */ }
}
