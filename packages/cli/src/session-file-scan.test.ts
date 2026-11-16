/**
 * The chunked scans give the findings, with the line numbers, that one scan of
 * the joined text gives, whatever the size of a piece.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTextForFindings } from '@chat-recall/engine/core/secret-redactor.js';
import { readLinePieces, scanSessionGroupsChunked, scanLinesChunked, sessionGroupsBytes } from './session-file-scan.js';

const SECRET = 'AKIAIOSFODNN7EXAMPLE';
let dir = '';

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cr-file-scan-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function lines(n: number, secretAt: number[], tag: string): string[] {
  return Array.from({ length: n }, (_, i) => (secretAt.includes(i) ? `{"text":"key ${SECRET} ${tag}${i}"}` : `{"text":"line ${tag}${i} ${'w'.repeat(i % 37)}"}`));
}

const rule = (f: { rule: string; line: number }) => `${f.rule}@${f.line}`;

/** What one scan of the container text gives: the files joined with one newline. */
function wholeScan(texts: string[]): string[] {
  return scanTextForFindings(texts.join('\n')).map(rule).sort();
}

describe('readLinePieces', () => {
  test('cuts at line ends and loses no byte, for any piece size', async () => {
    const text = lines(300, [], 'a').join('\n') + '\n' + 'tail without newline';
    const file = join(dir, 'f.jsonl');
    writeFileSync(file, text);
    for (const size of [7, 64, 1000, 1 << 20]) {
      let joined = '';
      let newlines = 0;
      for await (const p of readLinePieces(file, size)) { joined += p.text; newlines += p.newlines; }
      expect(joined).toBe(text);
      expect(newlines).toBe(text.split('\n').length - 1);
    }
  });

  test('keeps a multi-byte character whole when a piece ends inside it', async () => {
    const text = ('é'.repeat(50) + '\n').repeat(40);
    const file = join(dir, 'u.jsonl');
    writeFileSync(file, text);
    let joined = '';
    for await (const p of readLinePieces(file, 33)) joined += p.text;
    expect(joined).toBe(text);
  });
});

describe('scanSessionGroupsChunked', () => {
  test('gives the findings and the line numbers of the scan of the joined files', async () => {
    const main = lines(120, [5], 'm').join('\n') + '\n';
    const subA = lines(400, [0, 399], 'a').join('\n');            // no newline at the end
    const empty = '';
    const subB = lines(90, [44], 'b').join('\n') + '\n';
    const paths = ['main.jsonl', 'a.jsonl', 'empty.jsonl', 'b.jsonl'].map((n) => join(dir, n));
    [main, subA, empty, subB].forEach((t, i) => writeFileSync(paths[i], t));
    const groups = paths.map((p, i) => ({ name: i === 0 ? 'main' : `subagents/${i}`, paths: [p] }));

    const expected = wholeScan([main, subA, subB]);
    expect(expected.length).toBe(4);
    for (const size of [50, 500, 4096, 1 << 20]) {
      const got = (await scanSessionGroupsChunked('s1', groups, undefined, size)).map(rule).sort();
      expect(got).toEqual(expected);
    }
    expect(sessionGroupsBytes(groups)).toBe(main.length + subA.length + subB.length);
  });
});

describe('scanLinesChunked', () => {
  test('gives the findings and the line numbers of the scan of the joined lines', () => {
    const rows = lines(500, [0, 250, 499], 'r').map((l) => `${l}\n`);
    const expected = wholeScan([rows.join('')]);
    expect(expected.length).toBe(3);
    for (const size of [1, 300, 5000, 1 << 20]) {
      expect(scanLinesChunked('s2', rows, undefined, size).map(rule).sort()).toEqual(expected);
    }
  });

  test('reads a generator one line at a time', () => {
    let produced = 0;
    function* gen(): Generator<string> {
      for (let i = 0; i < 1000; i++) { produced++; yield `{"n":${i}}\n`; }
    }
    expect(scanLinesChunked('s3', gen(), undefined, 100)).toEqual([]);
    expect(produced).toBe(1000);
  });
});
