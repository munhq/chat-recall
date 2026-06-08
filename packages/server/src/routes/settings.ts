/**
 * Settings routes — backed by ~/.claude/chat-recall/settings.json (mode 0600).
 *
 * The frontend never sees raw API keys — they're masked by `redactSettings`
 * before the response leaves the server. Updates that contain a masked
 * placeholder ("••••xxxx") are interpreted as "leave that secret untouched".
 *
 * Endpoints:
 *   GET  /api/settings           → current redacted settings + presets + status
 *   PUT  /api/settings           → save partial update; secrets keep prior value if masked
 *   POST /api/settings/test      → probe a provider config without saving
 */
import express from 'express';
import {
  loadSettings, saveSettings, redactSettings, mergeSettings, applySettingsToEnv,
  SUMMARY_CLI_PRESET_COMMANDS,
  defaultApiBaseUrl,
} from '../imports.js';
import type { AppSettings, EmbeddingSettings, SummarySettings } from '../imports.js';

const router = express.Router();

const SUMMARY_CLI_PRESETS = [
  'opencode', 'kilocode', 'gemini', 'claude-cli', 'llm', 'aichat',
] as const;

const PRESETS = {
  // Ordered free → paid → escape-hatch. Ollama Cloud is deliberately NOT
  // here — Cloud's catalog has zero embedding models (chat-only). It is a
  // valid SUMMARY provider though, see below.
  embeddingProviders: ['none', 'ollama', 'nvidia', 'gemini', 'openai', 'openai-compat'] as const,
  // Summary providers implemented in src/core/summary-generator.ts:
  // 'cli' (with preset), 'ollama' (local), 'claude' (Anthropic API), and the
  // OpenAI-compatible HTTP family ('openai-compat' / 'ollama-cloud' / 'openai'
  // / 'nvidia' — one /chat/completions backend), plus 'none'.
  summaryProviders:   ['none', 'cli', 'ollama', 'claude', 'openai-compat', 'ollama-cloud', 'openai', 'nvidia'] as const,
  summaryCliPresets:  SUMMARY_CLI_PRESETS,
  // Resolved command line for each preset — surfaced to the UI so picking a
  // preset shows (and pre-fills) the actual command that will run. Without
  // this the "Custom command" field is empty after picking a preset and the
  // CLI provider silently does nothing.
  summaryCliPresetCommands: SUMMARY_CLI_PRESET_COMMANDS,
  embeddingHints: {
    none:             { label: 'None — keyword search only (FTS5)', requires: 'Nothing. Works out of the box.' },
    ollama:           { label: 'Ollama (local, free) — recommended', requires: 'Ollama running locally + `ollama pull nomic-embed-text`. No key, no upload.' },
    nvidia:           { label: 'NVIDIA NIM (free credits at signup) ✓ verified', requires: 'NVIDIA_API_KEY (`nvapi-…` from build.nvidia.com)' },
    gemini:           { label: 'Google Gemini (free tier ~100 req/day)', requires: 'GEMINI_API_KEY (same key as the gemini CLI)' },
    openai:           { label: 'OpenAI (paid, no free tier)', requires: 'OPENAI_API_KEY' },
    'openai-compat':  { label: 'Custom OpenAI-compatible endpoint', requires: 'Base URL + model + dimension. For LocalAI, vLLM, llama.cpp HTTP server, etc. Note: OpenRouter currently proxies embeddings to OpenAI and requires paid credits.' },
  },
  summaryHints: {
    none:   { label: 'None — use first prompt as fallback', requires: 'Nothing.' },
    cli:    { label: 'Local CLI', requires: 'Detect or pick an installed AI CLI' },
    ollama: { label: 'Ollama (local)', requires: 'Ollama + a chat model (e.g. `qwen2.5:7b`)' },
    claude: { label: 'Anthropic Claude API', requires: 'ANTHROPIC_API_KEY' },
    'openai-compat': { label: 'OpenRouter / custom OpenAI-compatible', requires: 'Base URL + model + API key (e.g. openrouter.ai/api/v1)' },
    'ollama-cloud':  { label: 'Ollama Cloud', requires: 'API key + model (ollama.com/v1)' },
    openai:          { label: 'OpenAI API', requires: 'OPENAI_API_KEY + model' },
    nvidia:          { label: 'NVIDIA NIM', requires: 'NVIDIA_API_KEY + model' },
  },
} as const;

/** Probe whether Ollama is reachable and which models are pulled. */
async function probeOllama(host: string): Promise<{ reachable: boolean; models?: string[]; error?: string }> {
  const url = `${host.replace(/\/+$/, '')}/api/tags`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { reachable: false, error: `${r.status} ${r.statusText}` };
    const d = await r.json() as { models?: Array<{ name: string }> };
    return { reachable: true, models: (d.models || []).map(m => m.name) };
  } catch (e) {
    return { reachable: false, error: (e as Error).message };
  }
}

/** Best-effort detection: does the `gemini` CLI binary exist on PATH? */
async function probeGeminiCli(): Promise<{ available: boolean; version?: string }> {
  const { execFile } = await import('node:child_process');
  return new Promise(resolve => {
    execFile('gemini', ['--version'], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve({ available: false });
      resolve({ available: true, version: stdout.trim().slice(0, 80) });
    });
  });
}

async function probeCli(cmd: string): Promise<{ available: boolean }> {
  const { execFile } = await import('node:child_process');
  // Just check the bare binary exists — `which`-style.
  const bin = cmd.split(/\s+/)[0];
  return new Promise(resolve => {
    execFile('which', [bin], { timeout: 1500 }, (err) => resolve({ available: !err }));
  });
}

/** Map preset name → bare binary used by that preset (first whitespace token). */
const PRESET_BIN: Record<string, string> = Object.fromEntries(
  Object.entries(SUMMARY_CLI_PRESET_COMMANDS).map(([preset, cmd]) => [preset, cmd.split(/\s+/)[0]]),
);

/** Probe each known CLI binary in parallel — used by the UI to grey out missing ones. */
async function probeAllCliPresets(): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    Object.entries(PRESET_BIN).map(async ([preset, bin]) => {
      const { available } = await probeCli(bin);
      return [preset, available] as const;
    }),
  );
  return Object.fromEntries(entries);
}

router.get('/', async (_req, res) => {
  try {
    const settings = loadSettings();
    const status: Record<string, any> = {};

    // Background-probe whichever providers are currently selected. Cheap (<2s).
    if (settings.embedding.provider === 'ollama') {
      status.ollama = await probeOllama(settings.embedding.ollamaHost || process.env.OLLAMA_HOST || 'http://localhost:11434');
    }
    if (settings.summary.provider === 'gemini-cli') {
      status.geminiCli = await probeGeminiCli();
    } else if (settings.summary.provider === 'cli' && settings.summary.cliCommand) {
      status.cli = await probeCli(settings.summary.cliCommand);
    }

    // Always probe the full preset list so the UI can render detected/missing
    // badges for every CLI without requiring the user to pick one first.
    status.cliDetected = await probeAllCliPresets();

    res.json({
      settings: redactSettings(settings),
      presets: PRESETS,
      status,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.put('/', (req, res) => {
  try {
    const update = req.body as Partial<AppSettings>;
    const current = loadSettings();
    const merged = mergeSettings(current, update);

    // Light validation — provider names must be in the preset list.
    if (merged.embedding.provider && !PRESETS.embeddingProviders.includes(merged.embedding.provider as any)) {
      return res.status(400).json({ error: `Unknown embedding provider: ${merged.embedding.provider}` });
    }
    if (merged.summary.provider && !PRESETS.summaryProviders.includes(merged.summary.provider as any)) {
      return res.status(400).json({ error: `Unknown summary provider: ${merged.summary.provider}` });
    }

    saveSettings(merged);
    applySettingsToEnv(merged);

    res.json({
      ok: true,
      settings: redactSettings(merged),
      restartHint: 'CLI/MCP processes pick up changes on next start. The web server reloads on next request.',
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/settings/test  body: { kind: 'embedding' | 'summary', config: ... }
 * Probes the provider without saving — used by the "Test connection" button.
 */
router.post('/test', async (req, res) => {
  const { kind, config } = req.body || {};
  try {
    // Resolve masked keys ("••••…") the UI sends back to the saved secret, so a
    // Test never ships the mask as a Bearer token — '•' is U+2022, outside
    // latin1, so it throws "Cannot convert argument to a ByteString" when the
    // Authorization header is built. Mirrors the GET /models resolution.
    if (config) {
      const saved = loadSettings();
      const unmask = (v: unknown, s: string | undefined) =>
        (typeof v === 'string' && v.startsWith('••••')) ? s : v;
      if (kind === 'summary') {
        config.apiKey = unmask(config.apiKey, saved.summary.apiKey);
        config.anthropicApiKey = unmask(config.anthropicApiKey, saved.summary.anthropicApiKey);
      } else if (kind === 'embedding') {
        config.nvidiaApiKey = unmask(config.nvidiaApiKey, saved.embedding.nvidiaApiKey);
        config.openaiApiKey = unmask(config.openaiApiKey, saved.embedding.openaiApiKey);
        config.geminiApiKey = unmask(config.geminiApiKey, saved.embedding.geminiApiKey);
        config.ollamaCloudApiKey = unmask(config.ollamaCloudApiKey, saved.embedding.ollamaCloudApiKey);
        config.openaiCompatApiKey = unmask(config.openaiCompatApiKey, saved.embedding.openaiCompatApiKey);
      }
    }
    if (kind === 'embedding') {
      const e = config as EmbeddingSettings;
      // For each provider, do a minimal "is this thing reachable" check.
      switch (e.provider) {
        case 'ollama': {
          const probe = await probeOllama(e.ollamaHost || 'http://localhost:11434');
          if (!probe.reachable) return res.json({ ok: false, error: probe.error || 'unreachable' });
          const wanted = e.ollamaModel || 'nomic-embed-text';
          const has = probe.models?.some(m => m === wanted || m.startsWith(wanted + ':'));
          return res.json({
            ok: !!has,
            error: has ? undefined : `Ollama is up but "${wanted}" is not pulled. Run: ollama pull ${wanted}`,
            models: probe.models,
          });
        }
        case 'gemini':
        case 'openai':
        case 'nvidia':
        case 'openai-compat': {
          // Apply the test config to env so getEmbedder() can read it, then
          // try a one-token embed. We do this in a child-isolation-free way
          // because the caller is already authenticated to the API.
          const settings = loadSettings();
          const testSettings = { ...settings, embedding: e } as AppSettings;
          applySettingsToEnv(testSettings);
          const { getEmbedder } = await import('../imports.js');
          try {
            const embedder = getEmbedder(e.provider as any);
            const v = await embedder.embedQuery('test');
            return res.json({ ok: Array.isArray(v) && v.length > 0, dimension: v.length });
          } catch (err) {
            return res.json({ ok: false, error: (err as Error).message });
          } finally {
            // Restore env from the actual saved settings so the test doesn't
            // leak credentials into the running process.
            applySettingsToEnv(settings);
          }
        }
        case 'none':
          return res.json({ ok: true, note: 'No embedder. Search will use FTS5.' });
        default:
          return res.status(400).json({ ok: false, error: `Unknown provider: ${e.provider}` });
      }
    }

    if (kind === 'summary') {
      const s = config as SummarySettings;
      switch (s.provider) {
        case 'gemini-cli': {
          const probe = await probeGeminiCli();
          return res.json({ ok: probe.available, version: probe.version, error: probe.available ? undefined : '`gemini` CLI not on PATH' });
        }
        case 'cli': {
          if (!s.cliCommand && !s.cliPreset) return res.json({ ok: false, error: 'Set a CLI command or pick a preset.' });
          const cmd = s.cliCommand
            || (s.cliPreset && SUMMARY_CLI_PRESET_COMMANDS[s.cliPreset])
            || `${s.cliPreset} -p " "`;
          const probe = await probeCli(cmd);
          return res.json({ ok: probe.available, error: probe.available ? undefined : `Command not found: ${cmd.split(/\s+/)[0]}` });
        }
        case 'ollama': {
          const settings = loadSettings();
          const host = settings.embedding.ollamaHost || 'http://localhost:11434';
          const probe = await probeOllama(host);
          if (!probe.reachable) return res.json({ ok: false, error: probe.error });
          const want = s.ollamaModel || 'qwen2.5:7b';
          const has = probe.models?.some(m => m === want || m.startsWith(want + ':'));
          return res.json({ ok: !!has, error: has ? undefined : `Pull the chat model first: ollama pull ${want}` });
        }
        case 'claude': {
          const key = s.anthropicApiKey;
          if (!key) return res.json({ ok: false, error: 'ANTHROPIC_API_KEY not set' });
          // Minimal HEAD-style probe: list models endpoint.
          try {
            const r = await fetch('https://api.anthropic.com/v1/models', {
              headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            });
            if (!r.ok) return res.json({ ok: false, error: `Anthropic API: ${r.status} ${r.statusText}` });
            return res.json({ ok: true });
          } catch (err) {
            return res.json({ ok: false, error: (err as Error).message });
          }
        }
        case 'openai-compat':
        case 'ollama-cloud':
        case 'openai':
        case 'nvidia': {
          const base = (s.apiBaseUrl || defaultApiBaseUrl(s.provider) || '').replace(/\/+$/, '');
          if (!base) return res.json({ ok: false, error: 'Set a base URL (e.g. https://openrouter.ai/api/v1)' });
          if (!s.apiModel) return res.json({ ok: false, error: 'Set a model' });
          if (!s.apiKey) return res.json({ ok: false, error: 'Set an API key' });
          try {
            const r = await fetch(`${base}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
              body: JSON.stringify({ model: s.apiModel, messages: [{ role: 'user', content: 'Reply with: ok' }], max_tokens: 5 }),
            });
            if (!r.ok) {
              const body = await r.text().catch(() => '');
              return res.json({ ok: false, error: `${base}: ${r.status} ${r.statusText} ${body.slice(0, 160)}` });
            }
            return res.json({ ok: true });
          } catch (err) {
            return res.json({ ok: false, error: (err as Error).message });
          }
        }
        case 'none':
          return res.json({ ok: true, note: 'No summary generator. First prompt will be used as a fallback.' });
        default:
          return res.status(400).json({ ok: false, error: `Unknown provider: ${s.provider}` });
      }
    }

    return res.status(400).json({ error: 'kind must be "embedding" or "summary"' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/settings/models?kind=&provider=&baseUrl=&apiKey=
 * Lists the models a provider offers so the UI can populate a dropdown
 * instead of hand-typing a model id. Works for both `summary` and
 * `embedding`. Local ollama → /api/tags; everything OpenAI-compatible →
 * {base}/models. The list is public for OpenRouter & Ollama Cloud (no key);
 * NVIDIA/OpenAI need the key. A masked key ("••••…") resolves to the saved one.
 */
router.get('/models', async (req, res) => {
  try {
    const kind = String(req.query.kind || 'summary');
    const provider = String(req.query.provider || '');
    const reqKey = req.query.apiKey ? String(req.query.apiKey) : undefined;
    const s = loadSettings();

    // Resolve the saved key when the UI sends a mask (so users don't retype).
    const savedKey = (() => {
      if (kind === 'summary') return s.summary.apiKey;
      switch (provider) {
        case 'nvidia':        return s.embedding.nvidiaApiKey;
        case 'openai':        return s.embedding.openaiApiKey;
        case 'gemini':        return s.embedding.geminiApiKey;
        case 'ollama-cloud':  return s.embedding.ollamaCloudApiKey;
        case 'openai-compat': return s.embedding.openaiCompatApiKey;
        default:              return undefined;
      }
    })();
    const key = (reqKey && reqKey.startsWith('••••')) ? savedKey : reqKey;

    if (provider === 'ollama') {
      const host = (req.query.baseUrl ? String(req.query.baseUrl) : (s.embedding.ollamaHost || 'http://localhost:11434')).replace(/\/+$/, '');
      const r = await fetch(`${host}/api/tags`);
      if (!r.ok) return res.json({ models: [], error: `Ollama: ${r.status} ${r.statusText}` });
      const d = await r.json() as { models?: Array<{ name: string }> };
      return res.json({ models: (d.models || []).map(m => ({ id: m.name })).sort((a, b) => a.id.localeCompare(b.id)) });
    }

    const reqBase = req.query.baseUrl ? String(req.query.baseUrl) : undefined;
    const base = (reqBase
      || (kind === 'embedding' && provider === 'openai-compat' ? s.embedding.openaiCompatBaseUrl : undefined)
      || defaultApiBaseUrl(provider) || '').replace(/\/+$/, '');
    if (!base) return res.json({ models: [], error: 'Set a base URL first.' });
    const r = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return res.json({ models: [], error: `${base}/models: ${r.status} ${r.statusText} ${body.slice(0, 120)}` });
    }
    // Alphabetical. Pricing, when the provider returns it (OpenRouter), is
    // shown in the label as $/M tokens — info only, not a sort key.
    const d = await r.json() as { data?: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }> };
    const rows = (d.data || []).filter(m => m.id).map(m => {
      const p = m.pricing ? parseFloat(m.pricing.prompt ?? '') : NaN;
      const c = m.pricing ? parseFloat(m.pricing.completion ?? '') : NaN;
      const hasPrice = Number.isFinite(p) || Number.isFinite(c);
      const label = hasPrice
        ? ((p || 0) + (c || 0) === 0 ? `${m.id}  (free)` : `${m.id}  ($${(p * 1e6).toFixed(2)}/$${(c * 1e6).toFixed(2)} per M)`)
        : m.id;
      return { id: m.id, label };
    });
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return res.json({ models: rows });
  } catch (err) {
    res.json({ models: [], error: (err as Error).message });
  }
});

export default router;
