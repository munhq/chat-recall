/**
 * Token-cost pricing table.
 *
 * Used by `parseSessionFile` to compute `costUsd` per session from the
 * model_used + token counts already extracted from JSONL transcripts.
 *
 * Prices are per **million** tokens. Sources are kept in `lastReviewed`
 * so future maintenance is auditable: a stale entry produces wrong
 * dollar amounts but never garbage-tier wrong (the failure mode is
 * "off by 2x", not "shows $5000 for a $5 conversation").
 *
 * When a model id isn't in the table we return 0 rather than guessing —
 * the dossier renders a `$0` row and that's a clearer signal than a
 * confidently-wrong number.
 */

export interface PricePerMillion {
  /** Per-million input tokens (the un-cached input). */
  input: number;
  /** Per-million output tokens. */
  output: number;
  /** Per-million tokens read from prompt cache. Usually << input. */
  cacheRead: number;
  /** Per-million tokens written into the cache on creation. Usually > input. */
  cacheCreate: number;
}

export interface PriceEntry extends PricePerMillion {
  /** ISO date when this entry was last verified against the provider's pricing page. */
  lastReviewed: string;
  /** Free-form note (e.g. "Anthropic public pricing"). */
  source: string;
}

/**
 * Match a model id (often a long identifier like
 * `claude-opus-4-7-20260101`) against a pricing entry. Returns the
 * longest matching prefix so we resolve `claude-opus-4-7-20260101`
 * before `claude-opus-4` if both exist.
 *
 * Add new entries below; do not delete old ones — old session
 * transcripts still reference older model ids and the rollup needs
 * them to compute historical cost.
 */
const TABLE: Record<string, PriceEntry> = {
  // Anthropic — Claude 4.x family
  'claude-opus-4-7': {
    input: 15.0, output: 75.0, cacheRead: 1.5, cacheCreate: 18.75,
    lastReviewed: '2026-01-15', source: 'Anthropic public pricing (Opus 4.x)',
  },
  'claude-opus-4-6': {
    input: 15.0, output: 75.0, cacheRead: 1.5, cacheCreate: 18.75,
    lastReviewed: '2026-01-15', source: 'Anthropic public pricing (Opus 4.x)',
  },
  'claude-opus-4': {
    input: 15.0, output: 75.0, cacheRead: 1.5, cacheCreate: 18.75,
    lastReviewed: '2026-01-15', source: 'Anthropic public pricing (Opus 4.x)',
  },
  'claude-sonnet-4-6': {
    input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreate: 3.75,
    lastReviewed: '2026-01-15', source: 'Anthropic public pricing (Sonnet 4.x)',
  },
  'claude-sonnet-4': {
    input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreate: 3.75,
    lastReviewed: '2026-01-15', source: 'Anthropic public pricing (Sonnet 4.x)',
  },
  'claude-haiku-4-5': {
    input: 1.0, output: 5.0, cacheRead: 0.1, cacheCreate: 1.25,
    lastReviewed: '2026-01-15', source: 'Anthropic public pricing (Haiku 4.5)',
  },
  // Anthropic — older Claude 3.x (kept for back-compat with historical transcripts)
  'claude-3-7-sonnet': {
    input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreate: 3.75,
    lastReviewed: '2026-01-15', source: 'Anthropic public pricing',
  },
  'claude-3-5-sonnet': {
    input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreate: 3.75,
    lastReviewed: '2026-01-15', source: 'Anthropic public pricing',
  },
  'claude-3-5-haiku': {
    input: 0.8, output: 4.0, cacheRead: 0.08, cacheCreate: 1.0,
    lastReviewed: '2026-01-15', source: 'Anthropic public pricing',
  },
  'claude-3-opus': {
    input: 15.0, output: 75.0, cacheRead: 1.5, cacheCreate: 18.75,
    lastReviewed: '2026-01-15', source: 'Anthropic public pricing',
  },
  // OpenAI — current GPT-* (used by Codex CLI)
  'gpt-5': {
    input: 1.25, output: 10.0, cacheRead: 0.125, cacheCreate: 1.25,
    lastReviewed: '2026-01-15', source: 'OpenAI public pricing (GPT-5)',
  },
  'gpt-5-mini': {
    input: 0.25, output: 2.0, cacheRead: 0.025, cacheCreate: 0.25,
    lastReviewed: '2026-01-15', source: 'OpenAI public pricing (GPT-5 Mini)',
  },
  'gpt-4o': {
    input: 2.5, output: 10.0, cacheRead: 1.25, cacheCreate: 2.5,
    lastReviewed: '2026-01-15', source: 'OpenAI public pricing',
  },
  // Google Gemini — 2.x family (used by Gemini CLI)
  'gemini-2.5-pro': {
    input: 1.25, output: 10.0, cacheRead: 0.31, cacheCreate: 1.25,
    lastReviewed: '2026-01-15', source: 'Google AI Studio public pricing',
  },
  'gemini-2.5-flash': {
    input: 0.3, output: 2.5, cacheRead: 0.075, cacheCreate: 0.3,
    lastReviewed: '2026-01-15', source: 'Google AI Studio public pricing',
  },
};

/**
 * Pick the longest matching prefix from TABLE. Returns null when nothing
 * matches so callers can detect "unknown model" and surface $0 rather
 * than guessing.
 */
export function pricingFor(modelId: string): PriceEntry | null {
  if (!modelId) return null;
  const lower = modelId.toLowerCase();
  let best: PriceEntry | null = null;
  let bestLen = -1;
  for (const [prefix, entry] of Object.entries(TABLE)) {
    if (lower.startsWith(prefix.toLowerCase()) && prefix.length > bestLen) {
      best = entry;
      bestLen = prefix.length;
    }
  }
  return best;
}

/**
 * Compute a single session's USD cost from token counts and the set of
 * models used. When multiple models contributed to a session we apply
 * the most-expensive matching entry to the whole token bundle — close
 * enough for billing-context purposes, exact per-model breakdown would
 * require per-message token attribution which the JSONL doesn't carry.
 *
 * Token semantics match `SessionMetadata` (see parsers/session.ts):
 * `inputTokens` is the TOTAL context (un-cached input + cacheRead +
 * cacheCreate summed per message), so the un-cached portion billed at
 * the full input rate is `inputTokens - cacheReadTokens -
 * cacheCreationTokens`. Charging the full total at the input rate AND
 * the cache tokens again at cache rates double-bills every cached
 * token — on Claude Code sessions (cache-dominated) that inflated
 * costUsd by 5-10x.
 *
 * Returns `null` when no model in the set has a published price
 * (Gemini-CLI local, Ollama, custom endpoints) so callers can report
 * "unpriced" instead of a fabricated $0.
 */
export function estimateCostUsdOrNull(
  modelsUsed: string[],
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  },
): number | null {
  // Pick the most-expensive model in the set (defensive upper bound;
  // most sessions use a single model so this collapses to that model).
  let best: PriceEntry | null = null;
  let bestRate = -1;
  for (const m of modelsUsed) {
    if (!m || m === '<synthetic>') continue;
    const p = pricingFor(m);
    if (p && p.output > bestRate) {
      best = p;
      bestRate = p.output;
    }
  }
  if (!best) return null;
  const nonCachedInput = Math.max(
    0,
    tokens.inputTokens - tokens.cacheReadTokens - tokens.cacheCreationTokens,
  );
  const cost =
    (nonCachedInput / 1_000_000) * best.input +
    (tokens.outputTokens / 1_000_000) * best.output +
    (tokens.cacheReadTokens / 1_000_000) * best.cacheRead +
    (tokens.cacheCreationTokens / 1_000_000) * best.cacheCreate;
  return Math.round(cost * 100) / 100;
}

/**
 * True when a session's estimated cost is an UPPER BOUND rather than exact:
 * two or more distinct PRICED models contributed, and the whole token bundle
 * was billed at the most expensive one (per-model attribution needs
 * per-message token data the stored metadata doesn't carry yet). Callers
 * surfacing dollar figures should label such sessions "≤" / "upper bound"
 * instead of presenting the number as measured spend.
 */
export function costIsUpperBound(modelsUsed: string[]): boolean {
  const priced = new Set<string>();
  for (const m of modelsUsed) {
    if (!m || m === '<synthetic>') continue;
    if (pricingFor(m)) priced.add(m);
  }
  return priced.size > 1;
}

/** Like `estimateCostUsdOrNull` but collapses "unpriced" to 0 for callers
 *  that store a plain number (SessionMetadata.costUsd). */
export function estimateCostUsd(
  modelsUsed: string[],
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  },
): number {
  return estimateCostUsdOrNull(modelsUsed, tokens) ?? 0;
}

/** Single source of truth for the parser metadata-schema version. Bump
 *  whenever a parser adds a new `extra.*` field so the auto-indexer
 *  re-parses existing sessions on the next sweep without needing
 *  `--force`. See src/core/memory-store.ts `needsUpdate`. */
export const METADATA_VERSION = 3; // v3: costUsd no longer double-bills cached tokens
