/**
 * Subagent search end-to-end: a conversation whose envelope carries subagents
 * is ingested via /api/sync (which indexes them as subagent:<kind> chunks),
 * then GET /api/subagents/search finds them by content — proving the
 * server-backed recall_subagent_search path with no local JSONL files.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
const prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
let app: Express;
let token: string;

const SESSION_ID = 'sa11sa11-2222-3333-4444-555555555555';
const MTIME = 1750000000000;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'cr-subagent-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  const { createControlPlane } = await import('../imports.js');
  const syncRouter = (await import('./sync.js')).default;
  const subagentsRouter = (await import('./subagents.js')).default;

  app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/sync', syncRouter);
  app.use('/api/subagents', subagentsRouter);

  const cp = await createControlPlane();
  token = await cp.mintAgentToken('default', 'subagent-test');
  await cp.close();
});
afterAll(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR; else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('subagent search (server-backed)', () => {
  test('ingests subagents from the envelope and finds them by content', async () => {
    const ingest = await request(app)
      .post('/api/sync')
      .set('authorization', `Bearer ${token}`)
      .send({
        conversations: [{
          session_id: SESSION_ID,
          tool: 'claude',
          project_path: 'p_subagent',
          mtime: MTIME,
          first_prompt: 'fix the parser',
          envelope: {
            v: 6,
            messages: [{ role: 'user', content: 'fix the parser' }, { role: 'assistant', content: 'spawning a subagent' }],
            subagents: [
              { id: 'agent-aexplore1', kind: 'explore', messages: [{ role: 'assistant', content: 'the explore subagent traced the zorbofrang bug into the tokenizer' }] },
              { id: 'agent-acompact1', kind: 'compact', messages: [{ role: 'assistant', content: 'compacted summary of unrelated work' }] },
            ],
          },
        }],
      });
    expect(ingest.status).toBe(200);
    expect(ingest.body.ok).toBe(true);

    // Search hits the explore subagent by a word only it contains.
    const res = await request(app).get('/api/subagents/search?query=zorbofrang');
    expect(res.status).toBe(200);
    expect(res.body.hits.length).toBeGreaterThan(0);
    const hit = res.body.hits[0];
    expect(hit.sessionId).toBe(SESSION_ID);
    expect(hit.kind).toBe('explore');
    expect(hit.subagent).toBe('agent-aexplore1');
    expect(hit.sample).toMatch(/zorbofrang/i);

    // kind filter excludes the explore hit when asking for compact only.
    const filtered = await request(app).get('/api/subagents/search?query=zorbofrang&kind=compact');
    expect(filtered.body.hits.length).toBe(0);

    // missing query → 400
    const bad = await request(app).get('/api/subagents/search');
    expect(bad.status).toBe(400);
  });
});
