import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * The folder `src/vendor/mcp-kit` is a copy of the host of `@munhq/mcp-kit`,
 * made by `scripts/vendor-mcp-kit.mjs`. These tests hold the copy to the pin:
 * a file that grows an import outside Node and the folder, or a copy that
 * drifts from the version the script names, fails here and not in the field.
 */
const cli = fileURLToPath(new URL('..', import.meta.url));
const vendor = join(cli, 'src', 'vendor', 'mcp-kit');
const script = readFileSync(join(cli, 'scripts', 'vendor-mcp-kit.mjs'), 'utf-8');
const pinned = /export const PINNED = '([^']+)'/.exec(script)?.[1];

/** Every module the host needs: the program, its loop, the file of servers, and the machine. */
const FILES = [
  'host.js', 'host.d.ts', 'host-plain.js', 'host-plain.d.ts', 'host-main.js', 'host-main.d.ts', 'registry.js', 'registry.d.ts',
];

describe('the vendored host of the kit', () => {
  test('names the pinned version', () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readFileSync(join(vendor, 'VERSION'), 'utf-8').trim()).toBe(`@munhq/mcp-kit ${pinned}`);
  });

  test('holds every module of the host', () => {
    for (const file of FILES) expect(existsSync(join(vendor, file)), file).toBe(true);
  });

  test('names no map that the kit keeps', () => {
    for (const file of FILES.filter((f) => f.endsWith('.js'))) {
      expect(readFileSync(join(vendor, file), 'utf-8'), file).not.toContain('sourceMappingURL');
    }
  });

  test('imports Node and its own folder only', () => {
    for (const file of FILES.filter((f) => f.endsWith('.js'))) {
      const text = readFileSync(join(vendor, file), 'utf-8');
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        expect(m[1].startsWith('node:') || m[1].startsWith('./'), `${file} imports ${m[1]}`).toBe(true);
      }
    }
  });
});
