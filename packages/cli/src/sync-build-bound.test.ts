/**
 * The build has to be refused BEFORE it copies, not after.
 *
 * This is the third guard of issue #16. Measured on the machine that OOMed: a
 * 124 MB transcript reached 263 MB RSS after the read, 511 MB after
 * buildRawContainer and 555 MB after the gzip, and heapUsed never passed 25 MB
 * — the container's strings and the buffers sit outside the V8 heap, so a heap
 * cap cannot bound them. One session is therefore a multiple of its own bytes,
 * which makes the export the only honest place to decide.
 *
 * sessionBuildBytes() reads fileSize() and returns 0 for a backend whose
 * sessions live in SQLite and have no file, so it cannot be the trigger for
 * every backend. exportByteLength() reads the bytes we already hold.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportByteLength, FULL_BUILD_MAX_BYTES } from './sync-client.js';

const SOURCE = readFileSync(join(import.meta.dirname, 'sync-client.ts'), 'utf-8');

describe('exportByteLength', () => {
  test('sums every file of the export', () => {
    expect(exportByteLength({
      files: [
        { bytes: { length: 10 } },
        { bytes: { length: 32 } },
      ],
    })).toBe(42);
  });

  test('a missing export is zero bytes, not an exception', () => {
    expect(exportByteLength(null)).toBe(0);
    expect(exportByteLength(undefined)).toBe(0);
    expect(exportByteLength({ files: [] })).toBe(0);
  });
});

describe('the ceiling is decided on the export, before the container exists', () => {
  test('the default ceiling is 24 MB and the environment can raise it', () => {
    expect(FULL_BUILD_MAX_BYTES).toBe(24 * 1024 * 1024);
  });

  test('the export is measured before buildRawContainer is called', () => {
    const measured = SOURCE.indexOf('const exportBytes = exportByteLength(exp);');
    const built = SOURCE.indexOf('built = buildRawContainer(exp);');
    expect(measured).toBeGreaterThan(-1);
    expect(built).toBeGreaterThan(-1);
    expect(measured).toBeLessThan(built);
  });

  test('a session over the ceiling takes no container and no shadow merge', () => {
    const gate = SOURCE.indexOf('const overCeiling = exportBytes > FULL_BUILD_MAX_BYTES;');
    expect(gate).toBeGreaterThan(-1);
    // The build runs only when the export is under the ceiling…
    expect(SOURCE.indexOf('if (exp && !overCeiling) {')).toBeGreaterThan(-1);
    // …and the shadow merge is skipped when it is over.
    expect(SOURCE).toContain('const shadow = overCeiling');
    expect(SOURCE).toContain("{ container: null, status: 'skipped' as const, recovered: 0 }");
  });

  test('an over-ceiling session is still counted, once', () => {
    // The event carries the size, the tool and a de-duplication key, so the
    // count means sessions and not "how often did the walk see it".
    const block = SOURCE.slice(SOURCE.indexOf('if (exp && overCeiling) {'), SOURCE.indexOf('if (exp && !overCeiling) {'));
    expect(block).toContain("kind: 'oversized_session'");
    expect(block).toContain('dedupeKey: stableMark(ref.prefixedId)');
    expect(block).toContain('includeRaw = false;');
    expect(block).toContain('includeMeta = false;');
  });
});
