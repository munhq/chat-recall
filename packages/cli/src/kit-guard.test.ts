import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error a build script, written in JavaScript
import { assertNoKitCode, kitLines } from '../scripts/kit-guard.mjs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kit-guard-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the build guard for private kits', () => {
  test('a file that the bundler inlined from a kit is found', () => {
    const text = 'const a = 1;\n// ../../node_modules/@munhq/mcp-kit/dist/cli/device.js\nexport function deviceLogin() {}\n';
    expect(kitLines(text)).toEqual(['// ../../node_modules/@munhq/mcp-kit/dist/cli/device.js']);
  });

  test('a static import of a kit is found, in each spelling', () => {
    for (const line of [
      'import { x } from "@munhq/mcp-kit/cli";',
      "import { x } from '@munhq/data-kit/pg';",
      'const m = require("@munhq/mcp-kit/cli");',
      'const m = await import("@munhq/mcp-kit/cli");',
    ]) expect(kitLines(line)).toEqual([line]);
  });

  test('the name of a kit in a comment or a message is not code', () => {
    expect(kitLines(' * The login with the kit of the fleet (`@munhq/mcp-kit/cli`) as an optional extra.')).toEqual([]);
    expect(kitLines("throw new Error('cliHost needs @munhq/mcp-kit, which is not installed');")).toEqual([]);
  });

  test('a folder of clean bundles passes, and one with kit code fails and names the file and the kit', () => {
    writeFileSync(join(dir, 'cli.js'), 'console.log("clean");\n');
    expect(() => assertNoKitCode(dir)).not.toThrow();
    writeFileSync(join(dir, 'mcp.js'), '// ../../node_modules/@munhq/mcp-kit/dist/cli/store.js\n');
    expect(() => assertNoKitCode(dir)).toThrow(/mcp\.js: 1 line\(s\) of @munhq\/mcp-kit/);
  });
});
