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
  /**
   * Max REAL (LLM) summaries to produce this sweep for the tenant — the rate cap.
   * Free first_prompt fallbacks for trivial sessions are NOT counted/capped.
   * Omitted/Infinity ⇒ uncapped. Set by generateMissingSummariesAllTenants from
   * the per-tenant hourly/monthly quota (server-side; never in the published CLI).
   */
  maxReal?: number;
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

  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? 120000);
  const tenant = opts.tenant || process.env.CHAT_RECALL_TENANT || 'default';
  let generated = 0;
  let failed = 0;
  const skipped = 0;
  const now = Date.now();

  // Per-summary hard timeout: a stalled generation must not pin a concurrency
  // slot forever. Race the summarize call against a timer.
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

  // Local/single-user mode runs on the sqlite store (also the unit-test path),
  // where there's no FOR UPDATE … SKIP LOCKED, no concurrent replicas, and the
  // backlog is tiny. Use the simple store-scan there. The Postgres work queue
  // below is the server/cloud path that actually drains a large backlog.
  if ((process.env.CHAT_RECALL_STORAGE || 'sqlite') !== 'postgres') {
    return summarizeViaScan(opts, summarize, summarySource, summarizeBounded, limit, concurrency, now);
  }

  // LEASE-BASED WORK QUEUE — the worker NEVER holds a DB transaction or row lock
  // across the (multi-second) LLM call. Per tick:
  //   (1) CLAIM in a SHORT tx: pull pending rows (SKIP LOCKED), resolve trivial
  //       sessions to first_prompt INLINE (free, no LLM), and stamp a LEASE
  //       (claimed_at) on the real ones — then COMMIT (locks released in ms).
  //   (2) Run the LLM for the leased rows OUTSIDE any transaction, bounded by a
  //       FIXED concurrency semaphore (no AIMD — provider-sized, predictable).
  //   (3) Write each summary in its OWN short tx, clearing the lease.
  // A crashed worker's lease simply expires (claimed_at < now - SUMMARY_LEASE_MS)
  // and another worker re-claims the row — nothing strands. Safe across N
  // replicas (SKIP LOCKED + lease). Provider-agnostic: the LLM is just
  // summarizeBounded; swapping OVMS ↔ Ollama Cloud ↔ OpenAI changes nothing here.
  const { openPgPool, tenantTx, tenantQuery } = await import('@chat-recall/engine/core/store/pg-pool.js');
  const pool = await openPgPool(process.env.DATABASE_URL || '');
  const retryFloor = now - RETRY_WINDOW_MS;
  // Lease length: long enough for the slowest summary (LLM timeout + margin),
  // short enough that a crashed worker's rows are retried promptly.
  const LEASE_MS = Math.max(60_000, Number(process.env.SUMMARY_LEASE_MS) || 5 * 60_000);
  const leaseFloor = now - LEASE_MS;
  // Generic size triage: a session with very few turns has nothing to compress —
  // its first prompt already captures intent. Resolve those to first_prompt
  // WITHOUT an LLM call (content-agnostic, turn count only).
  const SHORT_TURN_MAX = Math.max(0, Number(process.env.SUMMARY_MIN_TURNS) || 4);
  // Claim more than we process concurrently so the LLM pool never starves between
  // claims; the fixed concurrency is the real throttle.
  const CLAIM_BATCH = Math.max(concurrency * 4, 64);
  // Per-tenant rate cap on REAL LLM summaries (free first_prompt fallbacks are
  // never capped). Infinity ⇒ uncapped (self-host / default).
  const maxReal = Number.isFinite(opts.maxReal as number) ? Math.max(0, opts.maxReal as number) : Infinity;
  let realGenerated = 0;
  const TICK_CAP = Math.max(limit, 200); // safety bound on sessions touched per tick
  let totalSeen = 0;
  let budgetExhausted = false;

  // Persist ONE finished job in its own short tx — no lock held across the LLM.
  const persist = async (o: { id: string; ok: boolean; summary?: string; source?: string; err?: string }): Promise<void> => {
    if (o.ok) {
      await tenantTx(pool, tenant, async (c: any) => {
        await c.query(
          `UPDATE session_metadata SET summary=$3, summary_source=$4, indexed_at=$5 WHERE tenant=$1 AND session_id=$2`,
          [tenant, o.id, o.summary, o.source, Date.now()]);
        await c.query(`DELETE FROM summary_leases WHERE tenant=$1 AND session_id=$2`, [tenant, o.id]);
        await c.query(`DELETE FROM summary_errors WHERE tenant=$1 AND session_id=$2`, [tenant, o.id]);
      });
      generated++;
    } else {
      await tenantTx(pool, tenant, async (c: any) => {
        // Release the lease so the row is re-claimable; the error backoff
        // (attempt_count >= MAX within RETRY_WINDOW) gates how soon it retries.
        await c.query(`DELETE FROM summary_leases WHERE tenant=$1 AND session_id=$2`, [tenant, o.id]);
        await c.query(
          `INSERT INTO summary_errors (tenant,session_id,error,attempt_count,first_failed_at,last_failed_at)
                VALUES ($1,$2,$3,1,$4,$4)
           ON CONFLICT (tenant,session_id) DO UPDATE SET error=excluded.error,
                 attempt_count=summary_errors.attempt_count+1, last_failed_at=excluded.last_failed_at`,
          [tenant, o.id, String(o.err).slice(0, 500), Date.now()]);
      });
      failed++;
    }
  };

  while (totalSeen < TICK_CAP && !budgetExhausted) {
    // (1) CLAIM (short tx) — resolve trivial inline, lease the real ones.
    const claim = await tenantTx(pool, tenant, async (client: any) => {
      const rows: any[] = (await client.query(
        `SELECT sm.session_id,
                COALESCE(NULLIF(mm.extra_json::jsonb ->> 'messageCount', '')::int, 999) AS msg_count
           FROM session_metadata sm
           LEFT JOIN memory_metadata mm
             ON mm.tenant = sm.tenant AND mm.id = sm.session_id
                AND mm.source_type = 'session' AND mm.extra_json LIKE '{%'
           LEFT JOIN summary_leases sl
             ON sl.tenant = sm.tenant AND sl.session_id = sm.session_id
          WHERE sm.tenant = $1 AND sm.summary = ''
            AND (sl.claimed_at IS NULL OR sl.claimed_at < $5)
            AND NOT EXISTS (
              SELECT 1 FROM summary_errors e
               WHERE e.tenant = sm.tenant AND e.session_id = sm.session_id
                 AND e.attempt_count >= $3 AND e.last_failed_at > $4)
          ORDER BY sm.mtime DESC
          LIMIT $2
          FOR UPDATE OF sm SKIP LOCKED`,
        [tenant, CLAIM_BATCH, MAX_SUMMARY_ATTEMPTS, retryFloor, leaseFloor])).rows;
      if (rows.length === 0) return { real: [] as string[], seen: 0 };

      let budget = maxReal - realGenerated;
      const trivialIds: string[] = [];
      const realIds: string[] = [];
      for (const r of rows) {
        if ((Number(r.msg_count) || 0) <= SHORT_TURN_MAX) trivialIds.push(r.session_id);
        else if (budget > 0) { budget--; realIds.push(r.session_id); }
        else budgetExhausted = true; // over budget → left unleased, re-claimed later
      }
      // Trivial → first_prompt inline (free), done now. left() bounds it; empty
      // first prompt falls back to a marker.
      if (trivialIds.length) {
        await client.query(
          `UPDATE session_metadata
              SET summary = COALESCE(NULLIF(left(first_prompt, 500), ''), '(short session)'),
                  summary_source = 'too_short', indexed_at = $3
            WHERE tenant = $1 AND session_id = ANY($2) AND summary = ''`,
          [tenant, trivialIds, Date.now()]);
        generated += trivialIds.length;
      }
      // Real → write the LEASE rows (separate table, no hot-table lock); the LLM
      // runs OUTSIDE this tx (step 3). ON CONFLICT refreshes an expired lease.
      if (realIds.length) {
        await client.query(
          `INSERT INTO summary_leases (tenant, session_id, claimed_at)
           SELECT $1, unnest($2::text[]), $3
           ON CONFLICT (tenant, session_id) DO UPDATE SET claimed_at = excluded.claimed_at`,
          [tenant, realIds, Date.now()]);
      }
      return { real: realIds, seen: rows.length };
    });

    totalSeen += claim.seen;
    if (claim.seen === 0) break;            // queue drained for this replica
    if (claim.real.length === 0) continue;  // batch was all trivial / over-budget

    // (2) Fetch content for the leased real sessions (one read), OUTSIDE any tx.
    const contentById = new Map<string, SessionContent>();
    const cc = (await tenantQuery(pool, tenant,
      `SELECT id, content_json FROM content_cache WHERE tenant=$1 AND source_type='session' AND id = ANY($2)`,
      [tenant, claim.real])).rows;
    for (const row of cc) {
      if (!row.content_json) continue;
      try {
        const built = envelopeToSessionContent(row.id, JSON.parse(row.content_json) as CachedEnvelope);
        if (built) contentById.set(row.id, built);
      } catch { /* leave unset → no-content fail */ }
    }

    // (3) LLM with a FIXED concurrency semaphore (lane pool), each result
    // persisted in its own short tx. The LLM never runs inside a transaction.
    let cursor = 0;
    const lane = async (): Promise<void> => {
      for (let i = cursor++; i < claim.real.length; i = cursor++) {
        const id = claim.real[i];
        const content = contentById.get(id);
        if (!content) { await persist({ id, ok: false, err: 'no synced content' }); continue; }
        try {
          const summary = await summarizeBounded(content);
          if (!summary || summary.trim().length === 0) throw new Error('summarizer returned empty summary');
          await persist({ id, ok: true, summary, source: summarySource });
          realGenerated++;
        } catch (e) {
          await persist({ id, ok: false, err: e instanceof Error ? e.message : String(e) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, claim.real.length) }, () => lane()));
  }

  return { generated, failed, skipped };
}

/**
 * Legacy store-scan path for the sqlite backend (local single-user mode + unit
 * tests): no SKIP-LOCKED, no concurrent replicas. Gathers up to `limit`
 * unsummarised sessions from a bounded scan and generates them. Kept verbatim
 * from the original implementation so behaviour on sqlite is unchanged.
 */
async function summarizeViaScan(
  opts: GenerateMissingOptions,
  summarize: (content: SessionContent) => Promise<string>,
  summarySource: SummarySource,
  summarizeBounded: (content: SessionContent) => Promise<string>,
  limit: number,
  concurrency: number,
  now: number,
): Promise<GenerateMissingResult> {
  void summarize; // resolved by the caller; summarizeBounded wraps it
  const store = await createStore({ tenant: opts.tenant });
  const cache = await createMetadataCache({ tenant: opts.tenant });
  let generated = 0;
  let failed = 0;
  let skipped = 0;
  try {
    const SCAN_CAP = 5000;
    const items = await store.listItems('session' as SourceType, SCAN_CAP, 0);
    const candidates: Array<{ id: string; mtime?: number; firstPrompt?: string; content: SessionContent }> = [];
    for (const item of items) {
      if (candidates.length >= limit) break;
      const cached = await cache.get(item.id);
      if (cached?.summary && cached.summary.trim().length > 0) { skipped++; continue; }
      const err = await cache.getSummaryError(item.id);
      if (err && err.attemptCount >= MAX_SUMMARY_ATTEMPTS && now - err.lastFailedAt < RETRY_WINDOW_MS) { skipped++; continue; }
      const raw = await store.getCachedContent(item.id, 'session', 0);
      if (!raw) { skipped++; continue; }
      let envelope: CachedEnvelope;
      try { envelope = JSON.parse(raw) as CachedEnvelope; } catch { skipped++; continue; }
      const content = envelopeToSessionContent(item.id, envelope);
      if (!content) { skipped++; continue; }
      candidates.push({ id: item.id, mtime: item.mtime, firstPrompt: cached?.firstPrompt, content });
    }
    let cursor = 0;
    const lane = async (): Promise<void> => {
      for (let i = cursor++; i < candidates.length; i = cursor++) {
        const c = candidates[i];
        try {
          const summary = await summarizeBounded(c.content);
          if (!summary || summary.trim().length === 0) throw new Error('summarizer returned empty summary');
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

  // Per-tenant rate caps on REAL (LLM) summaries — server-side abuse protection,
  // never shipped in the published client. Defaults are generous (a hard ceiling,
  // not a normal-use limit); tune down per plan via env / entitlements later.
  // Free first_prompt fallbacks for trivial sessions don't count against these.
  const HOUR_CAP = Math.max(0, Number(process.env.SUMMARY_CAP_PER_HOUR) || 2000);
  const MONTH_CAP = Math.max(0, Number(process.env.SUMMARY_CAP_PER_MONTH) || 50000);
  const { openPgPool, tenantTx } = await import('@chat-recall/engine/core/store/pg-pool.js');
  const pool = await openPgPool(process.env.DATABASE_URL || '');
  const nowMs = Date.now();
  const hourAgo = nowMs - 3_600_000;
  const md = new Date(nowMs);
  const monthStart = Date.UTC(md.getUTCFullYear(), md.getUTCMonth(), 1);

  let generated = 0;
  let failed = 0;
  let skipped = 0;
  let touched = 0;
  for (const tenant of tenants) {
    try {
      // Compute this tenant's remaining real-summary budget. Real = an LLM-written
      // summary (excludes '' / 'original' / 'too_short'). If the usage probe fails,
      // fall back to uncapped rather than block summarizing.
      let maxReal = Infinity;
      try {
        const u = await tenantTx(pool, tenant, async (c: any) => (await c.query(
          `SELECT count(*) FILTER (WHERE indexed_at >= $2) AS hour,
                  count(*) FILTER (WHERE indexed_at >= $3) AS month
             FROM session_metadata
            WHERE tenant = $1 AND summary <> '' AND summary_source NOT IN ('original','too_short')`,
          [tenant, hourAgo, monthStart])).rows[0]);
        const usedHour = Number(u?.hour || 0);
        const usedMonth = Number(u?.month || 0);
        maxReal = Math.max(0, Math.min(HOUR_CAP - usedHour, MONTH_CAP - usedMonth));
      } catch { maxReal = Infinity; }

      const r = await generateMissingSummaries({ ...opts, tenant, maxReal });
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
