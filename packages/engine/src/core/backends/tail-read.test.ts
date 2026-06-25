/**
 * tail-read — the last-newline snap that prevents torn-line misalignment.
 * See docs/SYNC-INCREMENTAL.md §2.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTailFromOffset } from './tail-read.js';

let dir: string;
const file = () => join(dir, 'transcript.jsonl');

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'cr-tail-')); });
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

describe('readTailFromOffset', () => {
  test('reads the full tail from offset 0', () => {
    writeFileSync(file(), '{"a":1}\n{"b":2}\n{"c":3}\n');
    const r = readTailFromOffset(file(), 0);
    expect(r.text).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(r.newOffset).toBe(24); // 8 bytes per line × 3
  });

  test('reads only the new tail from a mid-file offset', () => {
    writeFileSync(file(), '{"a":1}\n{"b":2}\n{"c":3}\n');
    // offset 10 lands inside line 2; the read starts mid-line. The helper reads
    // raw bytes from offset and snaps to the last newline — it does NOT align to
    // a line boundary at the START (the caller passes a valid line boundary
    // offset). This test documents that behaviour.
    const r = readTailFromOffset(file(), 10);
    expect(r.newOffset).toBe(24);
    expect(r.text.endsWith('{"c":3}\n')).toBe(true);
  });

  test('snaps to the last newline — a torn trailing line is excluded and re-read next tick', () => {
    // Three complete lines (24 bytes) + a partial fourth (no trailing newline).
    writeFileSync(file(), '{"a":1}\n{"b":2}\n{"c":3}\n{"d":4');
    const r = readTailFromOffset(file(), 0);
    // The partial last line '{"d":4' (6 bytes, no \n) is excluded.
    expect(r.text).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(r.newOffset).toBe(24); // cursor at the last \n + 1
    // Simulate the next tick: the tool flushes the rest of the line.
    appendFileSync(file(), '}\n');
    const r2 = readTailFromOffset(file(), r.newOffset);
    expect(r2.text).toBe('{"d":4}\n');
    expect(r2.newOffset).toBe(32); // 24 + '{"d":4}\n' (8 bytes)
  });

  test('no newline in the window — ships nothing, cursor unchanged', () => {
    writeFileSync(file(), '{"a":1}\n{"b":2}\n{"c":3}\n{"d":4'); // partial tail, no trailing \n
    // Start past the last complete newline (offset 24).
    const r = readTailFromOffset(file(), 24);
    expect(r.text).toBe('');
    expect(r.newOffset).toBe(24); // unchanged — wait for the next tick
  });

  test('offset at or past EOF — ships nothing', () => {
    writeFileSync(file(), '{"a":1}\n');
    expect(readTailFromOffset(file(), 8).text).toBe('');
    expect(readTailFromOffset(file(), 100).text).toBe('');
  });

  test('missing file — ships nothing, cursor unchanged', () => {
    const r = readTailFromOffset(join(dir, 'nope.jsonl'), 0);
    expect(r.text).toBe('');
    expect(r.newOffset).toBe(0);
  });
});