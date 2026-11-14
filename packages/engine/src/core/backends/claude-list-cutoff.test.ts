/**
 * A listing with a cutoff must return the sessions that a full listing returns
 * above that cutoff, and must not build a ref for the rest (issue #22). The
 * watch daemon lists on every tick, and building all 12,000 refs to drop the old
 * ones cost about 100 MB each time.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeBackend } from './claude.js';

let root = '';
const saved: Record<string, string | undefined> = {};
const ENV = ['CHAT_RECALL_CLAUDE_HOME', 'CHAT_RECALL_DATA_DIR', 'CLAUDE_DIRS'];

const DAY = 86_400_000;
const NOW = Date.now();

function plant(project: string, sessionId: string, mtimeMs: number): string {
  const dir = join(root, 'claude', 'projects', project);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, uuid: 'u1', sessionId })}\n`);
  utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return dir;
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), 'list-cutoff-'));
  process.env.CHAT_RECALL_CLAUDE_HOME = join(root, 'claude');
  process.env.CHAT_RECALL_DATA_DIR = join(root, 'data');
  delete process.env.CLAUDE_DIRS;
  mkdirSync(join(root, 'claude', 'projects'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('listSessions with a cutoff', () => {
  test('returns the sessions at or above the cutoff and no others', () => {
    plant('-home-user-code-example', '11111111-1111-4111-8111-111111111111', NOW - 10 * DAY);
    plant('-home-user-code-example', '22222222-2222-4222-8222-222222222222', NOW - 2 * DAY);
    plant('-home-user-code-other', '33333333-3333-4333-8333-333333333333', NOW - 60_000);

    const ids = claudeBackend.listSessions({ sinceMs: NOW - 3 * DAY, previews: false }).map((r) => r.rawId).sort();
    expect(ids).toEqual(['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']);
  });

  test('gives the same refs as a full listing filtered by mtime', () => {
    for (let i = 0; i < 12; i++) {
      const id = `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
      plant(i % 2 ? '-home-user-code-example' : '-home-user-code-other', id, NOW - i * DAY);
    }
    const cutoff = NOW - 5 * DAY - 1000;
    const bounded = claudeBackend.listSessions({ sinceMs: cutoff, previews: false });
    const filtered = claudeBackend.listSessions({ previews: false }).filter((r) => r.mtime >= cutoff);
    expect(bounded.map((r) => [r.rawId, r.mtime, r.fullPath])).toEqual(filtered.map((r) => [r.rawId, r.mtime, r.fullPath]));
    expect(bounded.length).toBeGreaterThan(0);
    expect(bounded.length).toBeLessThan(12);
  });

  test('a session covered by sessions-index.json is dropped when its file is old', () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const dir = plant('-home-user-code-example', id, NOW - 20 * DAY);
    writeFileSync(join(dir, 'sessions-index.json'), JSON.stringify({
      entries: [{ sessionId: id, fullPath: join(dir, `${id}.jsonl`), fileMtime: NOW - 20 * DAY, firstPrompt: 'hello', messageCount: 1 }],
    }));
    expect(claudeBackend.listSessions({ sinceMs: NOW - DAY, previews: false })).toEqual([]);
    expect(claudeBackend.listSessions({ previews: false }).map((r) => r.rawId)).toEqual([id]);
  });

  test('a cutoff of 0 lists every session', () => {
    plant('-home-user-code-example', '55555555-5555-4555-8555-555555555555', NOW - 400 * DAY);
    expect(claudeBackend.listSessions({ sinceMs: 0, previews: false })).toHaveLength(1);
  });
});
