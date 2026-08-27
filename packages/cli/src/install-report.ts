/**
 * Tell the server that an install FAILED, when nothing else can.
 *
 * Every other funnel event fires after the user got past login, so a first run
 * that dies before that is invisible: no credential, no tenant, nothing to
 * attribute. The way the last one was found was the founder running the command
 * on his own laptop and pasting the output. This is the mechanism that replaces
 * that.
 *
 * ── What it will not do ───────────────────────────────────────────────────
 *
 * It sends a step name, a classification, a one-line message and three
 * environment strings. Not a path, not an argument, not a stack trace, not a
 * hostname — and `assertNoSensitiveKeys` enforces that structurally rather than
 * by review, so the next person adding "just the server URL for context" gets a
 * failure instead of a shipped leak.
 *
 * The server URL is the ONE thing worth wanting here and it is deliberately
 * absent: a self-hoster's hostname is their infrastructure, and the failures we
 * need to see are the hosted ones, which we already know the address of.
 *
 * ── Fire and forget, and silent ───────────────────────────────────────────
 *
 * Never awaited on the user's critical path, never logged, never able to fail a
 * command. A diagnostic that can break an install is worse than no diagnostic.
 */
import { mayReport, userConsents, assertNoSensitiveKeys } from './telemetry-consent.js';

/** The steps that may report. A closed set: an open one turns this into a log. */
export type InstallStep =
  | 'cli_login_probe'    // could not read /api/capabilities
  | 'cli_login_device'   // the device flow itself failed
  | 'cli_mcp_config'     // could not write an AI tool's config
  | 'cli_first_sync'     // the first upload failed
  | 'cli_node_version';  // refused an unsupported Node

export interface InstallFailure {
  step: InstallStep;
  /** The classification, not the prose: 'dns', 'tls', 'timeout', 'HTTP 502'. */
  reason?: string | null;
  /** One line, already free of paths. Truncated again server-side. */
  message?: string | null;
}

/**
 * Post one failure. Resolves whether or not it was sent.
 *
 * `serverUrl` decides WHERE to report and is never part of the payload. When the
 * user has opted out, or the server has not said telemetry is allowed, this does
 * nothing at all.
 */
export async function reportInstallFailure(
  serverUrl: string,
  failure: InstallFailure,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  if (!serverUrl) return false;
  // mayReport() needs the server to have confirmed eligibility, which it cannot
  // have done when the very first request failed — so consent alone is the gate
  // here, and the payload carries nothing that needs a server's permission.
  if (!userConsents() && !mayReport(serverUrl)) return false;

  const payload = {
    step: failure.step,
    reason: trim(failure.reason, 40),
    message: trim(failure.message, 200),
    cliVersion: trim(process.env.CHAT_RECALL_CLI_VERSION, 20),
    node: trim(process.versions.node, 20),
    os: `${process.platform}-${process.arch}`,
  };

  try {
    // Structural check, not a promise in a comment. Throws on a forbidden key.
    assertNoSensitiveKeys(payload);
  } catch {
    return false;
  }

  const f = opts.fetchImpl || fetch;
  try {
    const res = await f(`${serverUrl.replace(/\/+$/, '')}/install/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
    });
    return res.ok || res.status === 204;
  } catch {
    // The machine that cannot reach us cannot report. Known and accepted.
    return false;
  }
}

function trim(v: unknown, n: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null;
}
