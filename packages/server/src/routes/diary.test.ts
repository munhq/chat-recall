/**
 * Integration tests for /api/diary/* — write → read round-trip, agent scoping.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import diaryRouter from './diary.js';

let tmpHome: string;
const origHome = process.env.HOME;
let app: Express;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'diary-route-'));
  process.env.HOME = tmpHome;
  app = express();
  app.use(express.json());
  app.use('/api/diary', diaryRouter);
});
afterAll(() => {
  process.env.HOME = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('Diary route', () => {
  test('write → read round-trips an entry for the agent', async () => {
    const w = await request(app).post('/api/diary/write').send({
      agent_name: 'Atlas', topic: 'auth', entry: 'decided to use keycloak device flow',
    });
    expect(w.status).toBe(200);
    expect(typeof w.body.id).toBe('string');

    const r = await request(app).get('/api/diary/read?agent=Atlas');
    expect(r.status).toBe(200);
    expect(r.body.entries.length).toBe(1);
    expect(r.body.entries[0].topic).toBe('auth');
    expect(r.body.entries[0].content).toMatch(/keycloak/);
  });

  test('read is scoped to the requested agent', async () => {
    await request(app).post('/api/diary/write').send({ agent_name: 'Borealis', topic: 'x', entry: 'other agent note' });
    const r = await request(app).get('/api/diary/read?agent=Atlas');
    const agents = (r.body.entries as Array<{ agent: string }>).map((e) => e.agent);
    expect(agents.every((a) => a === 'Atlas')).toBe(true);
  });

  test('write without entry is rejected', async () => {
    const res = await request(app).post('/api/diary/write').send({ agent_name: 'Atlas', topic: 'x' });
    expect(res.status).toBe(400);
  });

  test('read without agent is rejected', async () => {
    const res = await request(app).get('/api/diary/read');
    expect(res.status).toBe(400);
  });
});
