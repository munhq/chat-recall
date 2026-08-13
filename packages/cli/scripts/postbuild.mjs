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
