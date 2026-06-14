/**
 * Server-side AI summary generation for synced sessions.
 *
 * The thin collector no longer ships AI summaries — it syncs the raw
 * conversation (the `content_cache` envelope) and structured outcome, but
 * leaves the human-readable summary blank. The read path
 * (getSessionMetadata → recall_summary / recall_smart_resume) is already
 * wired to attach a summary from the metadata cache; this worker is the
 * piece that POPULATES it.
 *
 * `generateMissingSummaries` sweeps indexed sessions whose metadata-cache
 * summary is empty, rebuilds a `SessionContent` from the synced envelope,
 * runs it through a configurable `summarize` function (default: a
 * `SummaryGenerator` built from server env config), and writes the result
 * back to the metadata cache. Failures are recorded in the `summary_errors`
 * table so repeated failures back off instead of being retried every tick.
 *
 * The `summarize` function is injectable specifically so the sweep is
 * testable without a live LLM.
 *
 * Env vars consumed by `serverSummaryConfig()`:
 *   SUMMARY_PROVIDER    — 'claude' | 'gemini-cli' | 'cli' | 'ollama' |
 *                         'openai' | 'openai-compat' | 'ollama-cloud' | 'nvidia'
 *   SUMMARY_API_KEY     — generic key (preferred); falls back to
 *                         ANTHROPIC_API_KEY (claude) / GEMINI_API_KEY (gemini)
 *   SUMMARY_MODEL       — model id for the chosen provider
 *   SUMMARY_BASE_URL    — base URL for OpenAI-compatible providers
 * Returns null from serverSummaryConfig() when no provider is configured,
 * which makes the worker a no-op (summaries stay empty; the structured
 * outcome still renders).
 */

import {
  createStore,
  createMetadataCache,
  SummaryGenerator,
  type SummaryGeneratorConfig,
  type SessionContent,
  type SourceType,
} from '../imports.js';

/** Provider names accepted from SUMMARY_PROVIDER, mirroring SummaryGeneratorConfig. */
type SummaryProvider = SummaryGeneratorConfig['provider'];

/** `summary_source` tag the metadata cache accepts (see MetadataCache.set). */
type SummarySource = 'original' | 'gemini' | 'claude' | 'ollama';

/**
 * Resolve the summary provider configuration from server env. Returns null
 * when no provider is configured — the caller treats that as "summaries
 * disabled" and skips the sweep entirely.
 *
 * We require SUMMARY_PROVIDER to be set explicitly: defaulting to a provider
 * the operator never opted into would spawn CLI subprocesses or make API
 * calls on a server they didn't intend, so silence (null) is the safe default.
 */
export function serverSummaryConfig(): SummaryGeneratorConfig | null {
  const provider = (process.env.SUMMARY_PROVIDER || '').trim() as SummaryProvider | '';
  if (!provider) return null;

  // Generic key first, then the per-provider conventional env so an operator
  // who already exports ANTHROPIC_API_KEY / GEMINI_API_KEY doesn't have to
  // duplicate it under SUMMARY_API_KEY.
  const apiKey =
    process.env.SUMMARY_API_KEY ||
    (provider === 'claude' ? process.env.ANTHROPIC_API_KEY : undefined) ||
    (provider === 'gemini-cli' ? process.env.GEMINI_API_KEY : undefined) ||
    undefined;

  const config: SummaryGeneratorConfig = {
    provider,
    apiKey,
    apiBaseUrl: process.env.SUMMARY_BASE_URL || undefined,
    apiModel: process.env.SUMMARY_MODEL || undefined,
    // claude/gemini providers read the model from their own fields rather
    // than apiModel; pass SUMMARY_MODEL through to both so a single env
    // controls whichever provider is selected.
    claudeModel: process.env.SUMMARY_MODEL || undefined,
    geminiModel: process.env.SUMMARY_MODEL || undefined,
  };
  return config;
}

/** Map a provider to the `summary_source` tag stored alongside the summary. */
export function providerToSource(provider: SummaryProvider): SummarySource {
  switch (provider) {
    case 'gemini-cli':
      return 'gemini';
    case 'claude':
      return 'claude';
    case 'ollama':
      return 'ollama';
    default:
      // 'cli' / openai-compatible providers don't have a dedicated enum value;
      // 'original' is the catch-all the cache already accepts.
      return 'original';
  }
}

/** Skip retrying a session that has already failed this many times until the
 *  retry window elapses — avoids hammering a misconfigured provider every tick. */
const MAX_SUMMARY_ATTEMPTS = 3;
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Envelope persisted in content_cache by the conversation route /
 * sync ingest: `{ v, messages: [{ role, content }], subagents }`.
 * `role` is 'user' | 'assistant' | 'summary'; `content` is the rendered
 * turn text. We only need role + content to build a SessionContent.
 */
export interface CachedEnvelope {
  v?: number;
  messages?: Array<{ role?: string; content?: string }>;
  subagents?: unknown[];
}

/**
 * Build a `SessionContent` from a synced conversation envelope. User and
 * assistant turns are enough for SummaryGenerator.buildContext (it reads
 * firstPrompt + the first few user/assistant messages); tools/toolResults
 * aren't synced as a structured set, so they're left empty.
 *
 * Exported so the regenerate-summary route can reuse it for server-mode
 * on-demand regeneration without duplicating the envelope mapping.
 */
export function envelopeToSessionContent(
  sessionId: string,
  envelope: CachedEnvelope,
): SessionContent | null {
  const messages = Array.isArray(envelope.messages) ? envelope.messages : [];
  if (messages.length === 0) return null;

  const userMessages: SessionContent['userMessages'] = [];
  const assistantMessages: SessionContent['assistantMessages'] = [];
  const summaries: string[] = [];
  let firstPrompt = '';
  let line = 0;

  for (const m of messages) {
    line++;
    const text = typeof m.content === 'string' ? m.content : '';
    if (!text) continue;
    if (m.role === 'user') {
      if (!firstPrompt) firstPrompt = text;
      userMessages.push({ text, lineNumber: line, contentType: 'user' });
    } else if (m.role === 'assistant') {
      assistantMessages.push({ text, lineNumber: line, contentType: 'assistant' });
    } else if (m.role === 'summary') {
      summaries.push(text);
    }
  }

  // Nothing the summarizer can work with (e.g. tool-result-only envelope).
  if (userMessages.length === 0 && assistantMessages.length === 0) return null;

  return {
    sessionId,
    sessionPath: '', // no on-disk path in server mode — content came from sync
    summaries,
    userMessages,
    assistantMessages,
    toolResults: [],
    toolsUsed: new Set<string>(),
    firstPrompt,
    metadata: {
      toolsUsed: [],
      gitBranch: '',
      slug: firstPrompt.slice(0, 80),
      durationMs: 0,
      lastStopReason: '',
      filesModified: [],
      modelsUsed: [],
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      peakContextTokens: 0,
      messageCount: messages.length,
      costUsd: 0,
      metadataVersion: 0,
    },
  };
}

export interface GenerateMissingResult {
  generated: number;
  failed: number;
  skipped: number;
}

export interface GenerateMissingOptions {
  /** Max sessions to attempt this sweep. Keeps each tick bounded. */
  limit?: number;
  /**
   * Summarizer. Injectable so the sweep is testable without a real LLM.
   * Defaults to a SummaryGenerator built from `serverSummaryConfig()`.
   * When no provider is configured AND no override is supplied, the sweep
   * is a no-op (returns all-zero counts).
   */
  summarize?: (content: SessionContent) => Promise<string>;
}

/**
 * Generate summaries for indexed sessions that don't have one yet.
 *
 * For each candidate (up to `limit`):
 *   1. Skip if it already has a non-empty cached summary.
 *   2. Skip (back off) if it has failed >= MAX_SUMMARY_ATTEMPTS within the
 *      retry window.
 *   3. Load the synced envelope from content_cache; skip if absent (nothing
 *      to summarize from yet).
 *   4. Build SessionContent, call `summarize`, write the summary back.
 *   5. On failure, record the error and continue — one bad session must
 *      never abort the whole sweep.
 */
export async function generateMissingSummaries(
  opts: GenerateMissingOptions = {},
): Promise<GenerateMissingResult> {
  const limit = Math.max(1, opts.limit ?? 25);

  // Resolve the default summarizer once. If no provider is configured and the
  // caller didn't inject one, there's nothing to do.
  let summarize = opts.summarize;
  let summarySource: SummarySource = 'original';
  if (!summarize) {
    const config = serverSummaryConfig();
    if (!config) return { generated: 0, failed: 0, skipped: 0 };
    const generator = new SummaryGenerator(config);
    summarize = (content: SessionContent) => generator.generate(content);
    summarySource = providerToSource(config.provider);
  }

  const store = await createStore();
  const cache = await createMetadataCache();
  let generated = 0;
  let failed = 0;
  let skipped = 0;
  const now = Date.now();

  try {
    // Walk indexed sessions newest-first. We over-fetch relative to `limit`
    // because most rows already have a summary (or no envelope) and get
    // skipped — we want up to `limit` *generations*, not up to `limit`
    // *candidates*. A generous cap bounds the scan on huge installs.
    const SCAN_CAP = 5000;
    const items = await store.listItems('session' as SourceType, SCAN_CAP, 0);

    for (const item of items) {
      if (generated >= limit) break;

      const cached = await cache.get(item.id);
      if (cached?.summary && cached.summary.trim().length > 0) {
        skipped++;
        continue; // already summarized
      }

      // Backoff: don't retry a session that keeps failing until the window
      // elapses. Without this a permanently-misconfigured provider would
      // burn the whole sweep on the same doomed sessions every tick.
      const err = await cache.getSummaryError(item.id);
      if (err && err.attemptCount >= MAX_SUMMARY_ATTEMPTS && now - err.lastFailedAt < RETRY_WINDOW_MS) {
        skipped++;
        continue;
      }

      // getCachedContent uses `mtime >= ?`; passing 0 returns the latest
      // synced envelope regardless of the metadata row's mtime (which may
      // lag mid-backfill).
      const raw = await store.getCachedContent(item.id, 'session', 0);
      if (!raw) {
        skipped++;
        continue; // not synced yet — nothing to summarize from
      }

      let envelope: CachedEnvelope;
      try {
        envelope = JSON.parse(raw) as CachedEnvelope;
      } catch {
        skipped++;
        continue; // corrupt envelope — leave it for a fresh sync
      }

      const content = envelopeToSessionContent(item.id, envelope);
      if (!content) {
        skipped++;
        continue;
      }

      try {
        const summary = await summarize(content);
        if (!summary || summary.trim().length === 0) {
          throw new Error('summarizer returned empty summary');
        }
        await cache.set({
          sessionId: item.id,
          firstPrompt: cached?.firstPrompt || content.firstPrompt.slice(0, 200),
          summary,
          summarySource,
          mtime: item.mtime || now,
          indexedAt: now,
        });
        await cache.clearSummaryError(item.id);
        generated++;
      } catch (e) {
        // Record + continue. One failure must not stop the sweep.
        const msg = e instanceof Error ? e.message : String(e);
        try { await cache.recordSummaryError(item.id, msg); } catch { /* best-effort */ }
        failed++;
      }
    }
  } finally {
    await store.close();
    await cache.close();
  }

  return { generated, failed, skipped };
}
