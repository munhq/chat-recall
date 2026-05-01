/**
 * Persistent user settings for chat-recall.
 *
 * Stored at ~/.claude/chat-recall/settings.json with file mode 0600 because
 * the file holds API keys. Settings override env vars; env vars override
 * the hard-coded defaults. So the precedence chain (highest first) is:
 *   settings.json  →  process.env  →  defaults
 *
 * The web settings page reads/writes this file via /api/settings. The CLI,
 * MCP server, and indexer all read it on startup so any path stays in sync.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'fs';
import { delimiter } from 'path';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { EmbedderProvider } from './embedder.js';

/**
 * CLI presets we know how to invoke, in priority order. First one whose
 * binary is found on PATH wins as the default summary provider on first
 * launch — gemini → claude → opencode covers the most common installs.
 *
 * `cmd` mirrors `CLI_PRESETS` in src/core/summary-generator.ts. Duplicated
 * here to avoid an import cycle (summary-generator imports nothing from
 * settings, settings would otherwise pull in the whole summary module).
 */
const CLI_DETECTION_ORDER: Array<{ preset: string; bin: string; cmd: string }> = [
  { preset: 'gemini',     bin: 'gemini',   cmd: 'gemini -p " "' },
  { preset: 'claude-cli', bin: 'claude',   cmd: 'claude -p " "' },
  { preset: 'opencode',   bin: 'opencode', cmd: 'opencode run "$(cat {prompt_file})"' },
  { preset: 'kilocode',   bin: 'kilocode', cmd: 'kilocode run "$(cat {prompt_file})"' },
  { preset: 'llm',        bin: 'llm',      cmd: 'llm --no-stream' },
  { preset: 'aichat',     bin: 'aichat',   cmd: 'aichat --no-stream' },
];

/** Synchronous `which` — checks each PATH entry for an executable file. */
function whichSync(bin: string): boolean {
  const path = process.env.PATH;
  if (!path) return false;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, bin);
    try {
      const s = statSync(full);
      if (s.isFile()) return true;
    } catch { /* not here, try next */ }
  }
  return false;
}

/**
 * Pick a default summary provider by sniffing PATH for known CLI binaries.
 * If nothing is found we fall back to 'none' (first-prompt fallback).
 */
function detectDefaultSummary(): SummarySettings {
  for (const { preset, bin, cmd } of CLI_DETECTION_ORDER) {
    if (whichSync(bin)) {
      // Pre-populate cliCommand so the UI's textbox isn't empty on first load
      // and the summary generator has something concrete to run.
      return { provider: 'cli', cliPreset: preset, cliCommand: cmd, cliTimeoutMs: 120_000 };
    }
  }
  return { provider: 'none', cliTimeoutMs: 120_000 };
}

export type SummaryProvider =
  | 'none'
  | 'cli'
  | 'ollama'
  | 'ollama-cloud'
  | 'gemini'
  | 'gemini-cli'   // legacy alias for the dedicated gemini-CLI invocation
  | 'openai'
  | 'nvidia'
  | 'openai-compat'
  | 'claude';

export interface EmbeddingSettings {
  provider: EmbedderProvider;
  // Provider-specific knobs. Only the field for the current provider is used.
  ollamaHost?: string;
  ollamaModel?: string;
  ollamaCloudApiKey?: string;
  ollamaCloudModel?: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  nvidiaApiKey?: string;
  nvidiaModel?: string;
  openaiCompatBaseUrl?: string;
  openaiCompatModel?: string;
  openaiCompatApiKey?: string;
  openaiCompatDimension?: number;
}

export interface SummarySettings {
  provider: SummaryProvider;
  // CLI-style providers
  cliCommand?: string;
  cliPreset?: string;     // e.g. "gemini", "claude-cli", "llm"
  cliTimeoutMs?: number;
  // Per-provider model overrides
  geminiModel?: string;
  claudeModel?: string;
  ollamaModel?: string;
  // claude HTTP API
  anthropicApiKey?: string;
}

export interface AppSettings {
  embedding: EmbeddingSettings;
  summary: SummarySettings;
  /** Settings schema version — bump when shape changes incompatibly. */
  v: number;
}

const SCHEMA_VERSION = 1;

// Embedding defaults to "none" (FTS5 keyword search works out of the box).
// Summary defaults are computed at load time — if any known CLI is on PATH
// (gemini, claude, opencode, …) we pre-select it so summaries actually run
// without the user having to configure anything.
const DEFAULTS: AppSettings = {
  v: SCHEMA_VERSION,
  embedding: { provider: 'none' },
  summary: { provider: 'none', cliTimeoutMs: 120_000 },
};

/** Build a fresh defaults object with a freshly detected summary provider. */
function freshDefaults(): AppSettings {
  return {
    v: SCHEMA_VERSION,
    embedding: { provider: 'none' },
    summary: detectDefaultSummary(),
  };
}

function settingsPath(): string {
  return join(homedir(), '.claude', 'chat-recall', 'settings.json');
}

/** Load settings from disk. Returns auto-detected defaults if the file doesn't exist or is unreadable. */
export function loadSettings(): AppSettings {
  const path = settingsPath();
  if (!existsSync(path)) return freshDefaults();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AppSettings>;
    // Merge with defaults so older files that lack new fields still work.
    const base = freshDefaults();
    return {
      v: SCHEMA_VERSION,
      embedding: { ...base.embedding, ...(parsed.embedding ?? {}) },
      summary:   { ...base.summary,   ...(parsed.summary   ?? {}) },
    };
  } catch {
    // Corrupt file — fall back to defaults rather than crash.
    return freshDefaults();
  }
}

/** Persist settings to disk with mode 0600 (owner-only) since they hold keys. */
export function saveSettings(settings: AppSettings): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const payload = JSON.stringify({ ...settings, v: SCHEMA_VERSION }, null, 2);
  writeFileSync(path, payload);
  try { chmodSync(path, 0o600); } catch { /* mode-set may fail on Windows; tolerate */ }
}

/**
 * Apply settings as env vars for the current process. Any field that is
 * non-empty wins over an existing env var so the rest of the codebase
 * (embedder.ts, summary-generator.ts) keeps reading from process.env without
 * needing to know about the settings file.
 */
export function applySettingsToEnv(s: AppSettings = loadSettings()): void {
  // Embedder
  if (s.embedding.provider && s.embedding.provider !== 'none') {
    process.env.EMBEDDING_PROVIDER = s.embedding.provider;
  }
  if (s.embedding.ollamaHost)              process.env.OLLAMA_HOST = s.embedding.ollamaHost;
  if (s.embedding.ollamaCloudApiKey)       process.env.OLLAMA_API_KEY = s.embedding.ollamaCloudApiKey;
  if (s.embedding.geminiApiKey)            process.env.GEMINI_API_KEY = s.embedding.geminiApiKey;
  if (s.embedding.openaiApiKey)            process.env.OPENAI_API_KEY = s.embedding.openaiApiKey;
  if (s.embedding.nvidiaApiKey)            process.env.NVIDIA_API_KEY = s.embedding.nvidiaApiKey;
  if (s.embedding.openaiCompatBaseUrl)     process.env.OPENAI_COMPAT_BASE_URL = s.embedding.openaiCompatBaseUrl;
  if (s.embedding.openaiCompatModel)       process.env.OPENAI_COMPAT_MODEL = s.embedding.openaiCompatModel;
  if (s.embedding.openaiCompatApiKey)      process.env.OPENAI_COMPAT_API_KEY = s.embedding.openaiCompatApiKey;
  if (s.embedding.openaiCompatDimension)   process.env.OPENAI_COMPAT_DIMENSION = String(s.embedding.openaiCompatDimension);

  // Summary
  if (s.summary.provider)                  process.env.SUMMARY_PROVIDER = s.summary.provider;
  if (s.summary.cliCommand)                process.env.SUMMARY_CLI_CMD = s.summary.cliCommand;
  if (s.summary.cliPreset)                 process.env.SUMMARY_CLI_PRESET = s.summary.cliPreset;
  if (s.summary.cliTimeoutMs)              process.env.SUMMARY_CLI_TIMEOUT_MS = String(s.summary.cliTimeoutMs);
  if (s.summary.anthropicApiKey)           process.env.ANTHROPIC_API_KEY = s.summary.anthropicApiKey;
}

/**
 * Redact secrets before sending settings to the UI. The frontend never needs
 * to see the actual API keys — it just needs to know whether one is set.
 */
export function redactSettings(s: AppSettings): AppSettings {
  const mask = (v?: string) => (v ? '••••' + v.slice(-4) : undefined);
  return {
    v: s.v,
    embedding: {
      ...s.embedding,
      geminiApiKey:        mask(s.embedding.geminiApiKey),
      openaiApiKey:        mask(s.embedding.openaiApiKey),
      nvidiaApiKey:        mask(s.embedding.nvidiaApiKey),
      ollamaCloudApiKey:   mask(s.embedding.ollamaCloudApiKey),
      openaiCompatApiKey:  mask(s.embedding.openaiCompatApiKey),
    },
    summary: {
      ...s.summary,
      anthropicApiKey:     mask(s.summary.anthropicApiKey),
    },
  };
}

/**
 * Merge an incoming partial update into the saved settings. Empty strings on
 * masked secret fields ("••••xxxx") are treated as "leave as-is" so the UI
 * doesn't have to round-trip the actual key on every save.
 */
export function mergeSettings(current: AppSettings, update: Partial<AppSettings>): AppSettings {
  const isMask = (v: any) => typeof v === 'string' && v.startsWith('••••');
  const keepIfMasked = <T>(currentVal: T | undefined, newVal: T | undefined): T | undefined => {
    if (isMask(newVal)) return currentVal;
    return newVal === undefined ? currentVal : newVal;
  };

  const e = { ...current.embedding, ...(update.embedding ?? {}) };
  if (update.embedding) {
    e.geminiApiKey       = keepIfMasked(current.embedding.geminiApiKey,       update.embedding.geminiApiKey);
    e.openaiApiKey       = keepIfMasked(current.embedding.openaiApiKey,       update.embedding.openaiApiKey);
    e.nvidiaApiKey       = keepIfMasked(current.embedding.nvidiaApiKey,       update.embedding.nvidiaApiKey);
    e.ollamaCloudApiKey  = keepIfMasked(current.embedding.ollamaCloudApiKey,  update.embedding.ollamaCloudApiKey);
    e.openaiCompatApiKey = keepIfMasked(current.embedding.openaiCompatApiKey, update.embedding.openaiCompatApiKey);
  }

  const sm = { ...current.summary, ...(update.summary ?? {}) };
  if (update.summary) {
    sm.anthropicApiKey = keepIfMasked(current.summary.anthropicApiKey, update.summary.anthropicApiKey);
  }

  return { v: SCHEMA_VERSION, embedding: e, summary: sm };
}
