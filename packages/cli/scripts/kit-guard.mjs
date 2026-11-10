/**
 * The published package holds no code of a private `@munhq` kit.
 *
 * Two ways the code of a kit gets into `dist`:
 *   1. The bundler inlines it. esbuild writes a comment above each inlined file:
 *      `// ../../node_modules/@munhq/mcp-kit/dist/cli/device.js`.
 *   2. A source file imports it statically. The bundle then stops at start on a
 *      machine that has no kit.
 * The kit is loaded at run time through `optionalKit()` of the engine, and
 * nothing else may name it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const INLINED = /node_modules\/@munhq\//;
const STATIC_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)["']@munhq\//;

/** The lines of a bundle that show kit code or a static import of a kit. */
export function kitLines(text) {
  return text.split('\n').filter((l) => INLINED.test(l) || STATIC_IMPORT.test(l));
}

/** Throws when a `.js` file in `dir` holds kit code or imports a kit statically. */
export function assertNoKitCode(dir) {
  const bad = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const lines = kitLines(readFileSync(join(dir, name), 'utf-8'));
    if (lines.length === 0) continue;
    const kits = [...new Set(lines.map((l) => l.match(/@munhq\/[a-z0-9-]+/)?.[0]).filter(Boolean))];
    bad.push(`${name}: ${lines.length} line(s) of ${kits.join(', ')}`);
  }
  if (bad.length) {
    throw new Error(
      `The bundles hold code of a private kit:\n  ${bad.join('\n  ')}\n`
      + 'A kit is optional at run time: load it with optionalKit() and keep it external.',
    );
  }
}
