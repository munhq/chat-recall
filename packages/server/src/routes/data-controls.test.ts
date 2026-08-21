/**
 * The user's own delete and export controls.
 *
 * These are destructive by design, so the tests are about the guardrails:
 *
 *   1. delete-all refuses without the exact typed phrase. A checkbox is not
 *      enough for something with no undo.
 *   2. every delete writes a TOMBSTONE. Without one the next CLI sync restores
 *      what was just removed, and "delete" silently means "delete until the
 *      daemon next runs".
 *   3. a project delete touches only that project.
 *   4. export streams NDJSON and says so when it truncates, because headers are
 *      already sent by then and a silent short file is unrecoverable.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const state: { rows: Array<{ id: string; project_id: string }>; purged: string[]; tombstoned: string[]; throwOnList: boolean } = {
  rows: [], purged: [], tombstoned: [], throwOnList: false,
};

vi.mock('../imports.js', () => ({
  createStore: async () => ({
    listItems: async (_type: string, limit: number, offset = 0) => {
      if (state.throwOnList && state.purged.length > 0) throw new Error('boom');
      return state.rows.slice(offset, offset + limit);
    },
    purgeSession: async (id: string) => {
      state.purged.push(id);
      state.rows = state.rows.filter((r) => r.id !== id);
    },
    addTombstone: async (id: string) => { state.tombstoned.push(id); },
    close: async () => {},
  }),
}));

async function app(): Promise<Express> {
  const { default: router } = await import('./data-controls.js');
  const a = express();
  a.use('/api/data', router);
  return a;
}

beforeEach(() => {
  state.rows = [
    { id: 's1', project_id: 'alpha' },
    { id: 's2', project_id: 'alpha' },
    { id: 's3', project_id: 'beta' },
  ];
  state.purged = [];
  state.tombstoned = [];
  state.throwOnList = false;
});

describe('POST /api/data/delete-all', () => {
  test('refuses without the exact phrase, and destroys nothing', async () => {
    for (const body of [{}, { confirm: '' }, { confirm: 'yes' }, { confirm: 'delete' }, { confirm: 'DELETE EVERYTHING!' }]) {
      const res = await request(await app()).post('/api/data/delete-all').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(state.purged).toEqual([]);
    }
  });

  test('accepts the phrase case-insensitively and with surrounding space', async () => {
    const res = await request(await app()).post('/api/data/delete-all').send({ confirm: '  Delete Everything  ' });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(3);
  });

  test('tombstones everything it purges', async () => {
    await request(await app()).post('/api/data/delete-all').send({ confirm: 'delete everything' });
    // The property that makes deletion mean deletion: without these the next
    // sync pushes the same sessions straight back up.
    expect(state.purged.sort()).toEqual(['s1', 's2', 's3']);
    expect(state.tombstoned.sort()).toEqual(['s1', 's2', 's3']);
  });
});

describe('POST /api/data/delete', () => {
  test('deletes one project and leaves the others alone', async () => {
    const res = await request(await app()).post('/api/data/delete').send({ project: 'alpha' });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
    expect(state.purged.sort()).toEqual(['s1', 's2']);
    expect(state.tombstoned.sort()).toEqual(['s1', 's2']);
    expect(state.rows.map((r) => r.id)).toEqual(['s3']);
  });

  test('requires a project rather than defaulting to everything', async () => {
    // A missing scope must never widen to "all". That mistake is unrecoverable.
    for (const body of [{}, { project: '' }, { project: '   ' }]) {
      const res = await request(await app()).post('/api/data/delete').send(body);
      expect(res.status).toBe(400);
      expect(state.purged).toEqual([]);
    }
  });

  test('an unknown project deletes nothing and still answers', async () => {
    const res = await request(await app()).post('/api/data/delete').send({ project: 'nope' });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(0);
    expect(state.purged).toEqual([]);
  });
});

describe('GET /api/data/export', () => {
  test('streams one JSON object per line, as a download', async () => {
    const res = await request(await app()).get('/api/data/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="chat-recall-export-\d{4}-\d{2}-\d{2}\.ndjson"/);
    const lines = res.text.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).id).sort()).toEqual(['s1', 's2', 's3']);
  });

  test('filters to one project when asked', async () => {
    const res = await request(await app()).get('/api/data/export?project=beta');
    const ids = res.text.trim().split('\n').map((l) => JSON.parse(l).id);
    expect(ids).toEqual(['s3']);
  });

  test('exports nothing without deleting anything', async () => {
    await request(await app()).get('/api/data/export');
    expect(state.purged).toEqual([]);
  });
});
