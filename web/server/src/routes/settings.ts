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
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  loadSettings, saveSettings, redactSettings, mergeSettings, applySettingsToEnv,
  checkCodeindexStatus, uninstallCodeindex,
  registerCodeindexMcp, unregisterCodeindexMcp,
  SUMMARY_CLI_PRESET_COMMANDS,
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
  // Summary providers actually implemented in src/core/summary-generator.ts:
  // 'cli' (with preset), 'ollama', 'claude' (Anthropic API), 'gemini-cli'
  // (legacy alias), 'none'. Anything else used to render in the UI but did
  // nothing; dropped to avoid offering dead options.
  summaryProviders:   ['none', 'cli', 'ollama', 'claude'] as const,
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
 * GET /api/settings/codeindex — current status, install instructions, capability preview.
 *
 * The web UI is detect-only. If codeindex is on PATH (or at ~/.local/bin/codeindex),
 * we show its status and let the user re-register or remove. If it's not installed,
 * we surface install instructions instead of pretending we can fetch a binary —
 * the codeindex release pipeline lives in a separate repo whose visibility we
 * cannot guarantee for every user.
 */
router.get('/codeindex', (_req, res) => {
  try {
    const status = checkCodeindexStatus();
    // If detected but not registered, register it on read so the agent picks
    // it up next launch. Idempotent — registerCodeindexMcp no-ops if already in.
    if (status.installed && status.path) {
      try {
        const mcpJsonPath = join(homedir(), '.mcp.json');
        registerCodeindexMcp(mcpJsonPath, status.path);
      } catch { /* registration is best-effort; don't fail status read */ }
    }
    res.json({
      status,
      capabilities: [
        { name: 'find_symbol', desc: 'Locate a function/class/struct definition by name' },
        { name: 'find_callers', desc: 'Approximate callers of a symbol with context' },
        { name: 'get_imports', desc: 'What does this file depend on?' },
        { name: 'get_imported_by', desc: 'Reverse deps — who imports this file?' },
        { name: 'get_change_impact', desc: 'Transitive blast radius if you edit this file' },
        { name: 'plan_change', desc: 'Full edit plan (definitions + callers + literals + blast radius)' },
        { name: 'analyze', desc: 'security · dead_code · unwrap_audit · coupling · cycles · type_drift · …' },
        { name: 'search / find_word / get_outline / get_tree', desc: 'Trigram FTS, exact-word lookup, file structure' },
      ],
      installHint: {
        // CLI path is the same flag the chat-recall CLI exposes.
        cli: 'chat-recall init --with-codeindex',
        // Direct install via the codeindex repo's installer; only succeeds when the user has access.
        curl: 'curl -fsSL https://raw.githubusercontent.com/munhq/codeindex/main/install.sh | sh',
        repo: 'https://github.com/munhq/codeindex',
      },
      pitch: 'chat-recall remembers what you\'ve done. codeindex understands what\'s currently in your code. ' +
             'Together the agent can answer "have I built this before?" and "does it already exist?" before redoing work.',
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** POST /api/settings/codeindex/uninstall — remove the binary + MCP registration. */
router.post('/codeindex/uninstall', (_req, res) => {
  try {
    const r = uninstallCodeindex();
    const mcpJsonPath = join(homedir(), '.mcp.json');
    const u = unregisterCodeindexMcp(mcpJsonPath);
    res.json({ ok: true, removed: r.removed, unregistered: u.removed });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

export default router;
