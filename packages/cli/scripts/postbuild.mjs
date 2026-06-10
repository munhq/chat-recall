#!/usr/bin/env node
/**
 * Post-build: mark the bin entries (`dist/cli.js`, `dist/mcp.js`) executable.
 *
 * `npm install -g` would chmod these for us when symlinking — but during local
 * development we want `node dist/cli.js` users *and* the chat-recall hooks
 * (which check `[[ -x ]]` before invoking) to work without an extra step.
 */
import { chmodSync } from 'node:fs';

for (const path of ['dist/cli.js', 'dist/mcp.js', 'dist/watch.js']) {
  try {
    chmodSync(path, 0o755);
  } catch (err) {
    // Tolerate Windows / readonly filesystems; npm postinstall handles the rest.
    console.warn(`chmod failed for ${path}: ${err.message}`);
  }
}
