#!/usr/bin/env node
/**
 * Bundle the CLI + MCP into self-contained dist entrypoints so the published
 * package needs no workspace siblings. `@chat-recall/engine` (and the CLI's own
 * source) are inlined; every npm dependency stays external and is installed
 * normally from package.json. Native modules (@lancedb/lancedb, pg) must stay
 * external — they can't be bundled.
 *
 * better-sqlite3 is NOT in this list any more: OpenCode's database is read with
 * Node's built-in `node:sqlite`, so the shipped package has no native SQLite
 * dependency at all. It survives only as a devDependency, for the test-only
 * sqlite StorageDriver. If it reappears in a bundle, the guard below fails the
 * build — which is the point.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';

const here = new URL('.', import.meta.url);
const cliPkg = JSON.parse(readFileSync(new URL('../package.json', here)));
const enginePkg = JSON.parse(readFileSync(new URL('../../engine/package.json', here)));

// External = the CLI's own (optional)dependencies — those install from
// package.json on the customer's machine — plus the engine's NATIVE deps
// (unbundleable addons). Every other engine dep (pino, pg's pure-JS friends,
// etc.) gets INLINED: the published package installs only cliPkg deps, so an
// externalized-but-uninstalled engine dep crashes a fresh install at boot
// (this exact bug shipped: `import 'pino'` stayed external → every
// `npm i -g chat-recall` broke with ERR_MODULE_NOT_FOUND).
const NATIVE_ENGINE_DEPS = ['@lancedb/lancedb', 'pg'];
const external = [
  ...Object.keys(cliPkg.dependencies || {}),
  ...Object.keys(cliPkg.optionalDependencies || {}),
  ...NATIVE_ENGINE_DEPS,
].filter((d) => d !== '@chat-recall/engine');

await build({
  entryPoints: [
    { in: 'src/cli.ts', out: 'cli' },
    { in: 'src/mcp.ts', out: 'mcp' },
    // The relay is its OWN entry, and must stay tiny. It is what an AI tool
    // spawns per session; mcp.js is what it relays to. Bundling the two
    // together would load the whole engine in every session again, which is
    // the entire cost the split removes.
    { in: 'src/mcp-relay.ts', out: 'mcp-relay' },
    // The auto-indexer daemon ships as its own bin (`chat-recall-watch`) so
    // installed users get live indexing + continuous sync without a repo
    // checkout and tsx.
    { in: 'auto-indexer/indexer.ts', out: 'watch' },
    // The scan worker is its OWN entry because worker_threads needs a real file
    // to spawn. It sits beside the other bundles so `new URL('./scan-worker.js',
    // import.meta.url)` resolves from whichever one is running.
    { in: 'src/scan-worker.ts', out: 'scan-worker' },
  ],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external,
  // Bake the CLI version in so the watch daemon can tell the server it's stale
  // (auto-update) without a runtime package.json read.
  define: { __CLI_VERSION__: JSON.stringify(cliPkg.version) },
  // Some externalized deps (native addons) use CommonJS require(); shim it for ESM.
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

console.log(`bundled cli.js + mcp.js + mcp-relay.js + watch.js + scan-worker.js (externals: ${external.length})`);

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
// Every way the bundle can pull a bare specifier at runtime, each with its
// own severity:
//   require('x') / top-level `import … from 'x'` — loaded at BOOT. Must be a
//     collector dep or builtin, full stop. (The `from`-statement check is the
//     one that was missing when a top-level `import 'pino'` shipped and broke
//     every fresh `npm i -g chat-recall`.)
//     NOTE: optionalDependencies are in `allowed` below, so a BOOT-time import
//     of one passes this check while `--omit=optional` would still crash at
//     runtime. That hid a static better-sqlite3 import for a long time. There
//     are no optional deps left in the CLI package, so the hole is currently
//     empty — do not add one back without splitting them out of `allowed`.
//   import('x') — LAZY. Also allowed for the engine's native/server deps
//     (pg, lancedb): those code paths never execute on a collector machine,
//     and keeping them dynamic is exactly what makes the package native-free.
const bootRes = [
  /require\(\s*['"]([^'"\s.][^'"\s]*)['"]\s*\)/g,
  /^import\b[^'"\n]*['"]([^'"\s.][^'"\s]*)['"];?\s*$/gm,
];
const lazyRe = /\bimport\(\s*['"]([^'"\s.][^'"\s]*)['"]\s*\)/g;
const lazyAllowed = new Set([...allowed, ...NATIVE_ENGINE_DEPS]);
const toPkg = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
const offenders = new Set();
for (const out of ['cli.js', 'mcp.js', 'mcp-relay.js', 'watch.js', 'scan-worker.js']) {
  const code = readFileSync(new URL(`../dist/${out}`, here), 'utf-8');
  for (const re of bootRes) {
    for (const m of code.matchAll(re)) {
      if (!allowed.has(toPkg(m[1]))) offenders.add(`${out} → boot-time '${m[1]}'`);
    }
  }
  for (const m of code.matchAll(lazyRe)) {
    if (!lazyAllowed.has(toPkg(m[1]))) offenders.add(`${out} → lazy import('${m[1]}')`);
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
