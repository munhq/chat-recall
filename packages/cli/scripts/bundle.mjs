#!/usr/bin/env node
/**
 * Bundle the CLI + MCP into self-contained dist entrypoints so the published
 * package needs no workspace siblings. `@chat-recall/engine` (and the CLI's own
 * source) are inlined; every npm dependency stays external and is installed
 * normally from package.json. Native modules (better-sqlite3, @lancedb/lancedb,
 * pg) must stay external — they can't be bundled.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const cliPkg = JSON.parse(readFileSync(new URL('../package.json', here)));
const enginePkg = JSON.parse(readFileSync(new URL('../../engine/package.json', here)));

// External = all npm deps from the CLI and engine, EXCEPT the workspace engine
// itself (we want that inlined).
const external = [
  ...Object.keys(cliPkg.dependencies || {}),
  ...Object.keys(enginePkg.dependencies || {}),
].filter((d) => d !== '@chat-recall/engine');

await build({
  entryPoints: ['src/cli.ts', 'src/mcp.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external,
  // Some externalized deps (native addons) use CommonJS require(); shim it for ESM.
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

console.log(`bundled cli.js + mcp.js (externals: ${external.length})`);
