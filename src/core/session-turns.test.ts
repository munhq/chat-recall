import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractTurns } from './session-turns.js';

let tmpHome: string;
const origHome = process.env.HOME;
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'turns-')); process.env.HOME = tmpHome; });
afterEach(() => { process.env.HOME = origHome; rmSync(tmpHome, { recursive: true, force: true }); });

function writeSession(uuid: string, lines: object[]) {
  const dir = join(tmpHome, '.claude', 'projects', '-x');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${uuid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

describe('extractTurns', () => {
  test('returns found=false for unknown sessions', () => {
    const r = extractTurns('11111111-2222-4333-8444-555555555555');
    expect(r.found).toBe(false);
    expect(r.turns).toEqual([]);
  });

  test('returns found=false for non-Claude tool prefixes', () => {
    const r = extractTurns('gemini_xyz');
    expect(r.found).toBe(false);
  });

  test('extracts user + assistant text + tool_use turns', () => {
    const sid = '22222222-2222-4333-8444-555555555555';
    writeSession(sid, [
      { type: 'user', timestamp: '2026-05-01T10:00:00Z', message: { content: 'help' } },
      { type: 'assistant', timestamp: '2026-05-01T10:00:01Z', message: { content: [{ type: 'text', text: 'sure' }] } },
      { type: 'assistant', timestamp: '2026-05-01T10:00:02Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
    ]);
    const r = extractTurns(sid);
    expect(r.found).toBe(true);
    expect(r.turns.length).toBeGreaterThanOrEqual(2);
    const kinds = r.turns.map(t => t.kind);
    expect(kinds).toEqual(expect.arrayContaining(['user', 'assistant_text', 'tool_use']));
  });

  test('honors maxTurns option', () => {
    const sid = '33333333-2222-4333-8444-555555555555';
    const lines: object[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push({ type: 'user', timestamp: '2026-05-01T10:00:00Z', message: { content: `m${i}` } });
    }
    writeSession(sid, lines);
    const r = extractTurns(sid, { maxTurns: 5 });
    expect(r.turns.length).toBeLessThanOrEqual(5);
  });
});
