/**
 * Acceptance criterion 7 of docs/SYNC-BATCH-WRITES.md: the counts the ingest
 * reports back are the same after batching as before it.
 *
 * The response is what the CLI writes into its ledger and what `doctor` shows,
 * so a count that drifts is a silent behaviour change — a batch that reports
 * fewer chunks than it stored looks like data loss to the user, and one that
 * reports more hides it.
 *
 * These drive the REAL route over HTTP, not the store, because the counting
 * moved: chunks, findings and derived rows are now returned by one writer
 * instead of accumulated per call, and that arithmetic is the thing at risk.
 *
 * Runs on the sqlite backend in an isolated data dir, like sync.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let prevDataDir: string | undefined;
let prevAuth: string | undefined;
let app: express.Express;
let token: string;

beforeAll(async () => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-sync-counts-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
  prevAuth = process.env.AUTH_PROVIDER;
  process.env.AUTH_PROVIDER = 'keycloak';

  const { createControlPlane } = await import('../imports.js');
  const syncRouter = (await import('./sync.js')).default;
  app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/sync', syncRouter);

  const cp = await createControlPlane();
  token = await cp.mintAgentToken('default', 'counts-laptop');
  await cp.close();
}, 60000);

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  if (prevAuth === undefined) delete process.env.AUTH_PROVIDER;
  else process.env.AUTH_PROVIDER = prevAuth;
  rmSync(dataDir, { recursive: true, force: true });
});

const uuid = (n: number) => `${String(n).padStart(8, '0')}-1111-2222-3333-444444444444`;
const MTIME = 1750000000000;

/** One conversation with `turns` text turns, plus its derived and findings rows. */
function conversation(n: number, turns: number) {
  return {
    session_id: uuid(n),
    tool: 'claude',
    project_path: 'p_abcdef123456',
    mtime: MTIME + n,
    first_prompt: `first prompt ${n}`,
    turns: Array.from({ length: turns }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `session ${n} turn ${i}`,
      ts: MTIME + n + i,
    })),
    meta: { inputTokens: 10, outputTokens: 5 },
  };
}

const post = (body: Record<string, unknown>) =>
  request(app).post('/api/sync').set('authorization', `Bearer ${token}`).send(body);

describe('the counts the ingest reports', () => {
  test('CRITERION 7: every count is present and adds up on a mixed batch', async () => {
    const sessions = [1, 2, 3];
    const res = await post({
      conversations: sessions.map((n) => conversation(n, 6)),
      findings: sessions.map((n) => ({
        session_id: uuid(n), detector: 'gitleaks', rule: 'aws-key', line: 3, preview: `****${n}`,
      })),
      derived: sessions.map((n) => ({
        session_id: uuid(n),
        mtime: MTIME + n,
        compute: [
          { kind: 'markers', mtime: MTIME + n, data: { sessionId: uuid(n), prompts: [], summary: { total: 0 } } },
          { kind: 'diff', mtime: MTIME + n, data: { files: [] } },
        ],
        outcome_row: { tool: 'claude', status: 'completed', reason: 't', fileMtime: MTIME + n, isFull: true },
      })),
      kg_entities: [{ name: 'zorbofrang', type: 'tool' }],
      kg_triples: [{ subject: 'project', predicate: 'uses', object: 'zorbofrang' }],
    });

    expect(res.status).toBe(200);
    // One metadata row per conversation.
    expect(res.body.conv).toBe(3);
    // Chunks are derived from the turns, so the exact number is the chunker's
    // business — what matters is that the route reports what it stored.
    expect(res.body.chunks).toBeGreaterThan(0);
    // One finding per session, all three sessions present in this same batch —
    // the check that they exist must count a session being written right now.
    expect(res.body.find).toBe(3);
    // `der` counts BOTH kinds of derived row: two compute rows per session
    // plus one outcome row each. That is what it counted before batching, and
    // criterion 7 is that it still does.
    expect(res.body.der).toBe(3 * 2 + 3);
    expect(res.body.kgT).toBe(1);
  }, 60000);

  test('a finding for a session NOT in this batch and not stored is skipped', async () => {
    // It would otherwise fail the RLS check and 500 the whole request.
    const res = await post({
      findings: [{ session_id: uuid(999), detector: 'gitleaks', rule: 'aws-key', line: 1, preview: '****x' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.find).toBe(0);
  }, 30000);

  test('a finding for an ALREADY-stored session is counted', async () => {
    const res = await post({
      findings: [{ session_id: uuid(1), detector: 'trufflehog', rule: 'slack-token', line: 9, preview: '****z' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.find).toBe(1);
  }, 30000);

  test('an empty request reports zeroes, not nulls', async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(res.body.conv).toBe(0);
    expect(res.body.chunks).toBe(0);
    expect(res.body.find).toBe(0);
    expect(res.body.der).toBe(0);
  }, 30000);

  test('re-sending an identical batch reports the same counts', async () => {
    // The guard on DO UPDATE means the database writes nothing the second time.
    // The REPORT must not change because of that: the CLI reads these numbers
    // to decide what it has synced, and a second sync that claims zero chunks
    // reads as data loss.
    const body = {
      conversations: [conversation(4, 4)],
      derived: [{
        session_id: uuid(4), mtime: MTIME + 4,
        compute: [{ kind: 'diff', mtime: MTIME + 4, data: { files: [] } }],
      }],
    };
    const first = await post(body);
    const second = await post(body);
    expect(second.status).toBe(200);
    expect(second.body.chunks).toBe(first.body.chunks);
    expect(second.body.der).toBe(first.body.der);
    expect(second.body.conv).toBe(first.body.conv);
  }, 60000);
});
