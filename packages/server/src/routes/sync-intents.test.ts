/**
 * Integration tests for the Model-B sync-intent queue: enqueue → drain →
 * ack against the real tenant store.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import syncIntentsRouter from './sync-intents.js';

let app: Express;
beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/sync-intents', syncIntentsRouter);
});
afterAll(() => { /* shared pooled store; closed by suite teardown */ });

describe('POST /api/sync-intents (validation)', () => {
  test('rejects unknown kind', async () => {
    const res = await request(app).post('/api/sync-intents').send({ kind: 'wat' });
    expect(res.status).toBe(400);
  });
  test('copy requires type/name/tools', async () => {
    const res = await request(app).post('/api/sync-intents').send({ kind: 'copy', name: 'x' });
    expect(res.status).toBe(400);
  });
  test('copy rejects same from/to tool', async () => {
    const res = await request(app).post('/api/sync-intents')
      .send({ kind: 'copy', artifactType: 'skill', name: 'x', fromTool: 'claude', toTool: 'claude' });
    expect(res.status).toBe(400);
  });
});

describe('enqueue → pending → ack round-trip', () => {
  test('a sync_all intent is enqueued, appears in pending, then acked away', async () => {
    const enq = await request(app).post('/api/sync-intents').send({ kind: 'sync_all' });
    expect(enq.status).toBe(200);
    const id = enq.body.id as string;
    expect(id).toMatch(/^si_/);

    // It shows up in the (untargeted) pending list.
    const pending = await request(app).get('/api/sync-intents/pending');
    expect(pending.status).toBe(200);
    expect((pending.body.intents as any[]).some(i => i.id === id)).toBe(true);

    // Ack it done.
    const ack = await request(app).post(`/api/sync-intents/${id}/ack`).send({ status: 'done', result: '{"copied":3}' });
    expect(ack.status).toBe(200);

    // No longer pending.
    const after = await request(app).get('/api/sync-intents/pending');
    expect((after.body.intents as any[]).some(i => i.id === id)).toBe(false);

    // But visible in the recent list with status done.
    const recent = await request(app).get('/api/sync-intents?limit=100');
    const row = (recent.body.intents as any[]).find(i => i.id === id);
    expect(row?.status).toBe('done');
  });

  test('ack of a missing intent is 404', async () => {
    const res = await request(app).post('/api/sync-intents/si_does_not_exist/ack').send({ status: 'done' });
    expect(res.status).toBe(404);
  });

  test('a copy intent carries its fields through to pending', async () => {
    const enq = await request(app).post('/api/sync-intents')
      .send({ kind: 'copy', artifactType: 'command', name: 'review', fromTool: 'claude', toTool: 'gemini' });
    expect(enq.status).toBe(200);
    const pending = await request(app).get('/api/sync-intents/pending?limit=100');
    const row = (pending.body.intents as any[]).find(i => i.id === enq.body.id);
    expect(row.kind).toBe('copy');
    expect(row.artifact_type).toBe('command');
    expect(row.name).toBe('review');
    expect(row.from_tool).toBe('claude');
    expect(row.to_tool).toBe('gemini');
  });
});
