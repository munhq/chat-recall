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

const state: { rows: Array<{ id: string; project_id: string }>; purged: string[]; tombstoned: string[]; restored: string[]; throwOnList: boolean } = {
  rows: [], purged: [], tombstoned: [], restored: [], throwOnList: false,
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
    listTombstones: async () => state.tombstoned.map((id, i) => ({ session_id: id, deleted_at: 1000 + i })),
    removeTombstone: async (id: string) => {
      state.tombstoned = state.tombstoned.filter((t) => t !== id);
      state.restored.push(id);
    },
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
  state.restored = [];
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

describe('POST /api/data/delete — beyond the first page', () => {
  /**
   * The regression this pins: the handler read page 0 (200 rows, mtime DESC) and
   * stopped when that page held no row for the project. A tenant with more than
   * 200 sessions whose project sat outside the newest 200 got `200 {deleted: 0}`
   * — a delete that reported success and removed nothing.
   */
  test('deletes a project whose sessions are all past the first page', async () => {
    state.rows = [
      ...Array.from({ length: 250 }, (_, i) => ({ id: `new${i}`, project_id: 'busy' })),
      { id: 'old1', project_id: 'archived' },
      { id: 'old2', project_id: 'archived' },
    ];
    const res = await request(await app()).post('/api/data/delete').send({ project: 'archived' });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
    expect(state.purged.sort()).toEqual(['old1', 'old2']);
    expect(state.tombstoned.sort()).toEqual(['old1', 'old2']);
    // And nothing else was touched.
    expect(state.rows).toHaveLength(250);
  });

  test('deletes every match when they straddle a page boundary', async () => {
    state.rows = Array.from({ length: 500 }, (_, i) => ({
      id: `s${i}`, project_id: i % 3 === 0 ? 'target' : 'other',
    }));
    const res = await request(await app()).post('/api/data/delete').send({ project: 'target' });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(167);          // 0,3,6,… < 500
    expect(state.rows.every((r) => r.project_id === 'other')).toBe(true);
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

/**
 * Restore exists because BULK delete does. One-at-a-time deletion is
 * self-limiting; a call that removes hundreds at once needs a way back, or a
 * mis-aimed selector is unrecoverable.
 *
 * The failure mode worth testing is a restore that reports success while
 * lifting nothing — the user then re-syncs, the server silently refuses via the
 * deadSet, and the data stays gone with no error raised anywhere.
 */
describe('GET /api/data/tombstones', () => {
  test('lists deletions newest first — the only route back from a purge', async () => {
    // A purged session leaves no metadata, no chunks, no archive. This id list
    // is all that survives, so without it "undo my delete" needs a uuid nobody
    // has written down.
    await request(await app()).post('/api/data/delete').send({ project: 'alpha' });
    const res = await request(await app()).get('/api/data/tombstones');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.tombstones[0].deleted_at).toBeGreaterThan(res.body.tombstones[1].deleted_at);
  });

  test('reports nothing when nothing has been deleted', async () => {
    const res = await request(await app()).get('/api/data/tombstones');
    expect(res.body.total).toBe(0);
    expect(res.body.tombstones).toEqual([]);
  });
});

describe('POST /api/data/restore', () => {
  test('lifts the tombstone so a later sync is no longer refused', async () => {
    await request(await app()).post('/api/data/delete').send({ project: 'alpha' });
    expect(state.tombstoned.sort()).toEqual(['s1', 's2']);

    const res = await request(await app()).post('/api/data/restore').send({ session_ids: ['s1', 's2'] });
    expect(res.status).toBe(200);
    expect(res.body.restored).toBe(2);
    expect(state.tombstoned).toEqual([]);
  });

  test('says so when an id was never deleted here, instead of counting it', async () => {
    await request(await app()).post('/api/data/delete').send({ project: 'alpha' });
    const res = await request(await app()).post('/api/data/restore').send({ session_ids: ['s1', 'never-deleted'] });
    expect(res.body.restored).toBe(1);
    expect(res.body.notDeleted).toEqual(['never-deleted']);
  });

  test('the response never claims the content is back', async () => {
    // Lifting a tombstone removes the REFUSAL. The transcript still has to
    // exist on some device and be re-shipped; saying "restored" without that
    // caveat is the difference between a fix and a false all-clear.
    await request(await app()).post('/api/data/delete').send({ project: 'alpha' });
    const res = await request(await app()).post('/api/data/restore').send({ session_ids: ['s1'] });
    expect(res.body.note).toMatch(/index --force/);
  });

  test('an empty or malformed body is a 400, not a no-op 200', async () => {
    for (const body of [{}, { session_ids: [] }, { session_ids: 's1' }, { session_ids: [''] }]) {
      const res = await request(await app()).post('/api/data/restore').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(state.restored).toEqual([]);
    }
  });

  test('there is no restore-everything switch', async () => {
    // Re-opening every deletion a tenant ever made would undo the ones made
    // for privacy. Restore is id-scoped on purpose.
    await request(await app()).post('/api/data/delete').send({ project: 'alpha' });
    const res = await request(await app()).post('/api/data/restore').send({ all: true });
    expect(res.status).toBe(400);
    expect(state.tombstoned.sort()).toEqual(['s1', 's2']);
  });
});
