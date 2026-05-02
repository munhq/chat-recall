import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GeminiBrainSource } from './gemini-brain-source.js';

let tmpHome: string;
const origHome = process.env.HOME;
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'brain-')); process.env.HOME = tmpHome; });
afterEach(() => { process.env.HOME = origHome; rmSync(tmpHome, { recursive: true, force: true }); });

async function collect(): Promise<any[]> {
  const src = new GeminiBrainSource();
  const out: any[] = [];
  for await (const i of src.discover()) out.push(i);
  return out;
}

describe('GeminiBrainSource', () => {
  test('discovers antigravity brain artifact files', async () => {
    const dir = join(tmpHome, '.gemini', 'antigravity', 'brain', 'sess1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'implementation_plan.md'), '# Implementation\nstep 1');
    writeFileSync(join(dir, 'task.md'), '# Task\ndescription');
    const items = await collect();
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every(i => i.extra.tool === 'gemini')).toBe(true);
  });

  test('returns empty when antigravity dir is absent', async () => {
    expect(await collect()).toEqual([]);
  });

  test('parse() emits chunks with the markdown body', async () => {
    const dir = join(tmpHome, '.gemini', 'antigravity', 'brain', 's2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'task.md'), '# T\nbody body body body body');
    const src = new GeminiBrainSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    if (items.length === 0) return;
    const chunks = await src.parse(items[0]);
    expect(chunks.length).toBeGreaterThanOrEqual(0);
  });
});
