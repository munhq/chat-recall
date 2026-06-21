/**
 * /api/account/alerts — webhook config CRUD. Uses the sqlite control plane via
 * CHAT_RECALL_DATA_DIR (no Postgres), with a stub middleware standing in for
 * tenantAuth (sets req.tenant). Asserts https-only validation + round-trip.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import accountRouter from './account.js';

let dataDir: string;
const origDataDir = process.env.CHAT_RECALL_DATA_DIR;
let app: Express;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cr-account-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  app = express();
  app.use((req, _res, next) => { (req as express.Request & { tenant?: string }).tenant = 'test-tenant'; next(); });
  app.use('/api/account', accountRouter);
});
afterAll(() => {
  if (origDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = origDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('account alerts webhook config', () => {
  test('rejects a non-https webhook URL', async () => {
    const res = await request(app).post('/api/account/alerts').send({ webhookUrl: 'http://evil.example/h' });
    expect(res.status).toBe(400);
  });

  test('saves an https webhook and reads it back', async () => {
    const url = 'https://discord.com/api/webhooks/1/abc';
    const set = await request(app).post('/api/account/alerts').send({ webhookUrl: url });
    expect(set.status).toBe(200);
    expect(set.body.webhookUrl).toBe(url);
    const get = await request(app).get('/api/account/alerts');
    expect(get.status).toBe(200);
    expect(get.body.webhookUrl).toBe(url);
  });

  test('clears the webhook with an empty string', async () => {
    const res = await request(app).post('/api/account/alerts').send({ webhookUrl: '' });
    expect(res.status).toBe(200);
    expect(res.body.webhookUrl).toBe('');
  });

  test('test-ping with no webhook configured → 400', async () => {
    const res = await request(app).post('/api/account/alerts/test').send({});
    expect(res.status).toBe(400);
  });
});
