/**
 * Integration tests for /api/kg/* — add → query → timeline → invalidate on the
 * default-tenant sqlite knowledge graph.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import kgRouter from './kg.js';
import { homeEnvSnapshot, restoreHomeEnv, useHomeDir } from '@chat-recall/engine/test-support/home-env.js';

let tmpHome: string;
const origHome = homeEnvSnapshot();
let app: Express;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'kg-route-'));
  useHomeDir(tmpHome);
  app = express();
  app.use(express.json());
  app.use('/api/kg', kgRouter);
});
afterAll(() => {
  restoreHomeEnv(origHome);
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('KG route', () => {
  test('add → query returns the fact', async () => {
    const add = await request(app)
      .post('/api/kg/add')
      .send({ subject: 'chat-recall', predicate: 'uses', object: 'postgres' });
    expect(add.status).toBe(200);
    expect(typeof add.body.id).toBe('string');

    const q = await request(app).post('/api/kg/query').send({ entity: 'chat-recall' });
    expect(q.status).toBe(200);
    const objs = (q.body.facts as Array<{ object: string; current: boolean }>).map((f) => f.object);
    expect(objs).toContain('postgres');
  });

  test('timeline includes the added fact', async () => {
    const t = await request(app).get('/api/kg/timeline?limit=50');
    expect(t.status).toBe(200);
    expect(Array.isArray(t.body.entries)).toBe(true);
    expect(t.body.entries.length).toBeGreaterThan(0);
  });

  test('stats returns counts', async () => {
    const s = await request(app).get('/api/kg/stats');
    expect(s.status).toBe(200);
    expect(s.body).toHaveProperty('entities');
  });

  test('invalidate marks the fact not-current', async () => {
    const inv = await request(app)
      .post('/api/kg/invalidate')
      .send({ subject: 'chat-recall', predicate: 'uses', object: 'postgres' });
    expect(inv.status).toBe(200);
    expect(inv.body.invalidated).toBeGreaterThanOrEqual(1);

    const q = await request(app).post('/api/kg/query').send({ entity: 'chat-recall' });
    const fact = (q.body.facts as Array<{ object: string; current: boolean }>).find((f) => f.object === 'postgres');
    expect(fact?.current).toBe(false);
  });

  test('query without entity is rejected', async () => {
    const res = await request(app).post('/api/kg/query').send({});
    expect(res.status).toBe(400);
  });
});
