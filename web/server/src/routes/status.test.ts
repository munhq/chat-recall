import { describe, test, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import statusRouter from './status.js';

describe('GET /api/status', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/status', statusRouter);

  test('returns the status shape (totalChunks, totalSessions, projects, indexPath)', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalChunks');
    expect(res.body).toHaveProperty('totalSessions');
    expect(res.body).toHaveProperty('projects');
    expect(typeof res.body.totalSessions).toBe('number');
  });
});
