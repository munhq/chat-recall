/**
 * Embedding providers for chat-recall.
 *
 * Supports multiple backends:
 * - Ollama (default): Local embeddings with nomic-embed-text
 * - Gemini (optional): Google's text-embedding-004 model
 */

import { createLogger } from './logger.js';

const log = createLogger('embedder');

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
  readonly dimension: number;
}

/**
 * Ollama embedding provider using nomic-embed-text.
 *
 * Requires Ollama running locally with the model pulled:
 *   ollama pull nomic-embed-text
 *
 * Environment variable:
 *   OLLAMA_HOST: Ollama server URL (default: http://localhost:11434)
 */
export class OllamaEmbedder implements Embedder {
  static readonly MODEL = 'nomic-embed-text';
  static readonly DIMENSION = 768;

  private host: string;
  private model: string;
  /** Optional bearer token for Ollama Cloud (Turbo). Local Ollama leaves this blank. */
  private apiKey?: string;

  constructor(host?: string, model?: string, apiKey?: string) {
    this.host = host || process.env.OLLAMA_HOST || 'http://localhost:11434';
    this.model = model || OllamaEmbedder.MODEL;
    this.apiKey = apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    for (const text of texts) {
      const embedding = await this.embedSingle(text);
      embeddings.push(embedding);
    }
    return embeddings;
  }

  async embedQuery(query: string): Promise<number[]> {
    return this.embedSingle(query);
  }

  private async embedSingle(text: string): Promise<number[]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const response = await fetch(`${this.host}/api/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.model, prompt: text }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Ollama request to ${this.host} failed: ${response.status} ${response.statusText}${body ? ' – ' + body.slice(0, 200) : ''}`);
    }

    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  }

  get dimension(): number {
    return OllamaEmbedder.DIMENSION;
  }
}

/**
 * Gemini embedding provider using text-embedding-004.
 *
 * Environment variable:
 *   GEMINI_API_KEY or GOOGLE_API_KEY: Your Google AI API key
 */
export class GeminiEmbedder implements Embedder {
  static readonly MODEL = 'text-embedding-004';
  static readonly DIMENSION = 768;
  static readonly BATCH_SIZE = 100;
  
  private apiKey: string;
  
  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    
    if (!this.apiKey) {
      throw new Error(
        'Gemini API key not found. Set GEMINI_API_KEY or GOOGLE_API_KEY environment variable.'
      );
    }
  }
  
  async embed(texts: string[]): Promise<number[][]> {
    const allEmbeddings: number[][] = [];
    
    for (let i = 0; i < texts.length; i += GeminiEmbedder.BATCH_SIZE) {
      const batch = texts.slice(i, i + GeminiEmbedder.BATCH_SIZE);
      const batchEmbeddings = await this.embedBatch(batch);
      allEmbeddings.push(...batchEmbeddings);
    }
    
    return allEmbeddings;
  }
  
  async embedQuery(query: string): Promise<number[]> {
    const url = `https://generativelanguage.googleapis.com/v1/models/${GeminiEmbedder.MODEL}:embedContent?key=${this.apiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${GeminiEmbedder.MODEL}`,
        content: { parts: [{ text: query }] },
        taskType: 'RETRIEVAL_QUERY',
      }),
    });
    
    if (!response.ok) {
      throw new Error(`Gemini request failed: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json() as { embedding: { values: number[] } };
    return data.embedding.values;
  }
  
  private async embedBatch(texts: string[]): Promise<number[][]> {
    const url = `https://generativelanguage.googleapis.com/v1/models/${GeminiEmbedder.MODEL}:batchEmbedContents?key=${this.apiKey}`;
    
    const requests = texts.map(text => ({
      model: `models/${GeminiEmbedder.MODEL}`,
      content: { parts: [{ text }] },
      taskType: 'RETRIEVAL_DOCUMENT',
    }));
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
    
    if (!response.ok) {
      throw new Error(`Gemini batch request failed: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json() as { embeddings: Array<{ values: number[] }> };
    return data.embeddings.map(e => e.values);
  }
  
  get dimension(): number {
    return GeminiEmbedder.DIMENSION;
  }
}

/**
 * Generic embedder for any provider that speaks the OpenAI embeddings API:
 *   POST {baseUrl}/embeddings
 *   { "input": [...], "model": "..." }
 *   → { "data": [{ "embedding": [...] }, ...] }
 *
 * Used for OpenAI (`https://api.openai.com/v1`), Nvidia NIM
 * (`https://integrate.api.nvidia.com/v1`), and any local OpenAI-compatible
 * server (LocalAI, vLLM, llama.cpp's HTTP server, Ollama's `/v1` shim).
 *
 * This single class subsumes three providers because the wire format is
 * identical — only base URL, model name, and dimension differ.
 */
export class OpenAICompatibleEmbedder implements Embedder {
  // Texts sent per /embeddings request. A self-hosted server (OVMS, vLLM,
  // llama.cpp) runs the whole array through one forward pass, so a wide batch
  // of long passages allocates batch × seq × hidden × layers of activations at
  // once — 100 wide OOMKilled the OVMS qwen3-embedding pod even at a 16Gi limit
  // (the 0.6GB weights were never the problem; the batch was). Default 32 is
  // safe for hosted APIs; override with EMBED_BATCH_SIZE for memory-bound
  // self-hosted servers (we run 16 against OVMS).
  static readonly BATCH_SIZE = (() => {
    const n = Number(process.env.EMBED_BATCH_SIZE);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 32;
  })();

  // How many /embeddings requests to keep in flight at once. Sequential (1) is
  // safe for rate-limited hosted APIs (OpenAI/Gemini 429 on bursts). A
  // self-hosted server with multiple OpenVINO streams sits idle unless the
  // client feeds it concurrently — set EMBED_CONCURRENCY to match the server's
  // NUM_STREAMS (we run 8 against OVMS on the 48-core node).
  static readonly CONCURRENCY = (() => {
    const n = Number(process.env.EMBED_CONCURRENCY);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  })();

  // Per-request hard timeout (ms). A CPU embed server under concurrent load can
  // stall a single request; abort + retry rather than hang the lane.
  static readonly TIMEOUT_MS = (() => {
    const n = Number(process.env.EMBED_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60000;
  })();

  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private _dimension: number;
  /**
   * Extra fields injected into every request body. NVIDIA's asymmetric
   * embedding models (nv-embedqa-*) reject requests without `input_type`,
   * which isn't part of the OpenAI shape; we stuff it into the body to keep
   * one class generic. Other providers ignore unknown fields.
   */
  private extraBody?: Record<string, unknown>;

  constructor(opts: { baseUrl: string; apiKey?: string; model: string; dimension: number; extraBody?: Record<string, unknown> }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? '';
    this.model = opts.model;
    this._dimension = opts.dimension;
    this.extraBody = opts.extraBody;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Bulk passage embedding (the backfill). RESILIENT: if a sub-batch times out
    // / fails, its texts come back as holes instead of throwing — so the
    // sub-batches that DID succeed still persist (the caller skips holes and
    // retries them next sweep). Without this, one slow sub-batch (a cold pod, a
    // long chunk) aborted the whole 256-chunk batch → 0 progress, forever.
    return this.embedWithType(texts, 'passage', true);
  }

  async embedQuery(query: string): Promise<number[]> {
    // A single query is all-or-nothing — let it throw on failure (no resilience).
    const [v] = await this.embedWithType([query], 'query');
    return v;
  }

  private async embedWithType(texts: string[], inputType: 'query' | 'passage', resilient = false): Promise<number[][]> {
    // Split into BATCH_SIZE slices, then drain them through a bounded worker
    // pool of CONCURRENCY in-flight requests. Results are written back by index
    // so the returned order matches `texts` regardless of completion order.
    const slices: string[][] = [];
    for (let i = 0; i < texts.length; i += OpenAICompatibleEmbedder.BATCH_SIZE) {
      slices.push(texts.slice(i, i + OpenAICompatibleEmbedder.BATCH_SIZE));
    }
    // Per-slice results; a failed slice (resilient mode) stays a null-filled
    // array so flat() keeps index alignment and the caller skips the holes.
    const results: (number[] | null)[][] = new Array(slices.length);
    let cursor = 0;
    let failed = 0;
    const worker = async (): Promise<void> => {
      for (let idx = cursor++; idx < slices.length; idx = cursor++) {
        try {
          results[idx] = await this.embedBatch(slices[idx], inputType);
        } catch (e) {
          if (!resilient) throw e;
          results[idx] = slices[idx].map(() => null);
          failed += slices[idx].length;
        }
      }
    };
    const lanes = Math.max(1, Math.min(OpenAICompatibleEmbedder.CONCURRENCY, slices.length));
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    if (failed > 0) {
      log.warn({ failed, total: texts.length }, 'texts failed this batch — persisting the rest, will retry the failures');
    }
    return results.flat() as number[][];
  }

  // Retry-wrapping front for embedBatchOnce. A self-hosted CPU server (OVMS)
  // briefly overloaded by concurrent batches drops/stalls requests ("fetch
  // failed" / undici "terminated"); without a retry, one slow sub-batch threw
  // and Promise.all zeroed the entire 256-chunk backfill batch → 0 progress.
  // Retry transient failures (network/timeout/5xx) a few times with backoff so
  // a momentary overload self-heals instead of failing the whole sweep.
  private async embedBatch(input: string[], inputType: 'query' | 'passage'): Promise<number[][]> {
    const ATTEMPTS = 4;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        return await this.embedBatchOnce(input, inputType);
      } catch (e) {
        lastErr = e;
        if (attempt === ATTEMPTS) break;
        // Exponential backoff (0.5s, 1s, 2s) lets a transient overload drain.
        await new Promise(r => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
    throw lastErr;
  }

  private async embedBatchOnce(input: string[], inputType: 'query' | 'passage'): Promise<number[][]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Local servers (LocalAI, llama.cpp, vLLM with no auth) often run keyless.
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    // Build the request body. extraBody takes priority for provider-specific
    // tweaks (e.g. NVIDIA's input_type). Mainstream providers (OpenAI) ignore
    // unknown fields.
    const body: Record<string, unknown> = { model: this.model, input };
    if (this.extraBody?.['input_type'] !== undefined) {
      // Override with the per-call kind so query→"query", batch→"passage".
      body.input_type = inputType;
    } else if (this.extraBody) {
      Object.assign(body, this.extraBody);
    }

    // Hard timeout: a CPU embed server can stall a request indefinitely under
    // load; without this the lane hangs until undici eventually "terminated"s
    // it. Abort at EMBED_TIMEOUT_MS so the retry wrapper can re-issue.
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), OpenAICompatibleEmbedder.TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(`Embedding request to ${this.baseUrl} failed: ${res.status} ${res.statusText}${msg ? ' – ' + msg.slice(0, 200) : ''}`);
    }
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    if (!Array.isArray(data?.data)) {
      throw new Error(`Embedding response from ${this.baseUrl} did not include a "data" array`);
    }
    return data.data.map(d => this.fit(d.embedding));
  }

  /**
   * Make a returned vector match the configured dimension. Matryoshka (MRL)
   * models — e.g. qwen3-embedding (native 1024) — let you keep the first N
   * components and re-normalize to get a valid N-dim embedding. We do this
   * CLIENT-SIDE (not via a `dimensions` request hint) so it works regardless of
   * whether the serving layer honors the hint (Ollama's /v1 shim ignores it).
   * A no-op when the model already returns exactly `_dimension`.
   */
  private fit(v: number[]): number[] {
    if (v.length === this._dimension) return v;
    if (v.length < this._dimension) {
      throw new Error(`Embedding model ${this.model} returned ${v.length} dims < configured ${this._dimension}; lower OPENAI_COMPAT_DIMENSION or pick another model.`);
    }
    const t = v.slice(0, this._dimension);
    let norm = 0;
    for (const x of t) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return t.map(x => x / norm);
  }

  get dimension(): number { return this._dimension; }
}

/**
 * Built-in presets for hosted OpenAI-compatible embedding endpoints.
 *
 * Each preset hardcodes the base URL, default model, and embedding dimension
 * so the user only has to drop in an API key. The auth key envvar varies per
 * provider — NVIDIA uses `nvapi-…`, OpenAI uses `sk-…`, etc.; the
 * OpenAICompatibleEmbedder doesn't care, it just sends `Authorization: Bearer
 * <key>` to whatever URL we point it at.
 *
 * `openai-compat` is the generic escape hatch for anything else that speaks
 * the OpenAI shape — OpenRouter (when they ship embeddings), Together,
 * DeepInfra, LocalAI, vLLM, llama.cpp's HTTP server.
 */
export const OPENAI_COMPAT_PRESETS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
    dimension: 1536,
    apiKeyEnv: 'OPENAI_API_KEY',
    label: 'OpenAI (text-embedding-3-small)',
  },
  // NVIDIA NIM exposes embeddings at the OpenAI shape; the API key has the
  // `nvapi-…` prefix. Default to the recommended retrieval embedder.
  nvidia: {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'nvidia/nv-embedqa-e5-v5',
    dimension: 1024,
    apiKeyEnv: 'NVIDIA_API_KEY',
    label: 'NVIDIA NIM (nv-embedqa-e5-v5)',
  },
  // NOTE: Ollama Cloud is intentionally NOT in this list. Their hosted
  // catalog (verified 2026-04-27) ships only chat / coding / multimodal
  // models — zero embedding models. So Ollama Cloud only makes sense as a
  // *summary* provider, not an embedder. See settings.ts.
} as const;

export type EmbedderProvider =
  | 'none'
  | 'ollama'
  | 'gemini'
  | 'openai'
  | 'nvidia'
  | 'openai-compat';

/**
 * Sentinel for "no embedder configured" — search falls back to FTS5.
 */
export class NoneEmbedder implements Embedder {
  readonly dimension = 0;
  async embed(): Promise<number[][]> {
    throw new Error('No embedding provider configured. Search will use FTS5 keyword fallback.');
  }
  async embedQuery(): Promise<number[]> {
    throw new Error('No embedding provider configured.');
  }
}

/**
 * Construct an embedder. The default is `none` — chat-recall works without an
 * embedder by falling back to SQLite FTS5 keyword search; vector search is
 * an upgrade users opt in to. For OpenAI-compatible providers, the API key
 * comes from a per-provider env var (NVIDIA_API_KEY, OPENAI_API_KEY,
 * OLLAMA_API_KEY, …); `openai-compat` reads OPENAI_COMPAT_BASE_URL/MODEL/
 * DIMENSION so users can point it at OpenRouter, LocalAI, vLLM, etc.
 */
export function getEmbedder(provider: EmbedderProvider = 'none'): Embedder {
  switch (provider) {
    case 'none':
      return new NoneEmbedder();
    case 'ollama':
      return new OllamaEmbedder();
    case 'gemini':
      return new GeminiEmbedder();
    case 'openai': {
      const p = OPENAI_COMPAT_PRESETS.openai;
      const key = process.env[p.apiKeyEnv];
      if (!key) throw new Error(`${p.label} embedder requires ${p.apiKeyEnv}.`);
      return new OpenAICompatibleEmbedder({ baseUrl: p.baseUrl, apiKey: key, model: p.model, dimension: p.dimension });
    }
    case 'nvidia': {
      // NVIDIA NIM's asymmetric embedders (nv-embedqa-*) require input_type
      // = "query" or "passage" in the body. We mark the field present in
      // extraBody as a sentinel; OpenAICompatibleEmbedder fills the right
      // value per call.
      const p = OPENAI_COMPAT_PRESETS.nvidia;
      const key = process.env[p.apiKeyEnv];
      if (!key) throw new Error(`${p.label} embedder requires ${p.apiKeyEnv}.`);
      return new OpenAICompatibleEmbedder({
        baseUrl: p.baseUrl, apiKey: key, model: p.model, dimension: p.dimension,
        extraBody: { input_type: 'query' },
      });
    }
    case 'openai-compat': {
      const baseUrl = process.env.OPENAI_COMPAT_BASE_URL;
      const model = process.env.OPENAI_COMPAT_MODEL;
      const dim = process.env.OPENAI_COMPAT_DIMENSION;
      if (!baseUrl || !model || !dim) {
        throw new Error('openai-compat embedder requires OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_MODEL, OPENAI_COMPAT_DIMENSION env vars (API key optional via OPENAI_COMPAT_API_KEY for unauthenticated local servers).');
      }
      return new OpenAICompatibleEmbedder({
        baseUrl,
        apiKey: process.env.OPENAI_COMPAT_API_KEY,
        model,
        dimension: parseInt(dim, 10),
      });
    }
    default:
      throw new Error(`Unknown provider: ${provider}. Available: none, ollama, gemini, openai, nvidia, openai-compat`);
  }
}
