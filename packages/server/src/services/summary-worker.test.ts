/**
 * Unit tests for the server-side summary worker. We seed a session in the
 * store + an empty metadata-cache summary, then drive the sweep with an
 * injected `summarize` so no real LLM is involved.
 *
 * Isolation: CHAT_RECALL_DATA_DIR points at a fresh temp dir per file so the
 * SQLite cache.db is sandboxed and the test never touches the real index.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpDir: string;
const orig = {
  dataDir: process.env.CHAT_RECALL_DATA_DIR,
  storage: process.env.CHAT_RECALL_STORAGE,
  provider: process.env.SUMMARY_PROVIDER,
};

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'summary-worker-'));
  process.env.CHAT_RECALL_DATA_DIR = tmpDir;
  process.env.CHAT_RECALL_STORAGE = 'sqlite';
  // Ensure no real provider leaks in — the tests inject their own summarize.
  delete process.env.SUMMARY_PROVIDER;
});

afterAll(() => {
  if (orig.dataDir === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
  else process.env.CHAT_RECALL_DATA_DIR = orig.dataDir;
  if (orig.storage === undefined) delete process.env.CHAT_RECALL_STORAGE;
  else process.env.CHAT_RECALL_STORAGE = orig.storage;
  if (orig.provider !== undefined) process.env.SUMMARY_PROVIDER = orig.provider;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed a session item + its synced conversation envelope into the store. */
async function seedSession(id: string, firstPrompt: string): Promise<void> {
  const { createStore } = await import('@chat-recall/engine');
  const store = await createStore();
  try {
    const mtime = Date.now();
    await store.setItem({
      id,
      sourceType: 'session',
      title: firstPrompt.slice(0, 60),
      projectPath: '/tmp/proj',
      filePath: '',
      mtime,
      contentPreview: firstPrompt,
      extra: { tool: 'claude' },
    });
    await store.setCachedContent(
      id,
      'session',
      mtime,
      JSON.stringify({
        v: 6,
        messages: [
          { role: 'user', content: firstPrompt },
          { role: 'assistant', content: 'Sure, here is what I did.' },
        ],
        subagents: [],
      }),
    );
  } finally {
    await store.close();
  }
}

async function cachedSummary(id: string): Promise<string | undefined> {
  const { createMetadataCache } = await import('@chat-recall/engine');
  const cache = await createMetadataCache();
  try {
    const row = await cache.get(id);
    return row?.summary;
  } finally {
    await cache.close();
  }
}

describe('generateMissingSummaries', () => {
  test('summarizes a session with an empty summary and persists it', async () => {
    const { generateMissingSummaries } = await import('./summary-worker.js');
    const id = 'sess-generate-1';
    await seedSession(id, 'Implement OAuth login flow');

    const result = await generateMissingSummaries({ summarize: async () => 'TEST SUMMARY' });

    expect(result.generated).toBe(1);
    expect(await cachedSummary(id)).toBe('TEST SUMMARY');
  });

  test('skips a session that already has a summary', async () => {
    const { generateMissingSummaries } = await import('./summary-worker.js');
    // First call summarized sess-generate-1 above; a second sweep must skip it.
    const result = await generateMissingSummaries({ summarize: async () => 'SHOULD NOT OVERWRITE' });

    expect(result.generated).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    // The earlier summary is untouched.
    expect(await cachedSummary('sess-generate-1')).toBe('TEST SUMMARY');
  });

  test('counts a failure and keeps summarizing other sessions', async () => {
    const { generateMissingSummaries } = await import('./summary-worker.js');
    const bad = 'sess-bad';
    const good = 'sess-good';
    await seedSession(bad, 'This one throws');
    await seedSession(good, 'This one succeeds');

    // Throw for `bad`, succeed for everything else. The loop must not abort.
    const summarize = async (content: { sessionId: string }): Promise<string> => {
      if (content.sessionId === bad) throw new Error('LLM exploded');
      return 'GOOD SUMMARY';
    };

    const result = await generateMissingSummaries({ summarize });

    expect(result.failed).toBe(1);
    expect(result.generated).toBeGreaterThanOrEqual(1);
    expect(await cachedSummary(good)).toBe('GOOD SUMMARY');
    expect(await cachedSummary(bad)).toBeFalsy(); // no summary written for the failed one
  });
});

describe('serverSummaryConfig', () => {
  test('returns null when no provider is configured', async () => {
    const { serverSummaryConfig } = await import('./summary-worker.js');
    const saved = process.env.SUMMARY_PROVIDER;
    delete process.env.SUMMARY_PROVIDER;
    try {
      expect(serverSummaryConfig()).toBeNull();
    } finally {
      if (saved !== undefined) process.env.SUMMARY_PROVIDER = saved;
    }
  });

  test('resolves provider + key from env', async () => {
    const { serverSummaryConfig } = await import('./summary-worker.js');
    process.env.SUMMARY_PROVIDER = 'claude';
    process.env.SUMMARY_API_KEY = 'k-123';
    process.env.SUMMARY_MODEL = 'claude-3-5-haiku-20241022';
    try {
      const cfg = serverSummaryConfig();
      expect(cfg).not.toBeNull();
      expect(cfg!.provider).toBe('claude');
      expect(cfg!.apiKey).toBe('k-123');
      expect(cfg!.claudeModel).toBe('claude-3-5-haiku-20241022');
    } finally {
      delete process.env.SUMMARY_PROVIDER;
      delete process.env.SUMMARY_API_KEY;
      delete process.env.SUMMARY_MODEL;
    }
  });
});
