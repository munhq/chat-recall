import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HistorySource } from './history-source.js';

let tmpHome: string;
const origHome = process.env.HOME;
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'hist-')); process.env.HOME = tmpHome; });
afterEach(() => { process.env.HOME = origHome; rmSync(tmpHome, { recursive: true, force: true }); });

describe('HistorySource', () => {
  test('reads ~/.claude/history.jsonl line by line', async () => {
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
    const lines = [
      { display: 'git status', timestamp: 100, project: '/p1' },
      { display: 'npm test',   timestamp: 200, project: '/p2' },
    ];
    writeFileSync(
      join(tmpHome, '.claude', 'history.jsonl'),
      lines.map(l => JSON.stringify(l)).join('\n') + '\n',
    );
    const src = new HistorySource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  test('returns nothing when history.jsonl is absent', async () => {
    const src = new HistorySource();
    const out: any[] = [];
    for await (const i of src.discover()) out.push(i);
    expect(out).toEqual([]);
  });
});
