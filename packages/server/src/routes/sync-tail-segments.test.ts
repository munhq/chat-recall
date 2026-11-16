/**
 * An append adds a tail segment and does not rewrite the stored envelope
 * (issue #27). The first append of a session merges into the stored envelope and
 * leaves a marker. Every later append is a segment, and a reader still gets one
 * envelope with the line numbers the old path produced.
 *
 * Runs against an isolated CHAT_RECALL_DATA_DIR (sqlite driver).
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let prevDataDir: string | undefined;

beforeAll(() => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-tail-test-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const SESSION = 'f1f1f1f1-aaaa-4bbb-8ccc-000000000001';
const MTIME = 1750100000000;
const msgs = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({
  line: from + i, role: (from + i) % 2 ? 'user' : 'assistant', content: `message ${from + i} quokkaflux`,
}));

async function harness() {
  const { createControlPlane, createStore } = await import('../imports.js');
  const syncRouter = (await import('./sync.js')).default;
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/sync', syncRouter);
  const cp = await createControlPlane();
  const token = await cp.mintAgentToken('default', 'tail-test');
  await cp.close();
  const post = (body: unknown) => request(app).post('/api/sync').set('authorization', `Bearer ${token}`).send(body as object);
  return { createStore, post };
}

const full = (n: number, o: number) => ({
  session_id: SESSION, tool: 'claude', project_path: '/tmp/tail', mtime: MTIME,
  first_prompt: 'message 1 quokkaflux', from_offset: o,
  envelope: { v: 6, messages: msgs(1, n), subagents: [] },
});
const append = (baseOffset: number, fromOffset: number, baseLine: number, tail: ReturnType<typeof msgs>, mtime: number) => ({
  session_id: SESSION, tool: 'claude', project_path: '/tmp/tail', mtime, append: true,
  base_offset: baseOffset, from_offset: fromOffset, base_line: baseLine,
  envelope: { v: 6, messages: tail.map((m, i) => ({ ...m, line: i + 1 })), subagents: [] },
});

describe('append as a tail segment', () => {
  test('the first append seeds the state from the end of the base and adds a segment', async () => {
    const { createStore, post } = await harness();
    expect((await post({ conversations: [full(4, 1000)] })).body.conv).toBe(1);
    const store0 = await createStore();
    expect((await store0.getSessionTailStates([SESSION])).has(SESSION)).toBe(false);
    await store0.close();
    const res = await post({ conversations: [append(1000, 1500, 4, msgs(5, 2), MTIME + 1000)] });
    expect(res.body.full_resync_needed ?? []).toEqual([]);
    const store = await createStore();
    const states = await store.getSessionTailStates([SESSION]);
    expect(states.get(SESSION)).toEqual({ seq: 1, o: 1500, lastLine: 6 });
    const merged = JSON.parse((await store.getCachedContentStale(SESSION, 'session'))!.content);
    expect(merged.messages.map((m: { line: number }) => m.line)).toEqual([1, 2, 3, 4, 5, 6]);
    await store.close();
  });

  test('a later append is a segment, and a reader gets one envelope with the same line numbers', async () => {
    const { createStore, post } = await harness();
    const res = await post({ conversations: [append(1500, 1800, 6, msgs(7, 3), MTIME + 2000)] });
    expect(res.body.full_resync_needed ?? []).toEqual([]);
    const store = await createStore();
    expect((await store.getSessionTailStates([SESSION])).get(SESSION)).toEqual({ seq: 2, o: 1800, lastLine: 9 });
    const merged = JSON.parse((await store.getCachedContentStale(SESSION, 'session'))!.content);
    expect(merged.messages.map((m: { line: number }) => m.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(merged.o).toBe(1800);
    expect(merged.messages[8].content).toBe('message 9 quokkaflux');
    await store.close();
  });

  test('an append that does not start where the stored tail ends asks for a full sync', async () => {
    const { createStore, post } = await harness();
    const res = await post({ conversations: [append(1234, 1300, 9, msgs(10, 1), MTIME + 3000)] });
    expect(res.body.full_resync_needed).toEqual([SESSION]);
    const store = await createStore();
    expect((await store.getSessionTailStates([SESSION])).get(SESSION)?.seq).toBe(2);
    await store.close();
  });

  test('a full sync replaces the base and drops the segments', async () => {
    const { createStore, post } = await harness();
    expect((await post({ conversations: [full(12, 2000)].map((c) => ({ ...c, mtime: MTIME + 4000 })) })).body.conv).toBe(1);
    const store = await createStore();
    expect((await store.getSessionTailStates([SESSION])).has(SESSION)).toBe(false);
    const env = JSON.parse((await store.getCachedContentStale(SESSION, 'session'))!.content);
    expect(env.messages).toHaveLength(12);
    await store.close();
  });

  test('a purge removes the segments with the session', async () => {
    const { createStore, post } = await harness();
    await post({ conversations: [append(2000, 2100, 12, msgs(13, 1), MTIME + 5000)] });
    await post({ conversations: [append(2100, 2200, 13, msgs(14, 1), MTIME + 6000)] });
    const store = await createStore();
    expect((await store.getSessionTailStates([SESSION])).get(SESSION)?.seq).toBe(2);
    expect((await post({ tombstones: [{ session_id: SESSION }] })).body.dead).toBe(1);
    expect((await store.getSessionTailStates([SESSION])).has(SESSION)).toBe(false);
    expect(await store.getCachedContentStale(SESSION, 'session')).toBeNull();
    await store.close();
  });
});
