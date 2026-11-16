/**
 * A session that holds only a `/clear` has no message a person can read, so its
 * build gives nothing to ship. The build says so with `onEmpty`, and the walk
 * records the verdict in the ledger, so the ledger check does not count the
 * session as missing from the server.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STUB_ID = '44444444-5555-6666-7777-888888888888';
const REAL_ID = '55555555-6666-7777-8888-999999999999';
const PROJECT = '/home/user/code/example';

let dataDir = '';
let claudeHome = '';
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cr-empty-data-'));
  claudeHome = mkdtempSync(join(tmpdir(), 'cr-empty-home-'));
  const env: Record<string, string> = { CHAT_RECALL_DATA_DIR: dataDir, CHAT_RECALL_CLAUDE_HOME: claudeHome };
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  vi.resetModules();
  const dir = join(claudeHome, 'projects', '-home-user-code-example');
  mkdirSync(dir, { recursive: true });
  const rec = (o: Record<string, unknown>) => JSON.stringify({ cwd: PROJECT, timestamp: '2026-01-01T00:00:00.000Z', ...o });
  writeFileSync(join(dir, `${STUB_ID}.jsonl`), [
    rec({ type: 'user', sessionId: STUB_ID, message: { role: 'user', content: '<local-command-caveat>Caveat: run directly</local-command-caveat>' } }),
    rec({ type: 'user', sessionId: STUB_ID, message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
  ].join('\n') + '\n');
  writeFileSync(join(dir, `${REAL_ID}.jsonl`), [
    rec({ type: 'user', sessionId: REAL_ID, message: { role: 'user', content: 'fix the parser' } }),
    rec({ type: 'assistant', sessionId: REAL_ID, message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] } }),
  ].join('\n') + '\n');
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(claudeHome, { recursive: true, force: true });
});

async function buildOf(id: string, onEmpty?: () => void) {
  const { buildConversationSync } = await import('./sync-client.js');
  const { claudeBackend } = await import('@chat-recall/engine/core/backends/claude.js');
  const loc = claudeBackend.findSession(id)!;
  const ref = {
    toolId: 'claude' as const, rawId: id, prefixedId: id,
    projectPath: loc.projectPath, projectDir: loc.projectDir, fullPath: loc.path,
    created: '', modified: '', mtime: loc.mtime, firstPrompt: '', messageCount: 0,
  };
  return buildConversationSync(ref as never, Math.floor(loc.mtime), { includeRaw: false, includeMeta: false, onEmpty });
}

describe('the verdict of an empty session', () => {
  test('a session of one /clear builds to null and calls onEmpty', async () => {
    let called = 0;
    expect(await buildOf(STUB_ID, () => { called++; })).toBeNull();
    expect(called).toBe(1);
  });

  test('a session with a conversation builds and does not call onEmpty', async () => {
    let called = 0;
    const built = await buildOf(REAL_ID, () => { called++; });
    expect(built).not.toBeNull();
    expect(called).toBe(0);
  });
});
