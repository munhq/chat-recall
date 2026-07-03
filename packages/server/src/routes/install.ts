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

/** Public origin as the CLIENT reached us — honours the reverse proxy. */
function publicOrigin(req: Request): string {
  const env = process.env.PUBLIC_URL;
  if (env) return env.replace(/\/+$/, '');
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = (req.get('x-forwarded-host') || req.get('host') || 'localhost').split(',')[0].trim();
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
if chat-recall login ${origin} --check >/dev/null 2>&1; then
  echo "Already connected to ${origin}."
else
  # Fresh machine: send the user to the token page and read the paste back.
  DEVICE=$(hostname 2>/dev/null | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g')
  CONNECT_URL="${origin}/?view=connect&device=\${DEVICE:-my-machine}"

  echo "Get your device token here (sign in if asked; the token page opens right after):"
  echo ""
  echo "    \$CONNECT_URL"
  echo ""
  # Best effort — over SSH there's no local browser; the printed URL works from
  # any device, the paste comes back to THIS terminal either way.
  (xdg-open "\$CONNECT_URL" || open "\$CONNECT_URL") >/dev/null 2>&1 || true

  if [ ! -r /dev/tty ]; then
    echo "No terminal to read the token from (piped/CI run)." >&2
    echo "Finish connecting with:  chat-recall login ${origin} --token <your-token>" >&2
    exit 1
  fi
  printf "Paste your token here: "
  read TOKEN < /dev/tty
  [ -n "\$TOKEN" ] || { echo "No token entered." >&2; exit 1; }

  # login validates the token against the server before saving it.
  chat-recall login ${origin} --token "\$TOKEN" || exit 1
fi

echo ""
echo "Starting your first sync (indexes local AI sessions, redacts secrets locally, pushes) ..."
chat-recall sync || {
  echo "" >&2
  echo "First sync hit an error — re-run it with: chat-recall sync" >&2
  exit 1
}

echo ""
echo "Done. Your history is live at ${origin}"
`;
}

router.get('/install.sh', (req, res) => {
  res.type('text/plain; charset=utf-8').send(installScript(publicOrigin(req)));
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

export default router;
