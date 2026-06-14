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
import { builtinModules } from 'node:module';

const here = new URL('.', import.meta.url);
const cliPkg = JSON.parse(readFileSync(new URL('../package.json', here)));
const enginePkg = JSON.parse(readFileSync(new URL('../../engine/package.json', here)));

// External = all npm deps from the CLI and engine, EXCEPT the workspace engine
// itself (we want that inlined). The engine still lists native deps
// (better-sqlite3/lancedb/pg) so they stay externalized here, but the COLLECTOR
// only actually installs what's in its own (optional)dependencies — the guard
// below proves the built bundles never require anything outside that set.
const external = [
  ...Object.keys(cliPkg.dependencies || {}),
  ...Object.keys(cliPkg.optionalDependencies || {}),
  ...Object.keys(enginePkg.dependencies || {}),
].filter((d) => d !== '@chat-recall/engine');

await build({
  entryPoints: [
    { in: 'src/cli.ts', out: 'cli' },
    { in: 'src/mcp.ts', out: 'mcp' },
    // The auto-indexer daemon ships as its own bin (`chat-recall-watch`) so
    // installed users get live indexing + continuous sync without a repo
    // checkout and tsx.
    { in: 'auto-indexer/indexer.ts', out: 'watch' },
  ],
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

console.log(`bundled cli.js + mcp.js + watch.js (externals: ${external.length})`);

// ── Native-free guard ────────────────────────────────────────────────────
// The collector must install with zero compilation: a user running
// `npm install -g chat-recall` only gets cliPkg.dependencies (+ optional
// better-sqlite3, which may fail to build and is fine to skip). So every bare
// require() the built bundles emit MUST resolve to one of those, a Node
// builtin, or the optional set. If a future change reintroduces a store import
// that pulls e.g. @lancedb/lancedb or pg, this fails the build instead of
// shipping a package that crashes on install/boot.
const allowed = new Set([
  ...Object.keys(cliPkg.dependencies || {}),
  ...Object.keys(cliPkg.optionalDependencies || {}),
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);
const isOptional = new Set(Object.keys(cliPkg.optionalDependencies || {}));
// Match require('x') / require("x") for bare specifiers (not ./relative paths).
const requireRe = /require\(\s*['"]([^'".][^'"]*)['"]\s*\)/g;
const offenders = new Set();
for (const out of ['cli.js', 'mcp.js', 'watch.js']) {
  const code = readFileSync(new URL(`../dist/${out}`, here), 'utf-8');
  for (const m of code.matchAll(requireRe)) {
    const spec = m[1];
    // Reduce subpath imports (e.g. "@scope/pkg/sub") to the package name.
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (!allowed.has(pkg)) offenders.add(`${out} → require('${spec}')`);
  }
}
if (offenders.size > 0) {
  console.error('\n✗ native-free guard FAILED — the bundle requires modules not in the collector deps:');
  for (const o of offenders) console.error(`    ${o}`);
  console.error('  Fix: drop the import that pulls it, or add it to packages/cli/package.json dependencies.\n');
  process.exit(1);
}
const optionalNote = isOptional.size ? ` (optional, lazy: ${[...isOptional].join(', ')})` : '';
console.log(`✓ native-free guard passed — bundles require only collector deps${optionalNote}`);
