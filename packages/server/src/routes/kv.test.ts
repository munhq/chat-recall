/**
 * Integration tests for /api/kv/* — set → get → list round-trip on the
 * default-tenant sqlite store.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import kvRouter from './kv.js';

let tmpHome: string;
const origHome = process.env.HOME;
let app: Express;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'kv-route-'));
  process.env.HOME = tmpHome;
  app = express();
  app.use(express.json());
  app.use('/api/kv', kvRouter);
});
afterAll(() => {
  process.env.HOME = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('KV route', () => {
  test('set → get round-trips a value', async () => {
    const set = await request(app).post('/api/kv/set').send({ scope: 'proj', key: 'k1', value: 'v1' });
    expect(set.status).toBe(200);
    expect(set.body.ok).toBe(true);

    const get = await request(app).get('/api/kv/get?scope=proj&key=k1');
    expect(get.status).toBe(200);
    expect(get.body.entry?.value).toBe('v1');
  });

  test('list returns entries within a scope', async () => {
    await request(app).post('/api/kv/set').send({ scope: 'proj', key: 'k2', value: 'v2' });
    const list = await request(app).get('/api/kv/list?scope=proj');
    expect(list.status).toBe(200);
    const keys = (list.body.entries as Array<{ key: string }>).map((e) => e.key);
    expect(keys).toContain('k1');
    expect(keys).toContain('k2');
  });

  test('get for a missing key returns a null entry', async () => {
    const get = await request(app).get('/api/kv/get?scope=proj&key=nope');
    expect(get.status).toBe(200);
    expect(get.body.entry).toBeNull();
  });

  test('set without value is rejected', async () => {
    const res = await request(app).post('/api/kv/set').send({ scope: 'proj', key: 'k3' });
    expect(res.status).toBe(400);
  });
});
