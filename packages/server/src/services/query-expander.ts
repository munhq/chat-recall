/**
 * LLM query expansion — "semantic search without embeddings".
 *
 * The cheap half of semantic search: instead of embedding the entire corpus
 * (pgvector + an embedding provider + a fleet-wide backfill + dimension
 * lock-in), we rewrite the *query* into an expanded keyword set via the LLM the
 * operator already configured for summaries, then run that against the keyword
 * (FTS) index. Meaning-aware on the query side, keyword-matched on the corpus
 * side — and the cost is one small LLM call per *search* (rare), not per chunk
 * per sync (constant).
 *
 *   "where did I set up the database"
 *     → adds: postgres migration schema connection pool dsn
 *
 * Those extra terms flow through the same FTS path (orPrefixTsQuery OR-prefixes
 * every word, ts_rank floats chunks matching more terms up), so a chunk that
 * never used the literal query words but used a synonym now surfaces.
 *
 * Config (reuses the summary LLM — one provider, two uses):
 *   QUERY_EXPANSION=on            opt-in (default off; it makes a billable LLM
 *                                 call, so silence is the safe default — same
 *                                 stance as SUMMARY_PROVIDER)
 *   SUMMARY_PROVIDER / SUMMARY_*  provider, key, model, base URL (see
 *                                 serverSummaryConfig)
 *
 * Degrades LOUDLY-then-safely: if disabled, unconfigured, or the call fails /
 * times out, it logs the reason once and returns the original query unchanged —
 * search still works, it just isn't expanded. We log rather than swallow
 * silently because a silently-degraded search feature is exactly the failure
 * mode that hid the broken vector path for months.
 */
import { defaultApiBaseUrl } from '../imports.js';
import type { SummaryGeneratorConfig } from '../imports.js';
import { serverSummaryConfig } from './summary-worker.js';

/** Providers we can call on the hot search path. CLI/gemini-cli shell out per
 *  invocation — far too slow (and unsafe) to run on every search — so they are
 *  intentionally excluded; with one of those configured, expansion stays off. */
const HOT_PATH_PROVIDERS = new Set(['claude', 'ollama', 'openai', 'nvidia', 'openai-compat', 'ollama-cloud']);

export type LlmCall = (prompt: string, signal: AbortSignal) => Promise<string>;

export interface QueryExpanderOptions {
  /** Defaults to QUERY_EXPANSION === 'on'. */
  enabled?: boolean;
  /** Defaults to serverSummaryConfig(). */
  config?: SummaryGeneratorConfig | null;
  /** Override the LLM transport (tests inject a fake; no network). */
  llmCall?: LlmCall;
}

export interface ExpandResult {
  /** The original query, unchanged. */
  query: string;
  /** Query to actually search with (original + added terms, or just original). */
  expanded: string;
  /** Terms the LLM added (already deduped against the original query). */
  addedTerms: string[];
  /** Whether expansion actually ran and contributed terms. */
  used: boolean;
}

/** Pure env read so capabilities() and the class agree on one source of truth. */
export function queryExpansionEnabled(): boolean {
  if ((process.env.QUERY_EXPANSION || '').trim().toLowerCase() !== 'on') return false;
  const cfg = serverSummaryConfig();
  return !!cfg && HOT_PATH_PROVIDERS.has(cfg.provider);
}

export class QueryExpander {
  private readonly enabled: boolean;
  private readonly config: SummaryGeneratorConfig | null;
  private readonly llmCall: LlmCall;
  // Search queries repeat constantly (SSE status ticks, pagination, retries);
  // an unbounded LLM call per repeat would be wasteful and slow. Cache the
  // added terms per normalized query, bounded FIFO.
  private readonly cache = new Map<string, string[]>();

  private static readonly MAX_CACHE = 500;
  private static readonly MAX_TERMS = 10;
  private static readonly MIN_WORDS = 3;     // single/double-word queries are already precise
  private static readonly TIMEOUT_MS = 4_000; // search must stay snappy; bail to keyword-only past this

  constructor(opts: QueryExpanderOptions = {}) {
    this.config = opts.config !== undefined ? opts.config : serverSummaryConfig();
    const envEnabled = opts.enabled !== undefined
      ? opts.enabled
      : (process.env.QUERY_EXPANSION || '').trim().toLowerCase() === 'on';
    this.enabled = envEnabled && !!this.config && HOT_PATH_PROVIDERS.has(this.config.provider);
    this.llmCall = opts.llmCall ?? ((prompt, signal) => defaultLlmCall(this.config!, prompt, signal));

    // Log the resolved state once at construction so an operator can see why
    // expansion is or isn't running without grepping for silent fallbacks.
    if (envEnabled && !this.enabled) {
      const why = !this.config
        ? 'no SUMMARY_PROVIDER configured'
        : `provider '${this.config.provider}' is not usable on the search hot path`;
      console.warn(`[query-expander] QUERY_EXPANSION=on but disabled: ${why}`);
    } else if (this.enabled) {
      console.log(`[query-expander] enabled via summary provider '${this.config!.provider}'`);
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Expand a query into original + related keywords. Always returns a usable
   * result — on any failure it falls back to the original query (used=false).
   */
  async expand(query: string): Promise<ExpandResult> {
    const original = query.trim();
    const base: ExpandResult = { query: original, expanded: original, addedTerms: [], used: false };
    if (!this.enabled || !original) return base;

    const originalWords = tokenize(original);
    // Short, precise queries ("oauth", "pg pool") don't benefit from expansion
    // and would only invite noise. Only expand natural-language queries.
    if (originalWords.length < QueryExpander.MIN_WORDS) return base;

    const key = originalWords.join(' ');
    let added = this.cache.get(key);
    if (added === undefined) {
      added = await this.fetchTerms(original, originalWords);
      this.remember(key, added);
    }
    if (added.length === 0) return base;
    return { query: original, expanded: `${original} ${added.join(' ')}`, addedTerms: added, used: true };
  }

  private async fetchTerms(query: string, originalWords: string[]): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QueryExpander.TIMEOUT_MS);
    try {
      const raw = await this.llmCall(buildExpansionPrompt(query), controller.signal);
      const seen = new Set(originalWords);
      const terms: string[] = [];
      for (const tok of tokenize(raw)) {
        if (seen.has(tok)) continue;
        seen.add(tok);
        terms.push(tok);
        if (terms.length >= QueryExpander.MAX_TERMS) break;
      }
      return terms;
    } catch (err) {
      // Fail open — keyword search still works without expansion.
      console.warn(`[query-expander] expansion failed, using keyword-only: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private remember(key: string, terms: string[]): void {
    if (this.cache.size >= QueryExpander.MAX_CACHE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, terms);
  }
}

/** Lowercase word tokens (2+ chars) — mirrors orPrefixTsQuery so expansion
 *  terms tokenize the same way the FTS layer will. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]{2,}/g) || []);
}

function buildExpansionPrompt(query: string): string {
  return [
    "You expand search queries for a developer's AI-coding chat history search engine.",
    'Given a query, list additional search keywords the developer likely used for the same topic:',
    'synonyms, related technologies, libraries, commands, and alternate phrasings.',
    'Output ONLY a single line of 6-10 space-separated lowercase keywords.',
    'No punctuation, no numbering, no explanation, no repetition of the query words.',
    '',
    `Query: ${query}`,
    'Keywords:',
  ].join('\n');
}

/**
 * Default LLM transport — the three HTTP shapes the cloud-viable summary
 * providers speak. Mirrors SummaryGenerator's provider methods but with a tiny
 * token budget (we want a keyword list, not prose) and no summary-specific
 * empty-output guard. Returns the raw model text; the caller tokenizes it.
 */
async function defaultLlmCall(config: SummaryGeneratorConfig, prompt: string, signal: AbortSignal): Promise<string> {
  const provider = config.provider;

  if (provider === 'claude') {
    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('claude expansion needs an API key (SUMMARY_API_KEY / ANTHROPIC_API_KEY)');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: config.claudeModel || config.apiModel || 'claude-3-5-haiku-20241022',
        max_tokens: 80,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
    const data = await res.json() as { content: Array<{ type: string; text?: string }> };
    return data.content.filter(b => b.type === 'text').map(b => b.text || '').join(' ').trim();
  }

  if (provider === 'ollama') {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const res = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel || config.apiModel || process.env.OLLAMA_MODEL || 'qwen2.5:7b',
        prompt,
        stream: false,
        options: { temperature: 0.2, num_predict: 80 },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama generate ${res.status}: ${res.statusText}`);
    const data = await res.json() as { response?: string };
    return (data.response || '').trim();
  }

  // openai / nvidia / openai-compat / ollama-cloud — one /chat/completions shape.
  const baseUrl = (config.apiBaseUrl || defaultApiBaseUrl(provider) || '').replace(/\/+$/, '');
  const model = config.apiModel;
  const apiKey = config.apiKey;
  if (!baseUrl) throw new Error(`provider '${provider}' needs a base URL (SUMMARY_BASE_URL)`);
  if (!model) throw new Error(`provider '${provider}' needs a model (SUMMARY_MODEL)`);
  if (!apiKey) throw new Error(`provider '${provider}' needs an API key (SUMMARY_API_KEY)`);
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 80,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`${provider} chat/completions ${res.status}: ${await res.text()}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return (data.choices?.[0]?.message?.content || '').trim();
}
