/**
 * A transcript over the full-build ceiling that is split across two Claude
 * homes ships in chunks, and both copies arrive.
 *
 * Session 8de13d0a had 31 MB in ~/.claude and 2 MB in ~/.claude-work, after a
 * resume under the second profile. The chunked path reads the transcript with
 * readFromOffset, which gave no text for a session in two homes: each sync
 * shipped nothing, and the server stayed three hours behind the machine.
 *
 * Real client builders, the real /api/sync route: the head chunk goes as the
 * FULL sync, every later chunk as an append, and the stored conversation must
 * hold every message of both copies, numbered as the copies joined end to end.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = '33333333-4444-5555-6666-777777777777';
const PROJECT = '/home/user/code/example';
const PROJECT_DIR = '-home-user-code-example';

let home: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'cr-chunked-split-'));
  const env: Record<string, string | undefined> = {
    HOME: home, USERPROFILE: home,
    CHAT_RECALL_DATA_DIR: join(home, '.chat-recall'),
    CHAT_RECALL_FULL_BUILD_MAX_MB: '8',
    // A home override turns off the discovery of sibling homes.
    CHAT_RECALL_CLAUDE_HOME: undefined, CLAUDE_DIRS: undefined,
  };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true });
});

/** `count` turns from turn `first` on, about 1.9 KB each. */
function writeCopy(claudeHome: string, first: number, count: number): void {
  const dir = join(home, claudeHome, 'projects', PROJECT_DIR);
  mkdirSync(dir, { recursive: true });
  const pad = 'lorem ipsum dolor sit amet '.repeat(70);
  const lines: string[] = [];
  for (let i = first; i < first + count; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const text = `turn ${i} ${pad}`;
    lines.push(JSON.stringify({
      type: role, uuid: `u-${i}`, timestamp: new Date(1750000000000 + i * 1000).toISOString(),
      cwd: PROJECT, sessionId: SESSION_ID,
      message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
    }));
  }
  writeFileSync(join(dir, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n');
}

describe('a transcript in two homes over the full-build ceiling ships in chunks', () => {
  test('head plus appends deliver every message of both copies', async () => {
    const PRIMARY_TURNS = 5_000;   // ~9.5 MB
    const LIVE_TURNS = 1_500;      // ~2.9 MB
    writeCopy('.claude', 0, PRIMARY_TURNS);
    writeCopy('.claude-work', PRIMARY_TURNS, LIVE_TURNS);

    const { buildConversationSync, buildConversationTail, FULL_BUILD_MAX_BYTES, SYNC_CHUNK_BYTES } =
      await import('../../../cli/src/sync-client.js');
    const { claudeBackend } = await import('@chat-recall/engine/core/backends/claude.js');
    const { createControlPlane, createStore } = await import('../imports.js');
    const syncRouter = (await import('./sync.js')).default;

    expect(claudeBackend.spansMultipleSources(SESSION_ID)).toBe(true);
    const size = claudeBackend.fileSize(SESSION_ID);
    expect(size).toBeGreaterThan(FULL_BUILD_MAX_BYTES);

    const loc = claudeBackend.findSession(SESSION_ID)!;
    const ref = {
      toolId: 'claude' as const, rawId: SESSION_ID, prefixedId: SESSION_ID,
      projectPath: loc.projectPath, projectDir: loc.projectDir, fullPath: loc.path,
      created: '', modified: '', mtime: loc.mtime, firstPrompt: '', messageCount: 0,
    };

    const app = express();
    app.use(express.json({ limit: '64mb' }));
    app.use('/api/sync', syncRouter);
    const cp = await createControlPlane();
    const token = await cp.mintAgentToken('default', 'chunked-split-test');
    await cp.close();
    const post = (conv: Record<string, unknown>) => request(app)
      .post('/api/sync').set('authorization', `Bearer ${token}`).send({ conversations: [conv] });

    const built = await buildConversationSync(ref as any, Math.floor(loc.mtime), { includeRaw: true, includeMeta: true });
    expect(built && !('unchanged' in built)).toBe(true);
    const head = (built as any).conv;
    expect(head.chunked).toBe(true);
    expect(head.from_offset).toBeGreaterThan(0);
    expect(head.from_offset).toBeLessThanOrEqual(SYNC_CHUNK_BYTES);
    expect((await post(head)).status).toBe(200);

    let offset = head.from_offset as number;
    let appends = 0;
    while (offset < size) {
      const tail = await buildConversationTail(ref as any, offset);
      expect(tail).not.toBeNull();
      const r = await post(tail!.conv);
      expect(r.status).toBe(200);
      expect(r.body.full_resync_needed ?? []).toEqual([]);
      expect(tail!.newOffset).toBeGreaterThan(offset);
      offset = tail!.newOffset;
      appends++;
      expect(appends).toBeLessThan(20);
    }
    expect(offset).toBe(size);

    const store = await createStore();
    const stored = JSON.parse((await store.getCachedContentStale(SESSION_ID, 'session'))!.content);
    await store.close();
    expect(stored.o).toBe(size);
    const total = PRIMARY_TURNS + LIVE_TURNS;
    expect(stored.messages.length).toBe(total);
    // Line n of the joined copies holds turn n - 1.
    expect(stored.messages.map((m: any) => m.line)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(JSON.stringify(stored.messages[total - 1])).toContain(`turn ${total - 1} `);
  }, 240_000);
});
