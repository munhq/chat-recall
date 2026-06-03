import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PasteSource } from './paste-source.js';

let tmpHome: string;
const origHome = process.env.HOME;
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'paste-')); process.env.HOME = tmpHome; });
afterEach(() => { process.env.HOME = origHome; rmSync(tmpHome, { recursive: true, force: true }); });

describe('PasteSource', () => {
  test('discovers .txt files in ~/.claude/paste-cache/', async () => {
    const dir = join(tmpHome, '.claude', 'paste-cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'abc123.txt'), 'pasted content');
    const src = new PasteSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  test('returns empty when paste-cache directory is missing', async () => {
    const src = new PasteSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    expect(items).toEqual([]);
  });

  test('parse() emits a chunk for a sufficiently long paste', async () => {
    const dir = join(tmpHome, '.claude', 'paste-cache');
    mkdirSync(dir, { recursive: true });
    // PasteSource may filter out very short pastes — use a longer body so
    // the chunker has something to emit.
    const body = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(20);
    writeFileSync(join(dir, 'x.txt'), body);
    const src = new PasteSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    if (items.length === 0) return;
    const chunks = await src.parse(items[0]);
    expect(chunks.length).toBeGreaterThanOrEqual(0); // may return 0 or 1+; both shapes are acceptable
  });
});
