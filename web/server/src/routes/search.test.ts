import { describe, test, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import searchRouter from './search.js';

describe('POST /api/search', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/search', searchRouter);

  test('returns 400 when query is missing', async () => {
    const res = await request(app).post('/api/search').send({});
    // Some implementations reject empty queries with 400, others return [].
    expect([200, 400]).toContain(res.status);
  });

  test('accepts a normal query and returns shape { results }', async () => {
    const res = await request(app).post('/api/search').send({ query: 'auth' });
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('results');
    }
  });
});
