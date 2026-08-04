/**
 * Persistent user settings for chat-recall.
 *
 * Stored at <data dir>/settings/settings.json with file mode 0600 because
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
import { getDataDir } from './paths.js';

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
  // OpenAI-compatible HTTP providers (openai-compat / ollama-cloud / openai /
  // nvidia). Stored here like the embedding keys and mirrored to env at
  // startup. apiBaseUrl is optional for providers with a known default.
  apiBaseUrl?: string;
  apiModel?: string;
  apiKey?: string;
}

/**
 * Per-source enable/disable map. Each tool's content gets fine-grained
 * toggles so users can opt out of indexing specific surfaces (e.g. paste
 * cache, history) without disabling the whole tool.
 *
 * Default = all true. Disabled sources short-circuit at `discover()` and
 * yield zero items — they don't appear in the index, search, or sync.
 */
export interface SourcesEnabled {
  claude:   { sessions: boolean; plans: boolean; tasks: boolean; pasteCache: boolean;
              history: boolean; skills: boolean; agents: boolean; commands: boolean;
              hooks: boolean; plugins: boolean; agentMemory: boolean };
  gemini:   { sessions: boolean; plans: boolean; brain: boolean; extensions: boolean;
              skills: boolean; agents: boolean; commands: boolean };
  opencode: { sessions: boolean; plans: boolean; todos: boolean; skills: boolean;
              agents: boolean; commands: boolean };
  codex:    { sessions: boolean; plugins: boolean; skills: boolean;
              agents: boolean; commands: boolean };
  agy:      { sessions: boolean; plans: boolean };
  // `shared` covers the tool-neutral ~/.agents/{skills} standard read by all tools.
  shared:   { skills: boolean };
  common:   { mcps: boolean; agentMd: boolean };
}

export interface SourceSettings {
  /** Per-tool home directory overrides (settings-level CHAT_RECALL_*_HOME). */
  claudeHome?: string;
  geminiHome?: string;
  codexHome?: string;
  opencodeDbPath?: string;
  agyHome?: string;
  /** Additional Claude home directories (multi-install: ~/.claude-work, …). */
  extraClaudeHomes?: string[];
  /**
   * Transcript homes the operator has decided ABOUT. Discovery finds homes; these
   * record the answer. A home that is neither approved nor declined is PENDING
   * and is not synced — silence must never mean "we shipped your work account".
   *
   * The primary home for each tool is implicitly approved (it is the thing the
   * user installed chat-recall to sync); only additional homes need a decision.
   */
  approvedHomes?: string[];
  declinedHomes?: string[];
  /** One-shot marker: existing installs had every `~/.claude-*` sibling synced
   *  automatically, so on upgrade those are grandfathered into `approvedHomes`
   *  rather than silently going dark. Set once, never re-run. */
  homesGrandfathered?: boolean;
  enabled: SourcesEnabled;
}

/**
 * Privacy controls applied at index-write time. These run BEFORE the
 * chunk lands in FTS5 / vectors / cache, so they also constrain what's
 * available to sync (the sync layer can never upload what was never
 * indexed).
 */
export interface UserRedactionRule {
  /** Sentinel label inserted in place of the match (`[REDACTED:label]`). */
  label: string;
  /** Regex source string (compiled with the `g` flag). */
  pattern: string;
}

export interface PrivacySettings {
  /** Apply secret redactor to chunk text. Env CHAT_RECALL_REDACT_INDEX still wins. */
  redactIndex: boolean;
  /** Custom redaction rules layered on top of DEFAULT_REDACTION_RULES. */
  redactionRules?: UserRedactionRule[];
  /** Project paths or globs to never index. Matched against MemoryItem.projectPath. */
  projectDenylist: string[];
  /** If non-empty, only projects matching this list are indexed. Overrides denylist semantics. */
  projectAllowlist?: string[];
  /** Replace tool-call result bodies with a placeholder before chunking. */
  redactToolOutputs: boolean;
  /** Hard-skip the paste cache regardless of sources.enabled.claude.pasteCache. */
  redactPasteCache: boolean;
  /** Hash absolute paths in indexed chunk text (sha256[:12]). */
  redactFilePaths: boolean;
}

/**
 * Sync transport gating. The sync uploader (per docs/sync-contract.md)
 * consults this before any payload leaves the device.
 *
 * Defaults: `enabled:false`. Schema lands now so the uploader has nothing
 * to retrofit when it ships.
 */
export interface SyncSettings {
  /** Master switch. False ⇒ nothing leaves the device. */
  enabled: boolean;
  /** Cloud endpoint URL. Empty ⇒ self-hosted only, no network calls. */
  endpoint?: string;
  /**
   * Name of the env var holding the bearer token. The token itself is
   * never persisted in settings.json — only the var name.
   */
  tokenRef?: string;
  upload: {
    findings: boolean;
    sessionMeta: boolean;
    dismissals: boolean;
    customRules: boolean;
    /** Redacted raw transcript captures (Phase 2 archive). Default true.
     *  Turn off to ship derived views only (envelope/chunks/derived). */
    raw?: boolean;
  };
  /**
   * Send project paths in cleartext instead of sha-hashed tokens.
   * Off by default (SaaS privacy); turn on for self-host servers you
   * control so the dashboard's project tree shows real paths. Honored
   * by both manual `chat-recall sync` and the watch daemon.
   */
  pathsCleartext?: boolean;
  /** Tools whose findings/meta never leave the device. */
  excludeTools: Array<'claude' | 'gemini' | 'codex' | 'opencode' | 'agy'>;
  /** Project paths whose findings/meta never leave the device. */
  excludeProjects: string[];
  /**
   * Opt personal folders (Pictures/Music/Documents/… — see PERSONAL_DIR_PATTERNS)
   * back INTO code-index discovery. Those folders are skipped by default so
   * chat-recall never walks personal media/docs (and never trips the macOS
   * Photos/Music permission prompts). A substring match here re-permits a
   * specific path under them (e.g. "/Documents/code/").
   */
  includeProjects?: string[];
  /**
   * Selective sync mode. 'all' (default) ships every non-excluded project;
   * 'only' ships ONLY the projects in `syncOnlyProjects` (opt-in). An empty
   * `syncOnlyProjects` while in 'only' mode ships nothing — the member has
   * explicitly narrowed scope to a set they haven't populated yet.
   */
  syncMode?: 'all' | 'only';
  /**
   * Project ids (e.g. `git:github.com/org/repo`, `ws:name`, `path:/abs`) — or
   * raw path substrings — that sync when `syncMode='only'`. Matched against each
   * session/item's resolved project id and its project path.
   */
  syncOnlyProjects?: string[];
  /** Last-line regex filter on the redacted `preview` field. */
  excludePreviewPatterns?: string[];
  /**
   * Watermark (ms epoch) of the last successful conversation sync. The
   * watch daemon and `chat-recall sync` only push sessions modified after
   * this, then advance it. Absent = full sync on the next run.
   */
  lastSyncAt?: number;
}

/**
 * Opt-in selective-sync gate (pure). Returns whether a project may sync.
 * - 'all' (or unset): everything passes (exclusions are applied separately).
 * - 'only': passes ONLY when the resolved project id is in the allowlist, or the
 *   project path contains one of the allowlist entries (so a user can list a
 *   path substring too). Empty allowlist in 'only' mode → nothing passes.
 */
export function isProjectSyncable(
  projectId: string,
  projectPath: string,
  cfg: { syncMode?: 'all' | 'only'; syncOnly: ReadonlySet<string> },
): boolean {
  if ((cfg.syncMode ?? 'all') !== 'only') return true;
  if (projectId && cfg.syncOnly.has(projectId)) return true;
  for (const x of cfg.syncOnly) if (x && projectPath.includes(x)) return true;
  return false;
}

/**
 * Team toolkit sync — the paid Team tier. Members pull a curated library
 * of skills / CLAUDE.md / agents / commands / MCPs / hooks from a shared
 * server, and publish their own. Off by default. The auth token is held
 * in an env var (named here), never persisted to settings.json.
 *
 * Conversations DO NOT sync via this path. Only toolkit primitives that
 * the user has explicitly published.
 */
export interface TeamSettings {
  /** Master switch. False ⇒ no team server contact ever. */
  enabled: boolean;
  /** Cloud endpoint. Empty ⇒ team features unavailable. */
  serverUrl?: string;
  /** Team UUID returned by `team join`. */
  teamId?: string;
  /** Display name shown to teammates ("alice" / "alice@acme"). */
  memberHandle?: string;
  /** Env var name holding the bearer token. NEVER stored as a value. */
  tokenRef?: string;
  /** ms-epoch of last successful `team pull`; used for incremental pulls. */
  lastPullAt?: number;
  /**
   * Per-type publish opt-ins. Hooks and global CLAUDE.md default off
   * because they're the highest-trust artifacts (hooks execute code).
   */
  autoPull: boolean;
  /**
   * Per-type publish opt-ins. Keys mirror the cross-tool toolkit
   * primitives — `instructions` covers CLAUDE.md/AGENTS.md/GEMINI.md,
   * `plugins` covers Claude/Codex plugins + Gemini extensions.
   */
  publishAllowed: {
    skills: boolean;
    commands: boolean;
    agents: boolean;
    mcps: boolean;
    plans: boolean;
    plugins: boolean;
    instructions: boolean; // project-level only; global ~/*.md never
    hooks: boolean;        // owner-only on the server side too
  };

  /**
   * E2EE chat-blob Vault — backs up local chat JSONLs to object storage,
   * encrypted client-side. Server holds ciphertext + refs only. Off by
   * default. Enabling requires a passphrase set via `chat-recall vault enable`
   * — that ceremony writes the salt + keyId here. Passphrase itself is
   * NEVER persisted; user re-enters it (or holds it in OS keyring later).
   */
  vault: {
    enabled: boolean;
    /** 64-char hex (32 bytes). Public, not secret. Used by Argon2id derive. */
    saltHex?: string;
    /** 24-char hex (12 bytes) — sha256(masterKey)[:12]. Public id for routing. */
    keyId?: string;
    /** Which tools to back up (default: all installed). */
    syncTools: Array<'claude' | 'gemini' | 'codex' | 'opencode' | 'cursor' | 'agy'>;
    /** Project denylist for Vault uploads (extends `privacy.projectDenylist`). */
    excludeProjects: string[];
    /** Last-successful-sync watermark (ms epoch). */
    lastSyncAt?: number;
  };
}

export interface AppSettings {
  embedding: EmbeddingSettings;
  summary: SummarySettings;
  sources: SourceSettings;
  privacy: PrivacySettings;
  sync: SyncSettings;
  team: TeamSettings;
  /** Settings schema version — bump when shape changes incompatibly. */
  v: number;
}

const SCHEMA_VERSION = 3;

/** Default per-source enable map: everything on. */
function defaultSourcesEnabled(): SourcesEnabled {
  return {
    claude:   { sessions: true, plans: true, tasks: true, pasteCache: true, history: true,
                skills: true, agents: true, commands: true, hooks: true, plugins: true,
                agentMemory: true },
    gemini:   { sessions: true, plans: true, brain: true, extensions: true,
                skills: true, agents: true, commands: true },
    opencode: { sessions: true, plans: true, todos: true, skills: true,
                agents: true, commands: true },
    codex:    { sessions: true, plugins: true, skills: true,
                agents: true, commands: true },
    agy:      { sessions: true, plans: true },
    shared:   { skills: true },
    common:   { mcps: true, agentMd: true },
  };
}

function defaultSources(): SourceSettings {
  return { enabled: defaultSourcesEnabled() };
}

function defaultPrivacy(): PrivacySettings {
  return {
    redactIndex: false,
    projectDenylist: [],
    redactToolOutputs: false,
    redactPasteCache: false,
    redactFilePaths: false,
  };
}

function defaultSync(): SyncSettings {
  return {
    enabled: false,
    upload: { findings: true, sessionMeta: true, dismissals: true, customRules: true, raw: true },
    excludeTools: [],
    excludeProjects: [],
    includeProjects: [],
  };
}

/**
 * Personal-folder patterns skipped by code-index discovery UNLESS a path is
 * opted back in via sync.includeProjects. Privacy default: chat-recall should
 * never walk your media/docs, and on macOS walking these trips the Photos /
 * Music / Documents permission prompts. Substring match on the project path.
 */
export const PERSONAL_DIR_PATTERNS = [
  '/Pictures/', '/Music/', '/Movies/', '/Videos/', '/Photos Library',
  '/Documents/', '/Desktop/', '/Downloads/', '/Library/',
];

/** True if a path sits under a personal folder and is NOT explicitly opted in. */
export function isPersonalPath(projectPath: string, includeProjects: string[] = []): boolean {
  if (includeProjects.some((inc) => inc && projectPath.includes(inc))) return false;
  return PERSONAL_DIR_PATTERNS.some((pat) => projectPath.includes(pat));
}

function defaultTeam(): TeamSettings {
  return {
    enabled: false,
    autoPull: true,
    publishAllowed: {
      skills: true, commands: true, agents: true, mcps: true, plans: true, plugins: true,
      instructions: false,  // opt-in: project conventions are sensitive
      hooks: false,         // opt-in: hooks execute code
    },
    vault: {
      enabled: false,
      syncTools: ['claude', 'gemini', 'codex', 'opencode', 'cursor'],
      excludeProjects: [],
    },
  };
}

/** Build a fresh defaults object with a freshly detected summary provider. */
function freshDefaults(): AppSettings {
  return {
    v: SCHEMA_VERSION,
    embedding: { provider: 'none' },
    summary: detectDefaultSummary(),
    sources: defaultSources(),
    privacy: defaultPrivacy(),
    sync: defaultSync(),
    team: defaultTeam(),
  };
}

/**
 * Deep-merge a partial v1 (or partial v2) `sources` block onto defaults.
 * Per-tool maps merge field-by-field so a v1 file lacking `sources` gets
 * "all enabled" and a v2 file with a partial map keeps unspecified fields
 * at their defaults.
 */
function mergeSources(base: SourceSettings, partial?: Partial<SourceSettings>): SourceSettings {
  if (!partial) return base;
  const enabled: SourcesEnabled = {
    claude:   { ...base.enabled.claude,   ...(partial.enabled?.claude   ?? {}) },
    gemini:   { ...base.enabled.gemini,   ...(partial.enabled?.gemini   ?? {}) },
    opencode: { ...base.enabled.opencode, ...(partial.enabled?.opencode ?? {}) },
    codex:    { ...base.enabled.codex,    ...(partial.enabled?.codex    ?? {}) },
    agy:      { ...base.enabled.agy,      ...(partial.enabled?.agy      ?? {}) },
    shared:   { ...base.enabled.shared,   ...(partial.enabled?.shared   ?? {}) },
    common:   { ...base.enabled.common,   ...(partial.enabled?.common   ?? {}) },
  };
  return {
    claudeHome:       partial.claudeHome       ?? base.claudeHome,
    geminiHome:       partial.geminiHome       ?? base.geminiHome,
    codexHome:        partial.codexHome        ?? base.codexHome,
    opencodeDbPath:   partial.opencodeDbPath   ?? base.opencodeDbPath,
    agyHome:          partial.agyHome          ?? base.agyHome,
    extraClaudeHomes: partial.extraClaudeHomes ?? base.extraClaudeHomes,
    approvedHomes:    partial.approvedHomes    ?? base.approvedHomes,
    declinedHomes:    partial.declinedHomes    ?? base.declinedHomes,
    homesGrandfathered: partial.homesGrandfathered ?? base.homesGrandfathered,
    enabled,
  };
}

function mergePrivacy(base: PrivacySettings, partial?: Partial<PrivacySettings>): PrivacySettings {
  if (!partial) return base;
  return { ...base, ...partial };
}

function mergeSync(base: SyncSettings, partial?: Partial<SyncSettings>): SyncSettings {
  if (!partial) return base;
  return {
    ...base,
    ...partial,
    upload: { ...base.upload, ...(partial.upload ?? {}) },
  };
}

function mergeTeam(base: TeamSettings, partial?: Partial<TeamSettings>): TeamSettings {
  if (!partial) return base;
  return {
    ...base,
    ...partial,
    publishAllowed: { ...base.publishAllowed, ...(partial.publishAllowed ?? {}) },
    vault: { ...base.vault, ...(partial.vault ?? {}) },
  };
}

/**
 * Public alias for the settings file location. Callers (e.g. `tool-paths.ts`)
 * stat() this to invalidate caches on change without re-parsing JSON.
 */
export function settingsFilePath(): string {
  return settingsPath();
}

function settingsPath(): string {
  // Settings live at <data dir>/settings/settings.json. The migration in
  // paths.ts moves the legacy `~/.claude/chat-recall/` directory to
  // `~/.chat-recall/settings/` so existing installs keep their config.
  return join(getDataDir(), 'settings', 'settings.json');
}

// ── Cached source-settings reader ──────────────────────────────────
// Source plugins call `isSourceEnabled()` on every `discover()` call,
// often inside tight loops. Reading + parsing settings.json each time
// would dominate cold-discover time; keep the parsed `sources` block in
// memory and invalidate on settings.json mtime change so writes from
// the same or another process pick up automatically.

interface SourceSettingsCacheEntry {
  mtimeMs: number;
  sources: SourceSettings;
}
let _sourceSettingsCache: SourceSettingsCacheEntry | null = null;

/** Mtime-cached source-settings reader. Reused by `tool-paths.ts` and source plugins. */
export function loadSourceSettings(): SourceSettings {
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(settingsPath()).mtimeMs;
  } catch { /* file missing → mtimeMs stays -1, defaults will be returned */ }

  if (_sourceSettingsCache && _sourceSettingsCache.mtimeMs === mtimeMs) {
    return _sourceSettingsCache.sources;
  }
  try {
    const sourcesBlock = loadSettings().sources;
    _sourceSettingsCache = { mtimeMs, sources: sourcesBlock };
    return sourcesBlock;
  } catch {
    // Don't cache failures; retry next call.
    return defaultSources();
  }
}

/** True if the user has not opted out of indexing this (tool, source) pair. */
export function isSourceEnabled(
  tool: keyof SourcesEnabled,
  source: string,
): boolean {
  const block = loadSourceSettings().enabled[tool] as Record<string, boolean> | undefined;
  if (!block) return true; // unknown tool → don't gate (safe default)
  // Default to true when the field is missing (forwards-compat with new sources).
  return block[source] !== false;
}

/** Force re-read on next call. Used by tests + by tool-paths.ts. */
export function _resetSourceSettingsCache(): void {
  _sourceSettingsCache = null;
}

/**
 * Secret fields are NOT stored in settings.json (which may be backed up,
 * shared, or synced). They live in a separate `secrets.env` (0600), keyed by
 * the env-var name the rest of the codebase already reads. On load we hydrate
 * the in-memory settings object from there so callers are unchanged; on save
 * we split secrets out and strip them from settings.json.
 */
const SECRET_FIELDS: Array<{ block: 'summary' | 'embedding'; field: string; env: string }> = [
  { block: 'summary',   field: 'apiKey',             env: 'SUMMARY_API_KEY' },
  { block: 'summary',   field: 'anthropicApiKey',    env: 'ANTHROPIC_API_KEY' },
  { block: 'embedding', field: 'geminiApiKey',       env: 'GEMINI_API_KEY' },
  { block: 'embedding', field: 'openaiApiKey',       env: 'OPENAI_API_KEY' },
  { block: 'embedding', field: 'nvidiaApiKey',       env: 'NVIDIA_API_KEY' },
  { block: 'embedding', field: 'ollamaCloudApiKey',  env: 'OLLAMA_API_KEY' },
  { block: 'embedding', field: 'openaiCompatApiKey', env: 'OPENAI_COMPAT_API_KEY' },
];

function secretsPath(): string {
  return join(getDataDir(), 'secrets.env');
}

/** Parse the 0600 secrets.env into an env-name → value map. */
function loadSecrets(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = secretsPath();
  if (!existsSync(p)) return out;
  try {
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k) out[k] = v;
    }
  } catch { /* unreadable → empty */ }
  return out;
}

function writeSecrets(secrets: Record<string, string>): void {
  const p = secretsPath();
  mkdirSync(dirname(p), { recursive: true });
  const body = '# chat-recall secrets — NOT committed/synced. Mode 0600.\n' +
    Object.entries(secrets)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n';
  writeFileSync(p, body);
  try { chmodSync(p, 0o600); } catch { /* Windows: tolerate */ }
}

/** Load settings from disk. Returns auto-detected defaults if the file doesn't exist or is unreadable. */
export function loadSettings(): AppSettings {
  const path = settingsPath();
  if (!existsSync(path)) return freshDefaults();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AppSettings>;
    // Merge with defaults so older files (v1 — embedding+summary only) and
    // partial v2 files keep working. New blocks (sources/privacy/sync) get
    // their default values when absent.
    const base = freshDefaults();
    const result: AppSettings = {
      v: SCHEMA_VERSION,
      embedding: { ...base.embedding, ...(parsed.embedding ?? {}) },
      summary:   { ...base.summary,   ...(parsed.summary   ?? {}) },
      sources:   mergeSources(base.sources, parsed.sources),
      privacy:   mergePrivacy(base.privacy, parsed.privacy),
      sync:      mergeSync(base.sync,       parsed.sync),
      team:      mergeTeam(base.team,       parsed.team),
    };
    // Hydrate secret fields from process.env > secrets.env > legacy settings.json.
    const secrets = loadSecrets();
    for (const { block, field, env } of SECRET_FIELDS) {
      const blk = result[block] as unknown as Record<string, unknown>;
      const value = process.env[env] || secrets[env] || (blk[field] as string | undefined);
      if (value) blk[field] = value;
    }
    return result;
  } catch {
    // Corrupt file — fall back to defaults rather than crash.
    return freshDefaults();
  }
}

/**
 * Persist settings. Secrets are split out to `secrets.env` (0600) and stripped
 * from settings.json so the config file never holds API keys — it can be
 * backed up, shared, or synced without leaking credentials.
 */
export function saveSettings(settings: AppSettings): void {
  // 1. Merge incoming keys into existing secrets.env (preserve unrelated ones).
  const secrets = loadSecrets();
  const stripped: AppSettings = {
    ...settings,
    v: SCHEMA_VERSION,
    summary:   { ...settings.summary },
    embedding: { ...settings.embedding },
  };
  for (const { block, field, env } of SECRET_FIELDS) {
    const blk = stripped[block] as unknown as Record<string, unknown>;
    const v = blk[field];
    // A masked value ("••••…") means "unchanged" — don't overwrite the stored key.
    if (typeof v === 'string' && v && !v.startsWith('••••')) secrets[env] = v;
    delete blk[field];
  }
  writeSecrets(secrets);

  // 2. Write settings.json WITHOUT any secret fields.
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(stripped, null, 2));
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
  if (s.summary.apiBaseUrl)                process.env.SUMMARY_API_BASE_URL = s.summary.apiBaseUrl;
  if (s.summary.apiModel)                  process.env.SUMMARY_API_MODEL = s.summary.apiModel;
  if (s.summary.apiKey)                    process.env.SUMMARY_API_KEY = s.summary.apiKey;
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
      apiKey:              mask(s.summary.apiKey),
    },
    // sources/privacy/sync hold no secrets — the sync token is referenced
    // by env-var name only, never persisted as a value.
    sources: s.sources,
    privacy: s.privacy,
    sync:    s.sync,
    team:    s.team,
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
    sm.apiKey          = keepIfMasked(current.summary.apiKey,          update.summary.apiKey);
  }

  const sources = mergeSources(current.sources, update.sources);
  const privacy = mergePrivacy(current.privacy, update.privacy);
  const sync    = mergeSync(current.sync,       update.sync);
  const team    = mergeTeam(current.team,       update.team);

  return { v: SCHEMA_VERSION, embedding: e, summary: sm, sources, privacy, sync, team };
}
