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
  createControlPlane,
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
   * Tenant to scope the store/cache to. Sessions are RLS-partitioned per
   * tenant; with no tenant the store resolves the default, which on a hosted
   * install holds zero sessions — so the sweep MUST be told which tenant to
   * walk (see sweepAllTenants). Omitted ⇒ default tenant (self-host single-user).
   */
  tenant?: string;
  /**
   * How many summaries to generate concurrently. gemma4 generation is slow on
   * CPU (~15-40s each), so sequential generation can't keep up with a backlog.
   * Concurrent requests are load-balanced across the OVMS summaries replicas
   * (KEDA-scaled). Default 1 (safe for rate-limited hosted APIs). Per tenant.
   */
  concurrency?: number;
  /**
   * Per-summary hard timeout (ms). A stalled generation must not pin a
   * concurrency slot forever; abandon it (recorded as a failure → backed off)
   * so the slot frees for the next session.
   */
  timeoutMs?: number;
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

  const store = await createStore({ tenant: opts.tenant });
  const cache = await createMetadataCache({ tenant: opts.tenant });
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? 120000);
  let generated = 0;
  let failed = 0;
  let skipped = 0;
  const now = Date.now();

  // Per-summary hard timeout: a stalled gemma4 generation must not pin a
  // concurrency slot forever. Race the summarize call against a timer.
  const summarizeBounded = async (content: SessionContent): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`summary timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([summarize!(content), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    // Phase 1 — gather up to `limit` candidates. These checks are cheap DB
    // reads (no LLM), so they stay sequential; skips don't cost a generation.
    const SCAN_CAP = 5000;
    const items = await store.listItems('session' as SourceType, SCAN_CAP, 0);
    const candidates: Array<{ id: string; mtime?: number; firstPrompt?: string; content: SessionContent }> = [];

    for (const item of items) {
      if (candidates.length >= limit) break;

      const cached = await cache.get(item.id);
      if (cached?.summary && cached.summary.trim().length > 0) { skipped++; continue; }

      // Backoff: skip a session that keeps failing until the window elapses.
      const err = await cache.getSummaryError(item.id);
      if (err && err.attemptCount >= MAX_SUMMARY_ATTEMPTS && now - err.lastFailedAt < RETRY_WINDOW_MS) {
        skipped++;
        continue;
      }

      // mtime>=0 returns the latest synced envelope regardless of metadata mtime.
      const raw = await store.getCachedContent(item.id, 'session', 0);
      if (!raw) { skipped++; continue; } // not synced yet

      let envelope: CachedEnvelope;
      try { envelope = JSON.parse(raw) as CachedEnvelope; } catch { skipped++; continue; }

      const content = envelopeToSessionContent(item.id, envelope);
      if (!content) { skipped++; continue; }

      candidates.push({ id: item.id, mtime: item.mtime, firstPrompt: cached?.firstPrompt, content });
    }

    // Phase 2 — generate concurrently. gemma4 is slow per call (~15-40s on
    // CPU), so a bounded pool of `concurrency` keeps the KEDA-scaled OVMS
    // summaries replicas busy. A timed-out/failed lane is recorded + backed off
    // and the slot moves on — one bad session never stalls the sweep.
    let cursor = 0;
    const lane = async (): Promise<void> => {
      for (let i = cursor++; i < candidates.length; i = cursor++) {
        const c = candidates[i];
        try {
          const summary = await summarizeBounded(c.content);
          if (!summary || summary.trim().length === 0) {
            throw new Error('summarizer returned empty summary');
          }
          await cache.set({
            sessionId: c.id,
            firstPrompt: c.firstPrompt || c.content.firstPrompt.slice(0, 200),
            summary,
            summarySource,
            mtime: c.mtime || now,
            indexedAt: now,
          });
          await cache.clearSummaryError(c.id);
          generated++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          try { await cache.recordSummaryError(c.id, msg); } catch { /* best-effort */ }
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => lane()));
  } finally {
    await store.close();
    await cache.close();
  }

  return { generated, failed, skipped };
}

/**
 * Tenant-aware sweep. Sessions are RLS-partitioned per tenant, so a single
 * unscoped pass only ever sees the default tenant — which on a hosted install
 * holds zero sessions, leaving every real session unsummarised (0 generated, 0
 * failed → silent). Enumerate tenants from the control plane (exactly like the
 * vector backfill worker) and run `generateMissingSummaries` for each. `limit`
 * applies per tenant so one tick stays bounded.
 */
export async function generateMissingSummariesAllTenants(
  opts: GenerateMissingOptions = {},
): Promise<GenerateMissingResult & { tenants: number }> {
  // No provider configured and no injected summarizer ⇒ nothing to do; skip the
  // control-plane round-trip entirely (mirrors generateMissingSummaries).
  if (!opts.summarize && !serverSummaryConfig()) {
    return { generated: 0, failed: 0, skipped: 0, tenants: 0 };
  }

  const cp = await createControlPlane();
  let tenants: string[] = [];
  try { tenants = await cp.listTenants(); } catch { /* fall through to default */ }
  if (tenants.length === 0) tenants = [process.env.CHAT_RECALL_TENANT || 'default'];

  let generated = 0;
  let failed = 0;
  let skipped = 0;
  let touched = 0;
  for (const tenant of tenants) {
    try {
      const r = await generateMissingSummaries({ ...opts, tenant });
      generated += r.generated;
      failed += r.failed;
      skipped += r.skipped;
      if (r.generated > 0 || r.failed > 0) touched++;
    } catch {
      // One bad tenant must never abort the whole sweep — continue.
      continue;
    }
  }
  return { generated, failed, skipped, tenants: touched };
}
