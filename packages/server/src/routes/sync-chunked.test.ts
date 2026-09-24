/**
 * A transcript too large for the in-memory build ships in chunks, and all of
 * it arrives.
 *
 * Before this, a session over FULL_BUILD_MAX_BYTES shipped only its newest
 * 16 MB and set the cursor to the end of the file, so its head never reached
 * the server. Under that ceiling the build held the transcript about 18 times
 * over: a 42 MB session raised the collector's RSS by 770 MB under a 1 GB
 * MemoryHigh, and systemd-oomd killed it.
 *
 * Real client builders, the real /api/sync route: the head chunk goes as the
 * FULL sync, every later chunk as an append, and the stored conversation must
 * equal what the local parser reads from the whole file.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = '22222222-3333-4444-5555-666666666666';
const SECRET = 'AKIAIOSFODNN7EXAMPLE';
const PROJECT = '/home/user/code/example';

let dataDir: string;
let claudeHome: string;
const saved: Record<string, string | undefined> = {};
const ENV = {
  CHAT_RECALL_DATA_DIR: '', CHAT_RECALL_CLAUDE_HOME: '', CHAT_RECALL_FULL_BUILD_MAX_MB: '8',
};

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cr-chunked-data-'));
  claudeHome = mkdtempSync(join(tmpdir(), 'cr-chunked-home-'));
  ENV.CHAT_RECALL_DATA_DIR = dataDir;
  ENV.CHAT_RECALL_CLAUDE_HOME = claudeHome;
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(claudeHome, { recursive: true, force: true });
});

/** ~20 MB of turns, a secret on one line in the middle, and one 9 MB line
 *  (a snapshot record, not a message) longer than a chunk. */
function writeTranscript(): { path: string; secretLine: number } {
  const dir = join(claudeHome, 'projects', '-home-user-code-example');
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  const ts = (i: number) => new Date(1750000000000 + i * 1000).toISOString();
  const pad = 'lorem ipsum dolor sit amet '.repeat(70);   // ~1.9 KB per turn
  let secretLine = 0;
  for (let i = 0; i < 10_000; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    let text = `turn ${i} ${pad}`;
    if (i === 5_000) { text = `turn ${i} the key is ${SECRET}`; secretLine = lines.length + 1; }
    lines.push(JSON.stringify({
      type: role, timestamp: ts(i), cwd: PROJECT, sessionId: SESSION_ID,
      message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
    }));
    if (i === 7_000) {
      lines.push(JSON.stringify({ type: 'file-history-snapshot', snapshot: { blob: 'x'.repeat(9 * 1024 * 1024) } }));
    }
  }
  const path = join(dir, `${SESSION_ID}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n');
  return { path, secretLine };
}

describe('a transcript over the full-build ceiling ships in chunks', () => {
  test('head plus appends deliver every message, find the secret, and skip the giant line', async () => {
    const { path, secretLine } = writeTranscript();
    const size = statSync(path).size;

    const { buildConversationSync, buildConversationTail, scanTranscriptFindingsChunked, FULL_BUILD_MAX_BYTES, SYNC_CHUNK_BYTES } =
      await import('../../../cli/src/sync-client.js');
    const { claudeBackend } = await import('@chat-recall/engine/core/backends/claude.js');
    const { createControlPlane, createStore } = await import('../imports.js');
    const { getConversation } = await import('../services/parser.js');
    const syncRouter = (await import('./sync.js')).default;

    expect(size).toBeGreaterThan(FULL_BUILD_MAX_BYTES);
    const local = await getConversation(path);

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
    const token = await cp.mintAgentToken('default', 'chunked-test');
    await cp.close();
    const post = (conv: Record<string, unknown>) => request(app)
      .post('/api/sync').set('authorization', `Bearer ${token}`).send({ conversations: [conv] });

    // The head: a FULL sync that ends well before the end of the file.
    const built = await buildConversationSync(ref as any, Math.floor(loc.mtime), { includeRaw: true, includeMeta: true });
    expect(built && !('unchanged' in built)).toBe(true);
    const head = (built as any).conv;
    expect(head.chunked).toBe(true);
    expect(head.meta?.truncated).toBeUndefined();
    expect(head.from_offset).toBeGreaterThan(0);
    expect(head.from_offset).toBeLessThanOrEqual(SYNC_CHUNK_BYTES);
    // The secret is in a chunk the head does not carry; the head's findings
    // come from the whole file.
    expect((built as any).findings.some((f: any) => f.line === secretLine)).toBe(true);
    const r0 = await post(head);
    expect(r0.status).toBe(200);
    expect(r0.body.shrink_guarded ?? []).toEqual([]);

    // The rest: appends from the head's end until the file is covered.
    let offset = head.from_offset as number;
    let appends = 0;
    let skippedGiantLine = false;
    while (offset < size) {
      const tail = await buildConversationTail(ref as any, offset);
      expect(tail).not.toBeNull();
      if (tail!.bytes === 0) skippedGiantLine = true;
      const r = await post(tail!.conv);
      expect(r.status).toBe(200);
      expect(r.body.full_resync_needed ?? []).toEqual([]);
      expect(tail!.newOffset).toBeGreaterThan(offset);
      offset = tail!.newOffset;
      appends++;
      expect(appends).toBeLessThan(20);
    }
    expect(offset).toBe(size);
    expect(skippedGiantLine).toBe(true);

    const store = await createStore();
    const stored = JSON.parse((await store.getCachedContentStale(SESSION_ID, 'session'))!.content);
    expect(stored.o).toBe(size);
    expect(stored.messages.length).toBe(local.length);
    expect(JSON.stringify(stored)).not.toContain(SECRET);

    // Findings scanned chunk by chunk carry the same absolute line number.
    const chunked = await scanTranscriptFindingsChunked(ref as any);
    expect(chunked.map((f) => f.line)).toContain(secretLine);

    // The server already holds the whole conversation. A chunked head is
    // smaller, the shrink guard keeps the stored copy, and the response says
    // where that copy is synced through.
    const again = await post(head);
    expect(again.status).toBe(200);
    expect(again.body.shrink_guarded).toEqual([{ session_id: SESSION_ID, o: size }]);
    await store.close();
  }, 120_000);
});
