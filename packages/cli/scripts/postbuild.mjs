#!/usr/bin/env node
/**
 * Post-build: mark the bin entries (`dist/cli.js`, `dist/mcp.js`) executable.
 *
 * `npm install -g` would chmod these for us when symlinking — but during local
 * development we want `node dist/cli.js` users *and* the chat-recall hooks
 * (which check `[[ -x ]]` before invoking) to work without an extra step.
 */
import { chmodSync, cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const path of ['dist/cli.js', 'dist/mcp.js', 'dist/watch.js']) {
  try {
    chmodSync(path, 0o755);
  } catch (err) {
    // Tolerate Windows / readonly filesystems; npm postinstall handles the rest.
    console.warn(`chmod failed for ${path}: ${err.message}`);
  }
}

// The vendored host kit is copied as files, not bundled: `dist/mcp.js` imports
// `./vendor/mcp-kit/host.js` and the host program is `dist/vendor/mcp-kit/host-main.js`, which Node runs
// as its own process. Run `node scripts/vendor-mcp-kit.mjs` to refresh it from the pinned kit version.
try {
  cpSync('src/vendor', 'dist/vendor', { recursive: true });
  console.log('copied src/vendor → dist/vendor');
} catch (err) {
  console.warn(`vendor copy failed: ${err.message}`);
}

// Copy the repo-root hook scripts into the package. `install-hooks` resolves
// them at <pkg>/hooks/*.sh (see findHook in src/cli.ts) and package.json ships
// the `hooks` dir in `files` — but the sources live at the monorepo root, so
// without this copy the built CLI cannot locate any hook script and the
// published tarball contains none.
const repoHooks = fileURLToPath(new URL('../../../hooks', import.meta.url));
if (existsSync(repoHooks)) {
  try {
    cpSync(repoHooks, 'hooks', { recursive: true });
    console.log('copied repo hooks/ → packages/cli/hooks/');
  } catch (err) {
    console.warn(`hooks copy failed: ${err.message}`);
  }
}
