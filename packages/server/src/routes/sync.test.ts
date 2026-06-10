/**
 * Ingest pipeline test: a device token minted through the control plane
 * authorizes POST /api/sync; the uploaded conversation becomes visible to
 * the SAME stores the dashboard reads — metadata row, FTS chunks, first
 * prompt cache, and the parsed-messages envelope behind conversations/:id.
 *
 * Runs against an isolated CHAT_RECALL_DATA_DIR (sqlite backend) so it
 * never touches the developer's real index.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
let prevDataDir: string | undefined;

beforeAll(() => {
  prevDataDir = process.env.CHAT_RECALL_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cr-sync-test-'));
  process.env.CHAT_RECALL_DATA_DIR = dataDir;
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/sync (ingest)', () => {
  test('rejects without a token, ingests with one, and the stores see the data', async () => {
    // Import AFTER the env override so paths.ts resolves the temp dir.
    const { createControlPlane, createStore, createMetadataCache } = await import('../imports.js');
    const syncRouter = (await import('./sync.js')).default;

    const app = express();
    app.use(express.json({ limit: '16mb' }));
    app.use('/api/sync', syncRouter);

    // No token → 401.
    const unauth = await request(app).post('/api/sync').send({ conversations: [] });
    expect(unauth.status).toBe(401);

    // Mint a device token.
    const cp = await createControlPlane();
    const token = await cp.mintAgentToken('default', 'test-laptop');
    await cp.close();
    expect(token).toMatch(/^ct_/);

    // Garbage token → 401.
    const bad = await request(app)
      .post('/api/sync')
      .set('authorization', 'Bearer ct_nope')
      .send({ conversations: [] });
    expect(bad.status).toBe(401);

    const sessionId = '00000000-1111-2222-3333-444444444444';
    const mtime = 1750000000000;
    const res = await request(app)
      .post('/api/sync')
      .set('authorization', `Bearer ${token}`)
      .send({
        conversations: [{
          session_id: sessionId,
          tool: 'claude',
          project_path: 'p_abcdef123456',
          mtime,
          first_prompt: 'fix the flux capacitor in zorbofrang mode',
          turns: [
            { role: 'user', text: 'fix the flux capacitor in zorbofrang mode', ts: mtime - 1000 },
            { role: 'assistant', text: 'Decided: we will replace the zorbofrang coil entirely.', ts: mtime },
          ],
          meta: { inputTokens: 1000, outputTokens: 200, modelsUsed: ['claude-sonnet-4-6'] },
        }],
        findings: [
          { session_id: sessionId, detector: 'gitleaks', rule: 'aws-key', line: 3, preview: '****QVGY' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.conv).toBe(1);
    expect(res.body.find).toBe(1);
    expect(res.body.chunks).toBeGreaterThan(0);

    // 1. Metadata row exists with the synced telemetry.
    const store = await createStore();
    const item = await store.getItem(sessionId, 'session');
    expect(item).not.toBeNull();
    const extra = JSON.parse(item!.extra_json);
    expect(extra.synced).toBe(true);
    expect(extra.inputTokens).toBe(1000);

    // 2. FTS search finds the conversation by a turn's content.
    const hits = await store.searchFTS('zorbofrang', { topK: 5 });
    expect(hits.some(h => h.itemId === sessionId)).toBe(true);

    // 3. The parsed-messages envelope serves the viewer.
    const cached = await store.getCachedContent(sessionId, 'session', mtime);
    expect(cached).not.toBeNull();
    const envelope = JSON.parse(cached!);
    expect(envelope.v).toBe(5);
    expect(envelope.messages).toHaveLength(2);
    expect(envelope.messages[0].role).toBe('user');

    // 4. Secret finding landed (masked preview only).
    const findings = await store.secretFindingsForSession(sessionId);
    expect(findings).toHaveLength(1);
    expect(findings[0].preview).toBe('****QVGY');
    await store.close();

    // 5. First-prompt cache hydrates the list.
    const cache = await createMetadataCache();
    const row = await cache.get(sessionId);
    expect(row?.firstPrompt).toContain('flux capacitor');
    await cache.close();
  });
});
