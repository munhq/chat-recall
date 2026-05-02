import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractTurnsAny,
  replaySessionAny,
  computeOutcomeAny,
  getSessionCommitsAny,
} from './session-multi-tool.js';

let tmpHome: string;
const origHome = process.env.HOME;
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'mt-')); process.env.HOME = tmpHome; });
afterEach(() => { process.env.HOME = origHome; rmSync(tmpHome, { recursive: true, force: true }); });

function writeClaudeSession(uuid: string, lines: object[]) {
  const dir = join(tmpHome, '.claude', 'projects', '-x');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${uuid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

describe('extractTurnsAny', () => {
  test('returns found=false for an unknown session id', () => {
    const r = extractTurnsAny('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(r.found).toBe(false);
  });

  test('dispatches to the Claude path for bare-uuid ids', () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    writeClaudeSession(sid, [
      { type: 'user', timestamp: '2026-05-01T10:00:00Z', message: { content: 'hi' } },
      { type: 'assistant', timestamp: '2026-05-01T10:00:01Z', message: { content: [{ type: 'text', text: 'hello' }] } },
    ]);
    const r = extractTurnsAny(sid);
    expect(r.found).toBe(true);
    expect(r.turns.length).toBeGreaterThanOrEqual(1);
  });

  test('returns found=false for unknown gemini/opencode/codex prefixes (no fixture)', () => {
    expect(extractTurnsAny('gemini_xyz').found).toBe(false);
    expect(extractTurnsAny('opencode_xyz').found).toBe(false);
    expect(extractTurnsAny('codex_xyz').found).toBe(false);
  });
});

describe('replaySessionAny', () => {
  test('returns empty result for unknown session', () => {
    const r = replaySessionAny('not-a-session');
    expect(r.found).toBe(false);
  });
});

describe('computeOutcomeAny', () => {
  test('returns shape with status field for unknown session', () => {
    const r = computeOutcomeAny('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(r).toHaveProperty('status');
  });
});

describe('getSessionCommitsAny', () => {
  test('returns a SessionCommitsResult shape for unknown session', () => {
    const r = getSessionCommitsAny('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    // The exact field names depend on the result shape (commits or commitsByRepo).
    // Just check we got an object and it didn't throw.
    expect(typeof r).toBe('object');
    expect(r).not.toBeNull();
  });
});
