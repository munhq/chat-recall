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
  // The collector sets `final` on every tail: it says the tail ends the file.
  final: true,
  envelope: { v: 6, messages: tail.map((m, i) => ({ ...m, line: i + 1 })), subagents: [] },
});

describe('append as a tail segment', () => {
  test('the first append after a full sync adds a segment and reads no envelope', async () => {
    const { createStore, post } = await harness();
    expect((await post({ conversations: [full(4, 1000)] })).body.conv).toBe(1);
    // The full sync wrote the state with the base, so the append has nothing to seed.
    const store0 = await createStore();
    expect((await store0.getSessionTailStates([SESSION])).get(SESSION)).toEqual({ seq: 0, o: 1000, lastLine: 4, bytes: expect.any(Number) });
    await store0.close();
    const res = await post({ conversations: [append(1000, 1500, 4, msgs(5, 2), MTIME + 1000)] });
    expect(res.body.full_resync_needed ?? []).toEqual([]);
    const store = await createStore();
    const states = await store.getSessionTailStates([SESSION]);
    expect(states.get(SESSION)).toEqual({ seq: 1, o: 1500, lastLine: 6, bytes: expect.any(Number) });
    const merged = JSON.parse((await store.getCachedContentStale(SESSION, 'session'))!.content);
    expect(merged.messages.map((m: { line: number }) => m.line)).toEqual([1, 2, 3, 4, 5, 6]);
    await store.close();
  });

  test('a later append goes into the open segment, and a reader gets one envelope with the same line numbers', async () => {
    const { createStore, post } = await harness();
    const res = await post({ conversations: [append(1500, 1800, 6, msgs(7, 3), MTIME + 2000)] });
    expect(res.body.full_resync_needed ?? []).toEqual([]);
    const store = await createStore();
    expect((await store.getSessionTailStates([SESSION])).get(SESSION)).toEqual({ seq: 1, o: 1800, lastLine: 9, bytes: expect.any(Number) });
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
    expect((await store.getSessionTailStates([SESSION])).get(SESSION)?.seq).toBe(1);
    await store.close();
  });

  test('a full sync replaces the base, drops the segments and writes the new state', async () => {
    const { createStore, post } = await harness();
    expect((await post({ conversations: [full(12, 2000)].map((c) => ({ ...c, mtime: MTIME + 4000 })) })).body.conv).toBe(1);
    const store = await createStore();
    // The old segments are gone and the new base carries its own state.
    expect((await store.getSessionTailStates([SESSION])).get(SESSION)).toEqual({ seq: 0, o: 2000, lastLine: 12, bytes: expect.any(Number) });
    expect(await store.getSessionTailBody(SESSION, 1)).toBeNull();
    const env = JSON.parse((await store.getCachedContentStale(SESSION, 'session'))!.content);
    expect(env.messages).toHaveLength(12);
    await store.close();
  });

  test('a purge removes the segments with the session', async () => {
    const { createStore, post } = await harness();
    await post({ conversations: [append(2000, 2100, 12, msgs(13, 1), MTIME + 5000)] });
    await post({ conversations: [append(2100, 2200, 13, msgs(14, 1), MTIME + 6000)] });
    const store = await createStore();
    expect((await store.getSessionTailStates([SESSION])).get(SESSION)?.seq).toBe(1);
    expect((await post({ tombstones: [{ session_id: SESSION }] })).body.dead).toBe(1);
    expect((await store.getSessionTailStates([SESSION])).has(SESSION)).toBe(false);
    expect(await store.getCachedContentStale(SESSION, 'session')).toBeNull();
    await store.close();
  });

  test('a full sync of an append-only session writes its state, so the first append seeds nothing', async () => {
    const { createStore, post } = await harness();
    expect((await post({ conversations: [{ ...full(3, 700), session_id: 'f1f1f1f1-aaaa-4bbb-8ccc-000000000002' }] })).body.conv).toBe(1);
    const store = await createStore();
    expect((await store.getSessionTailStates(['f1f1f1f1-aaaa-4bbb-8ccc-000000000002'])).get('f1f1f1f1-aaaa-4bbb-8ccc-000000000002'))
      .toEqual({ seq: 0, o: 700, lastLine: 3, bytes: expect.any(Number) });
    await store.close();
  });

  test('many small appends keep one open segment, and a compaction merges it into the base', async () => {
    const { createStore, post } = await harness();
    const id = 'f1f1f1f1-aaaa-4bbb-8ccc-000000000003';
    const mk = (o: number, n: number) => ({ ...full(n, o), session_id: id });
    expect((await post({ conversations: [mk(100, 2)] })).body.conv).toBe(1);
    let line = 2;
    let offset = 100;
    for (let i = 0; i < 6; i++) {
      const res = await post({ conversations: [{ ...append(offset, offset + 10, line, msgs(line + 1, 1), MTIME + 7000 + i), session_id: id }] });
      expect(res.body.full_resync_needed ?? []).toEqual([]);
      line += 1; offset += 10;
    }
    const store = await createStore();
    const state = (await store.getSessionTailStates([id])).get(id)!;
    expect(state.seq).toBe(1);                       // six appends, one segment
    expect(state.o).toBe(160);
    expect(await store.getSessionTailBody(id, 1)).toMatchObject({ lastLine: 8, o: 160 });
    expect(await store.getSessionTailBody(id, 2)).toBeNull();

    const page = await store.getSessionPage(id, { offset: 1, limit: 3 });
    expect(page?.total).toBe(8);
    expect(page?.messages.map((m) => (m as { line: number }).line)).toEqual([2, 3, 4]);
    expect(await store.getSessionPage(id, { offset: 0, limit: 0, minMtime: MTIME + 99999999 })).toBeNull();
    const before = JSON.parse((await store.getCachedContentStale(id, 'session'))!.content);
    const compacted = await store.compactSessionTails(id);
    expect(compacted).toEqual({ segments: 2, messages: 8 });
    const after = JSON.parse((await store.getCachedContentStale(id, 'session'))!.content);
    expect(after.messages).toEqual(before.messages);
    expect(after.o).toBe(160);
    expect((await store.getSessionTailStates([id])).get(id)).toEqual({ seq: 0, o: 160, lastLine: 8, bytes: expect.any(Number) });
    expect(await store.getSessionTailBody(id, 1)).toBeNull();
    expect(await store.compactSessionTails(id)).toBeNull();   // nothing left to merge
    // The next append is a segment again, from the state the compaction left.
    const res = await post({ conversations: [{ ...append(160, 170, 8, msgs(9, 1), MTIME + 9000), session_id: id }] });
    expect(res.body.full_resync_needed ?? []).toEqual([]);
    expect(JSON.parse((await store.getCachedContentStale(id, 'session'))!.content).messages).toHaveLength(9);
    await store.close();
  });

  test('a session stored before the state existed is seeded from the end of its base on the first append', async () => {
    const { createStore, post } = await harness();
    const id = 'f1f1f1f1-aaaa-4bbb-8ccc-000000000004';
    const store = await createStore();
    await store.setCachedContent(id, 'session', MTIME, JSON.stringify({ v: 6, messages: msgs(1, 5), subagents: [], o: 500 }));
    expect((await store.getSessionTailStates([id])).has(id)).toBe(false);
    const res = await post({ conversations: [{ ...append(500, 560, 5, msgs(6, 2), MTIME + 1000), session_id: id }] });
    expect(res.body.full_resync_needed ?? []).toEqual([]);
    expect((await store.getSessionTailStates([id])).get(id)).toEqual({ seq: 1, o: 560, lastLine: 7, bytes: expect.any(Number) });
    const merged = JSON.parse((await store.getCachedContentStale(id, 'session'))!.content);
    expect(merged.messages.map((m: { line: number }) => m.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await store.close();
  });

  test('a request that names more sessions than the limit is refused', async () => {
    const prev = process.env.CHAT_RECALL_INGEST_MAX_CONVERSATIONS;
    process.env.CHAT_RECALL_INGEST_MAX_CONVERSATIONS = '2';
    try {
      const { post } = await harness();
      const res = await post({ conversations: [full(1, 1), full(1, 1), full(1, 1)] });
      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ code: 'too_many_conversations', limit: 2, received: 3 });
    } finally {
      if (prev === undefined) delete process.env.CHAT_RECALL_INGEST_MAX_CONVERSATIONS; else process.env.CHAT_RECALL_INGEST_MAX_CONVERSATIONS = prev;
    }
  });
});
