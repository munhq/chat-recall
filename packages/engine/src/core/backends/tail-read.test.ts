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

  test('maxBytes bounds one read, so a large file ships as a sequence of chunks', () => {
    writeFileSync(file(), '{"a":1}\n{"b":2}\n{"c":3}\n');
    const first = readTailFromOffset(file(), 0, 12);
    expect(first).toEqual({ text: '{"a":1}\n', newOffset: 8 });
    const second = readTailFromOffset(file(), first.newOffset, 12);
    expect(second).toEqual({ text: '{"b":2}\n', newOffset: 16 });
    const third = readTailFromOffset(file(), second.newOffset, 12);
    expect(third).toEqual({ text: '{"c":3}\n', newOffset: 24 });
    expect(readTailFromOffset(file(), third.newOffset, 12)).toEqual({ text: '', newOffset: 24 });
  });

  test('a line longer than maxBytes is skipped, so the cursor never stops there', () => {
    const giant = `{"img":"${'x'.repeat(40)}"}`;           // 50 bytes, no newline inside
    writeFileSync(file(), `${giant}\n{"b":2}\n`);
    const r = readTailFromOffset(file(), 0, 16);
    expect(r.text).toBe('');
    expect(r.newOffset).toBe(giant.length + 1);
    expect(r.skippedBytes).toBe(giant.length + 1);
    expect(readTailFromOffset(file(), r.newOffset, 16)).toEqual({ text: '{"b":2}\n', newOffset: giant.length + 9 });
  });

  test('a long line still being written at the end of the file is not skipped', () => {
    writeFileSync(file(), `{"a":1}\n{"img":"${'x'.repeat(40)}`);
    expect(readTailFromOffset(file(), 8, 16)).toEqual({ text: '', newOffset: 8 });
  });
});