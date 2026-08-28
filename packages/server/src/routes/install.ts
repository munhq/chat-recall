/**
 * Public install surface — the funnel's first touch, mounted BEFORE tenantAuth
 * (an installer has no credentials yet, by definition).
 *
 *   GET /install.sh              → POSIX installer, templated with this
 *                                  server's public origin
 *   GET /install/chat-recall.tgz → the CLI tarball `npm pack`ed at image
 *                                  build time (see docker/Dockerfile.server)
 *
 * Serving the tarball from the server itself — instead of publishing to the
 * npm registry — means every deployment (SaaS or compose self-host) hands out
 * a CLI that exactly matches its own server version, and self-hosters get a
 * working installer with zero registry dependencies.
 */
import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Request } from 'express';

const router = express.Router();

const TGZ_PATH = resolve(
  process.env.INSTALL_TGZ_PATH || '/app/install/chat-recall.tgz',
);

/**
 * A host we are willing to interpolate into a shell script: hostname or IP,
 * optional port. No scheme, no path, no userinfo, and — the point — none of
 * the characters that mean something to `sh`. `${origin}` lands inside a
 * double-quoted assignment (TGZ_URL below), where `$(…)`, backticks and `"`
 * are all still live, so this pattern is the boundary that stops a header from
 * becoming code.
 *
 * Every interpolation of `origin` in the script below is ALSO shell-quoted, so
 * this regex is defence in depth rather than the only thing standing between a
 * request header and `sh`. That matters because the next person to widen it —
 * IPv6 literals need `[` and `]`, both sh glob characters — should not be able
 * to re-open command injection by editing one character class.
 */
const SAFE_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?::\d{1,5})?$/;

export class UnsafeOriginError extends Error {}

/**
 * Public origin as the CLIENT reached us.
 *
 * PUBLIC_URL is operator-set and authoritative. Everything else comes from
 * request headers, which are attacker-controlled: `X-Forwarded-Host: evil.tld`
 * rewrites TGZ_URL, and anyone served that copy of the script installs the CLI
 * from the attacker. That is a supply-chain redirect, so the header path is
 * validated hard and the response is never cacheable (see the route).
 */
export function publicOrigin(req: Request): string {
  const env = process.env.PUBLIC_URL;
  if (env) {
    const trimmed = env.replace(/\/+$/, '');
    let u: URL;
    try { u = new URL(trimmed); } catch { throw new UnsafeOriginError(`PUBLIC_URL is not a valid URL: ${env}`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new UnsafeOriginError(`PUBLIC_URL must be http(s), got ${u.protocol}`);
    }
    if (!SAFE_HOST.test(u.host)) throw new UnsafeOriginError(`PUBLIC_URL host is not a bare host:port: ${u.host}`);
    return `${u.protocol}//${u.host}`;
  }

  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = (req.get('x-forwarded-host') || req.get('host') || 'localhost').split(',')[0].trim();
  if (proto !== 'http' && proto !== 'https') {
    throw new UnsafeOriginError(`refusing to build an install script for protocol ${JSON.stringify(proto)}`);
  }
  if (!SAFE_HOST.test(host)) {
    throw new UnsafeOriginError(`refusing to build an install script for host ${JSON.stringify(host)}`);
  }
  return `${proto}://${host}`;
}

function installScript(origin: string): string {
  // POSIX sh, no bashisms — piped straight into `sh` from the website.
  return `#!/bin/sh
# chat-recall installer — served by ${origin}
# Installs the chat-recall CLI (Node 18+ required; no build tools needed).
set -eu

TGZ_URL="${origin}/install/chat-recall.tgz"

command -v node >/dev/null 2>&1 || {
  echo "error: Node.js 18+ is required — install it from https://nodejs.org and re-run." >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "error: npm not found (it ships with Node.js 18+)." >&2
  exit 1
}
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
[ "$NODE_MAJOR" -ge 18 ] || {
  echo "error: Node.js >= 18 required (found $(node --version))." >&2
  exit 1
}

echo "Installing chat-recall from $TGZ_URL ..."
if npm install -g "$TGZ_URL"; then
  :
else
  echo "" >&2
  echo "Global install failed (usually a permissions issue with npm -g)." >&2
  echo "Fix npm's global prefix or re-run with a user prefix, e.g.:" >&2
  echo "  npm install -g --prefix \\"\\$HOME/.local\\" $TGZ_URL   # ensure \\$HOME/.local/bin is on PATH" >&2
  exit 1
fi

echo ""
chat-recall --version
echo ""

# Already connected (e.g. re-running the installer to upgrade)? Skip the
# token dance entirely. --check is report-only and never interactive; it also
# auto-connects to no-auth self-host servers.
if chat-recall login "${origin}" --check >/dev/null 2>&1; then
  echo "Already connected to ${origin}."
  # Reuse the existing login; init still (re)registers the MCP and reinstalls/
  # restarts the background service, so re-running the installer to upgrade
  # fully lands (new binary + MCP config).
  chat-recall init --skip-sync || echo "Setup step reported an issue — see above." >&2
else
  # Fresh machine: send the user to the token page and read the paste back.
  # The device label is a random slug — the hostname must not leak into a URL
  # (browser history, IdP logs). Rename/revoke devices later in Account.
  DEVICE="dev-$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \\n')"
  [ "\$DEVICE" = "dev-" ] && DEVICE="dev-\$\$"
  CONNECT_URL="${origin}/?view=connect&device=\$DEVICE"

  echo "Get your device token here (sign in if asked; the token page opens right after):"
  echo ""
  echo "    \$CONNECT_URL"
  echo ""
  # Best effort — over SSH there's no local browser; the printed URL works from
  # any device, the paste comes back to THIS terminal either way.
  (xdg-open "\$CONNECT_URL" || open "\$CONNECT_URL") >/dev/null 2>&1 || true

  if [ ! -r /dev/tty ]; then
    echo "No terminal to read the token from (piped/CI run)." >&2
    echo "Finish setup with:  chat-recall init --server '${origin}' --token <your-token>" >&2
    exit 1
  fi
  printf "Paste your token here: "
  read TOKEN < /dev/tty
  [ -n "\$TOKEN" ] || { echo "No token entered." >&2; exit 1; }

  # init validates the token + logs in, REGISTERS THE RECALL MCP in Claude Code
  # (~/.mcp.json), and installs the background sync service — the full one-line
  # setup. --skip-sync: the service (or the MCP's own sync) ships history in the
  # background so the installer never blocks on a first full sync.
  chat-recall init --server "${origin}" --token "\$TOKEN" --skip-sync || exit 1
fi

echo ""
# init (above) already registered the recall MCP in Claude Code and installed
# the background sync service. The service — or, if it couldn't install, the
# MCP's own in-process sync — ships history continuously; the installer never
# blocks on a full first sync (--skip-sync).
echo "Done. Recall tools are registered in Claude Code and your history is syncing in the background at ${origin}."
`;
}

router.get('/install.sh', (req, res) => {
  let origin: string;
  try {
    origin = publicOrigin(req);
  } catch (e) {
    // Fail closed. A wrong origin here is not a rendering bug — it is a script
    // that installs software from somewhere the operator never chose.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'X-Forwarded-Host, X-Forwarded-Proto, Host');
    res.status(400).type('text/plain; charset=utf-8').send(
      `# chat-recall installer\n`
      + `echo "This server cannot determine its own public URL safely." >&2\n`
      + `echo "The operator should set PUBLIC_URL on the server." >&2\n`
      + `exit 1\n`,
    );
    return;
  }
  // The body embeds a host taken from request headers when PUBLIC_URL is unset.
  // A shared cache keyed without those headers could hand one visitor's
  // poisoned script to the next visitor, so this response is never stored.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'X-Forwarded-Host, X-Forwarded-Proto, Host');
  res.type('text/plain; charset=utf-8').send(installScript(origin));
});

router.get('/install/chat-recall.tgz', (_req, res) => {
  if (!existsSync(TGZ_PATH)) {
    // Dev checkouts / images built without the pack step: fail loudly with the
    // fix, never a bare 404 the installer can't explain.
    res.status(404).json({
      error: 'CLI tarball not present on this server build',
      expectedAt: TGZ_PATH,
      hint: 'image must `npm pack` the cli workspace to INSTALL_TGZ_PATH (see docker/Dockerfile.server)',
    });
    return;
  }
  res.type('application/gzip');
  res.sendFile(TGZ_PATH);
});

/**
 * POST /install/report — the only way a FAILED install can tell us it happened.
 *
 * Every other funnel event fires after the user got past login (see
 * util/growth.ts), and this failure happens before it: no credential, no tenant,
 * nothing to attribute. So a broken first run was invisible, and the way we
 * learned about the last one was the founder typing the command on his own
 * laptop. That is not a monitoring strategy.
 *
 * Mounted here because this router is already pre-auth and top-level.
 *
 * WHAT IT ACCEPTS IS FIXED AND TINY — a step name, an error CLASS, a one-line
 * message, and three environment strings. No paths, no arguments, no stack
 * trace, no hostname: a diagnostic surface that grows into a log is how user
 * content ends up somewhere nobody audits. Anything else in the body is dropped
 * rather than stored, and the fields kept are truncated hard.
 *
 * ONE HONEST LIMIT: a machine that cannot reach us cannot report. This catches
 * the case where the network is fine and something in between is not — a proxy,
 * a WAF, a TLS interception, a resolver — which is the failure that is otherwise
 * impossible to attribute.
 */
const REPORT_STEPS = new Set([
  'cli_login_probe', 'cli_login_device', 'cli_mcp_config', 'cli_first_sync', 'cli_node_version',
]);
const cut = (v: unknown, n: number): string | null =>
  (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

router.post('/install/report', express.json({ limit: '2kb' }), async (req, res) => {
  const step = cut(req.body?.step, 40);
  if (!step || !REPORT_STEPS.has(step)) {
    // Refuse an unknown step rather than record it: an open enum is how this
    // becomes a log.
    res.status(400).json({ error: 'unknown step' });
    return;
  }
  // REQUIRE THE ENVIRONMENT FIELDS. The CLI always sends `node` and `os` — they
  // are computed from process.versions and process.platform, never optional —
  // so a report without them did not come from a chat-recall install.
  //
  // This endpoint is public and unauthenticated by necessity: a first run that
  // fails has no credential. That also makes it the easiest surface in the
  // product to poison, and the first report it ever recorded was exactly that:
  // a body containing nothing but a step name, filed against a step that means
  // "someone's install could not reach the server". It was counted as a lost
  // user for two days.
  //
  // Refusing an empty report is the same rule already applied to an unknown
  // step, for the same reason: a diagnostic surface that accepts anything
  // becomes a log, and a funnel anyone can write to measures nothing.
  const node = cut(req.body?.node, 20);
  const os = cut(req.body?.os, 20);
  if (!node || !os) {
    res.status(400).json({ error: 'report must carry node and os' });
    return;
  }

  try {
    const { growth } = await import('../util/growth.js');
    growth('funnel_fail', {
      tenant: null,
      extra: {
        step,
        reason: cut(req.body?.reason, 40),        // the classification, e.g. 'dns'
        message: cut(req.body?.message, 200),     // already redacted by the CLI
        cliVersion: cut(req.body?.cliVersion, 20),
        node,
        os,
      },
    });
  } catch {
    // Telemetry must never be the reason a install-time request fails.
  }
  // 204 always: the CLI is fire-and-forget and must not branch on this.
  res.status(204).end();
});

export default router;
