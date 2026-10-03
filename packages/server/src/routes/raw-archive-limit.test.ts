/**
 * The server never unpacks an archive larger than RAW_PARSE_MAX_BYTES whole.
 *
 * Unpacking holds the text, the parsed container and the parsed transcript at
 * once, in a pod with 512 MiB. Archives uploaded in parts can be far larger
 * than the 36 MB the server held before, and the self-heal sweep reads every
 * archive when a pod starts.
 *
 * The archive here is small; its recorded size is what the guards read.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ID = 'too-large-0001';
let dataDir: string;
let prev: string | undefined;

beforeAll(async () => {
  prev = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-raw-limit-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  const { createStore, buildRawContainer, gzipContainer, RAW_PARSE_MAX_BYTES } = await import('../imports.js');
  const store = await createStore();
  const line = JSON.stringify({ type: 'user', uuid: 'u0', message: { role: 'user', content: 'hello' } }) + '\n';
  const { gz } = gzipContainer(buildRawContainer({ tool: 'claude', mtime: 1000, files: [{ name: `${ID}.jsonl`, bytes: Buffer.from(line) }] }));
  await store.putRawSession(ID, 'claude', 1000, gz, RAW_PARSE_MAX_BYTES + 1);
  await store.setItem({
    id: ID, sourceType: 'session', title: 'hello', projectPath: '/home/user/code/example', contentPreview: 'hello',
    filePath: '', mtime: 1000, extra: { tool: 'claude', synced: true },
  } as Parameters<typeof store.setItem>[0]);
  await store.close();
});
afterAll(() => {
  if (prev === undefined) delete process.env.CHAT_RECALL_DATA_DIR; else process.env.CHAT_RECALL_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('an archive larger than the server unpacks', () => {
  test('self-heal skips it and says why', async () => {
    const { createStore } = await import('../imports.js');
    const { healSessionFromArchive } = await import('../services/self-heal.js');
    const store = await createStore();
    try {
      const r = await healSessionFromArchive(store, ID);
      expect(r).toMatchObject({ damaged: false, healed: false, reason: 'too-large' });
    } finally { await store.close(); }
  });

  test('GET /raw-archive?count=1 returns its size, and no count', async () => {
    const app = express();
    app.use('/api/conversations', (await import('./conversations.js')).default);
    const r = await request(app).get(`/api/conversations/${ID}/raw-archive?count=1`);
    expect(r.status).toBe(200);
    expect(r.body.messages).toBeNull();
    expect(r.body.gzB64).toBeUndefined();
  });

  test('the records listing refuses it with the reason', async () => {
    const { RAW_PARSE_MAX_BYTES } = await import('../imports.js');
    const app = express();
    app.use('/api/status', (await import('./status.js')).default);
    const r = await request(app).get(`/api/status/archives/${ID}/records`);
    expect(r.status).toBe(413);
    expect(r.body.error).toContain(String(RAW_PARSE_MAX_BYTES));
  });
});
