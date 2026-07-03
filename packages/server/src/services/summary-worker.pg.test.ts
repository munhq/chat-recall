/**
 * Trivial-session triage in the Postgres claim path of the summary worker.
 *
 * Trivial = few turns AND little generated output. Turn count alone
 * misclassified subagent fan-outs (1 user turn, tens of thousands of output
 * tokens of real work — e.g. session c7f6ca25, $41 of Opus, stamped
 * 'too_short'). These tests pin the two-dimensional rule and the self-heal:
 * a session a previous sweep stamped 'too_short' that no longer satisfies
 * the rule is re-claimed and gets a real summary — no backfill scripts.
 *
 * Postgres-gated, exactly like conversations.expand.test.ts: skipped when
 * DATABASE_URL isn't set.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createStore, createMetadataCache } from '../imports.js';

const PG_URL = process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL;

const FIRST_PROMPT = 'I dont fully understand - so what is sound?';

(PG_URL ? describe : describe.skip)('generateMissingSummaries — trivial triage (postgres)', () => {
  const tenant = `wrktriage_${process.pid}`;
  const orig = { dbUrl: process.env.DATABASE_URL, storage: process.env.CHAT_RECALL_STORAGE };

  beforeAll(() => {
    process.env.DATABASE_URL = PG_URL;
    process.env.CHAT_RECALL_STORAGE = 'postgres';
  });
  afterAll(() => {
    if (orig.dbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = orig.dbUrl;
    if (orig.storage === undefined) delete process.env.CHAT_RECALL_STORAGE;
    else process.env.CHAT_RECALL_STORAGE = orig.storage;
  });

  async function seed(
    id: string,
    opts: { msgs: number; outTokens: number; summary?: string; summarySource?: string },
  ): Promise<void> {
    const store = await createStore({ backend: 'postgres', databaseUrl: PG_URL, tenant } as any);
    try {
      const mtime = Date.now();
      await store.setItem({
        id, sourceType: 'session', title: id, projectPath: '/x', filePath: '', mtime,
        contentPreview: FIRST_PROMPT,
        extra: { tool: 'claude', messageCount: opts.msgs, outputTokens: opts.outTokens },
      });
      await store.setCachedContent(id, 'session', mtime, JSON.stringify({
        v: 6,
        messages: [
          { role: 'user', content: FIRST_PROMPT },
          { role: 'assistant', content: 'The epoch key answer.' },
        ],
        subagents: [],
      }));
    } finally { await store.close(); }
    const cache = await createMetadataCache({ tenant } as any);
    try {
      await cache.set({
        sessionId: id,
        firstPrompt: FIRST_PROMPT,
        summary: opts.summary ?? '',
        summarySource: (opts.summarySource ?? 'original') as any,
        mtime: Date.now(),
        indexedAt: Date.now(),
      });
    } finally { await cache.close(); }
  }

  async function summaryRow(id: string): Promise<{ summary?: string; summarySource?: string }> {
    const cache = await createMetadataCache({ tenant } as any);
    try {
      const row = await cache.get(id);
      return { summary: row?.summary, summarySource: (row as any)?.summarySource };
    } finally { await cache.close(); }
  }

  test('few turns + little output → first_prompt fallback, no LLM call', async () => {
    const { generateMissingSummaries } = await import('./summary-worker.js');
    const id = 'triage-trivial-1';
    await seed(id, { msgs: 2, outTokens: 100 });

    let llmCalls = 0;
    const r = await generateMissingSummaries({ tenant, summarize: async () => { llmCalls++; return 'LLM SUMMARY'; } });

    expect(r.generated).toBeGreaterThanOrEqual(1);
    expect(llmCalls).toBe(0);
    const row = await summaryRow(id);
    expect(row.summary).toBe(FIRST_PROMPT);
  });

  test('few turns but heavy output (subagent fan-out) → real LLM summary', async () => {
    const { generateMissingSummaries } = await import('./summary-worker.js');
    const id = 'triage-fanout-1';
    await seed(id, { msgs: 2, outTokens: 29462 });

    const r = await generateMissingSummaries({ tenant, summarize: async () => 'LLM SUMMARY' });

    expect(r.generated).toBeGreaterThanOrEqual(1);
    expect((await summaryRow(id)).summary).toBe('LLM SUMMARY');
  });

  test("self-heal: a session mis-stamped 'too_short' by the old rule is re-claimed", async () => {
    const { generateMissingSummaries } = await import('./summary-worker.js');
    const id = 'triage-heal-1';
    // What prod looks like after the old turn-count-only triage: fallback
    // summary already written, source 'too_short', but 29k output tokens.
    await seed(id, { msgs: 2, outTokens: 29462, summary: FIRST_PROMPT, summarySource: 'too_short' });

    const r = await generateMissingSummaries({ tenant, summarize: async () => 'LLM SUMMARY' });

    expect(r.generated).toBeGreaterThanOrEqual(1);
    expect((await summaryRow(id)).summary).toBe('LLM SUMMARY');
  });

  test("genuinely trivial 'too_short' rows are NOT re-claimed (no churn)", async () => {
    const { generateMissingSummaries } = await import('./summary-worker.js');
    const id = 'triage-stable-1';
    await seed(id, { msgs: 1, outTokens: 50, summary: FIRST_PROMPT, summarySource: 'too_short' });

    let llmCalls = 0;
    await generateMissingSummaries({ tenant, summarize: async () => { llmCalls++; return 'LLM SUMMARY'; } });

    expect(llmCalls).toBe(0);
    expect((await summaryRow(id)).summary).toBe(FIRST_PROMPT);
  });
});
