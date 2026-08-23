/**
 * Settings dialog. Two cards — Embeddings and Summaries — each with a radio
 * to pick a provider and provider-specific fields. The "Test" button validates
 * the current config without saving (POST /api/settings/test). API keys are
 * masked on the wire (••••xxxx); leaving the masked value untouched preserves
 * the stored key on save.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Icon, Button } from './primitives';
import ProjectsSettingsCard from './ProjectsSettingsCard';
import {
  getSettings,
  saveSettings,
  testSettings,
  fetchProviderModels,
  type ProviderModel,
  type AppSettings,
  type SettingsResponse,
  type TestResult,
  type EmbeddingSettings,
  type SummarySettings,
  type EmbedderProvider,
  type SummaryProvider,
  type SourceSettings,
  type SourcesEnabled,
  type PrivacySettings,
  type SyncSettings,
} from '../services/api';

// Defaults used when the API responds without the v2 blocks (older server,
// or transient deploy mismatch). Mirrors the server-side defaults in
// `src/core/settings.ts`.
function defaultSourceSettings(): SourceSettings {
  return {
    enabled: {
      claude:   { sessions: true, plans: true, tasks: true, pasteCache: true, history: true,
                  skills: true, agents: true, commands: true, hooks: true, plugins: true },
      gemini:   { sessions: true, plans: true, brain: true, extensions: true },
      agy:      { sessions: true, plans: true },
      opencode: { sessions: true, plans: true, todos: true, skills: true },
      codex:    { sessions: true, plugins: true, skills: true },
      cursor:   { sessions: true, skills: true, agents: true, commands: true },
      common:   { mcps: true, agentMd: true },
    },
  };
}
function defaultPrivacySettings(): PrivacySettings {
  return {
    redactIndex: false, projectDenylist: [],
    redactToolOutputs: false, redactPasteCache: false, redactFilePaths: false,
  };
}
function defaultSyncSettings(): SyncSettings {
  return {
    enabled: false,
    upload: { raw: true, findings: true, sessionMeta: true, dismissals: true, customRules: true },
    excludeTools: [], excludeProjects: [],
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 'modal' (default) — overlay dialog. 'page' — render inline as a full page. */
  variant?: 'modal' | 'page';
}

// Provider/credential config (embedder + summary provider + API keys) is NOT
// exposed in the UI. It's a SaaS-operator concern, injected via env/secret
// (vault now; external-secrets / AWS Secrets Manager later). Self-host/local
// devs still configure it via env, settings.json, or the CLI — just not here.
// Removing it from the UI keeps the surface small and is a deliberate funnel:
// self-hosting requires real ops, which is what the hosted SaaS sells.
const PROVIDER_SETTINGS_IN_UI = false;

export default function SettingsDialog({ open, onClose, variant = 'modal' }: Props) {
  const [resp, setResp] = useState<SettingsResponse | null>(null);
  const [emb, setEmb] = useState<EmbeddingSettings | null>(null);
  const [sm, setSm] = useState<SummarySettings | null>(null);
  const [src, setSrc] = useState<SourceSettings | null>(null);
  const [priv, setPriv] = useState<PrivacySettings | null>(null);
  const [snc, setSnc] = useState<SyncSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [embTest, setEmbTest] = useState<TestResult | null>(null);
  const [smTest, setSmTest] = useState<TestResult | null>(null);
  const [embTesting, setEmbTesting] = useState(false);
  const [smTesting, setSmTesting] = useState(false);
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setMessage('');
    setError('');
    setEmbTest(null);
    setSmTest(null);
    getSettings()
      .then((d) => {
        setResp(d);
        setEmb(d.settings.embedding);
        setSm(d.settings.summary);
        // Defensive defaults: an older API server (pre-v2) responds without
        // these blocks. Fill them in client-side so the dialog still renders
        // — saving will then upgrade the server-side file on next request.
        setSrc(d.settings.sources ?? defaultSourceSettings());
        setPriv(d.settings.privacy ?? defaultPrivacySettings());
        setSnc(d.settings.sync    ?? defaultSyncSettings());
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = async () => {
    if (!emb || !sm || !src || !priv || !snc) return;
    setSaving(true); setMessage(''); setError('');
    try {
      const r = await saveSettings({
        embedding: emb, summary: sm,
        sources: src, privacy: priv, sync: snc,
      } as Partial<AppSettings>);
      setMessage('Saved. ' + r.restartHint);
      // Re-pull masks from server so the input fields show ••••xxxx after save.
      const d = await getSettings();
      setResp(d);
      setEmb(d.settings.embedding);
      setSm(d.settings.summary);
      setSrc(d.settings.sources ?? defaultSourceSettings());
      setPriv(d.settings.privacy ?? defaultPrivacySettings());
      setSnc(d.settings.sync    ?? defaultSyncSettings());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runEmbTest = async () => {
    if (!emb) return;
    setEmbTesting(true);
    setEmbTest(null);
    try { setEmbTest(await testSettings('embedding', emb)); }
    catch (e) { setEmbTest({ ok: false, error: (e as Error).message }); }
    finally { setEmbTesting(false); }
  };
  const runSmTest = async () => {
    if (!sm) return;
    setSmTesting(true);
    setSmTest(null);
    try { setSmTest(await testSettings('summary', sm)); }
    catch (e) { setSmTest({ ok: false, error: (e as Error).message }); }
    finally { setSmTesting(false); }
  };

  // Two render modes: a centered modal (legacy) and a full-page layout used
  // when navigated to via the gear icon. The card body is identical; only the
  // wrapping container differs.
  const isPage = variant === 'page';
  // One gutter value for the page variant. The sticky header below cancels this
  // padding with an equal NEGATIVE margin so its rule runs edge to edge, so the
  // two must never be written independently — a fixed -32px against a fluid
  // padding pulls the header off the side of the screen on a phone.
  const pageGutter = 'clamp(14px, 4vw, 32px)';
  const outer: React.CSSProperties = isPage
    ? { flex: 1, overflowY: 'auto', background: 'var(--cr-ink-0)' }
    : {
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      };
  const inner: React.CSSProperties = isPage
    ? {
        maxWidth: 880, margin: '32px auto', padding: `0 ${pageGutter} 64px`,
        color: 'var(--cr-fg-1)',
      }
    : {
        width: 'min(880px, 100%)', maxHeight: '92dvh', overflowY: 'auto',
        background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-1)',
        borderRadius: 'var(--cr-radius-lg)', padding: 24, color: 'var(--cr-fg-1)',
      };

  return (
    <div onClick={isPage ? undefined : onClose} style={outer}>
      <div
        onClick={(e) => { if (!isPage) e.stopPropagation(); }}
        data-testid="settings-dialog"
        style={inner}
      >
        <header style={{
          position: 'sticky', top: 0, zIndex: 5,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: isPage ? 'var(--cr-ink-0)' : 'var(--cr-ink-1)',
          margin: isPage ? `0 calc(-1 * ${pageGutter}) 16px` : '-24px -24px 16px',
          padding: isPage ? `12px ${pageGutter}` : '16px 24px',
          borderBottom: '1px solid var(--cr-line-1)',
        }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Settings</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Button data-testid="settings-save-top" onClick={handleSave} disabled={saving || loading}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--cr-fg-3)' }}
            >
              <Icon name="x" size={18} />
            </button>
          </div>
        </header>

        {loading && <div style={{ color: 'var(--cr-fg-3)', padding: 24 }}>Loading…</div>}
        {error && <Banner kind="error">{error}</Banner>}
        {message && <Banner kind="ok">{message}</Banner>}

        {resp && emb && sm && src && priv && snc && (
          <>
            {/* Provider/credentials (summary + embedding) are operator-config,
                injected via env/secret — not user-editable here. See
                PROVIDER_SETTINGS_IN_UI. */}
            {PROVIDER_SETTINGS_IN_UI && (
              <>
                <SummaryCard
                  value={sm}
                  onChange={setSm}
                  presets={resp.presets}
                  status={resp.status}
                  testResult={smTest}
                  testing={smTesting}
                  onTest={runSmTest}
                />
                <EmbeddingCard
                  value={emb}
                  onChange={setEmb}
                  presets={resp.presets}
                  status={resp.status}
                  testResult={embTest}
                  testing={embTesting}
                  onTest={runEmbTest}
                />
              </>
            )}
            <SourcesCard value={src} onChange={setSrc} />
            <ProjectsSettingsCard />
            <PrivacyCard value={priv} onChange={setPriv} syncEnabled={snc.enabled} />
            <SyncCard value={snc} onChange={setSnc} privacy={priv} />

            <footer style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 24 }}>
              <Button
                variant="ghost"
                size="sm"
                icon="refresh"
                onClick={async () => {
                  try {
                    const d = await getSettings();
                    setResp(d);
                    setMessage('Detection refreshed.');
                    setTimeout(() => setMessage(''), 2000);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
                title="Re-scan PATH for installed CLIs"
              >
                Re-scan CLIs
              </Button>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button data-testid="settings-save" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────

type EmbeddingChoice = {
  key: EmbedderProvider;
  group: 'recommended' | 'local' | 'cloud' | 'advanced';
  label: string;
  hint?: string;
};

const EMBEDDING_CHOICES: EmbeddingChoice[] = [
  { key: 'none',          group: 'recommended', label: 'Keyword search only (full-text)',  hint: 'No setup. Works out of the box.' },
  { key: 'ollama',        group: 'local',       label: 'Ollama (local, free)',             hint: 'ollama pull nomic-embed-text' },
  { key: 'nvidia',        group: 'cloud',       label: 'NVIDIA NIM (free credits)',        hint: 'NVIDIA_API_KEY' },
  { key: 'gemini',        group: 'cloud',       label: 'Google Gemini',                    hint: 'GEMINI_API_KEY · ~100 req/day free' },
  { key: 'openai',        group: 'cloud',       label: 'OpenAI',                           hint: 'OPENAI_API_KEY · paid' },
  { key: 'openai-compat', group: 'advanced',    label: 'Custom OpenAI-compatible endpoint', hint: 'LocalAI, vLLM, llama.cpp, …' },
];

function EmbeddingCard({
  value, onChange, presets, status, testResult, testing, onTest,
}: {
  value: EmbeddingSettings;
  onChange: (s: EmbeddingSettings) => void;
  presets: SettingsResponse['presets'];
  status: SettingsResponse['status'];
  testResult: TestResult | null;
  testing: boolean;
  onTest: () => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const recommended = EMBEDDING_CHOICES.filter((c) => c.group === 'recommended');
  const local       = EMBEDDING_CHOICES.filter((c) => c.group === 'local');
  const cloud       = EMBEDDING_CHOICES.filter((c) => c.group === 'cloud');
  const advanced    = EMBEDDING_CHOICES.filter((c) => c.group === 'advanced');

  const renderGroup = (title: string | null, choices: EmbeddingChoice[], accent?: 'ok') => (
    <ChoiceGroup
      title={title || undefined}
      accent={accent}
      kind="embedding"
      choices={choices.map((c) => ({
        key: c.key,
        group: 'cloud' as const, // unused for embeddings — ChoiceGroup ignores it
        label: c.label,
        hint: c.hint,
        match: (s) => (s as unknown as EmbeddingSettings).provider === c.key,
        apply: (s) => ({ ...(s as unknown as EmbeddingSettings), provider: c.key }) as unknown as SummarySettings,
      }))}
      value={value as unknown as SummarySettings}
      onChange={(s) => onChange(s as unknown as EmbeddingSettings)}
    />
  );

  return (
    <Card title="Search & embeddings"
      hint="Powers semantic search. Keyword (full-text) search is the default and works without any provider.">
      {renderGroup('No setup', recommended, 'ok')}
      {renderGroup('Local', local)}
      {renderGroup('Hosted APIs', cloud)}
      {advanced.length > 0 && (
        <Disclosure open={showAdvanced} onToggle={setShowAdvanced} label="Advanced (custom endpoint)">
          {renderGroup(null, advanced)}
        </Disclosure>
      )}

      {value.provider === 'ollama' && (
        <Fields>
          <TextField label="Ollama host" value={value.ollamaHost ?? ''} placeholder="http://localhost:11434"
            onChange={(v) => onChange({ ...value, ollamaHost: v })} />
          <TextField label="Embedding model" value={value.ollamaModel ?? ''} placeholder="nomic-embed-text"
            onChange={(v) => onChange({ ...value, ollamaModel: v })} />
          {status.ollama && (
            <StatusBadge ok={status.ollama.reachable}
              message={status.ollama.reachable
                ? `Reachable. ${status.ollama.models?.length ?? 0} model${status.ollama.models?.length === 1 ? '' : 's'} available.`
                : status.ollama.error || 'Not reachable'} />
          )}
        </Fields>
      )}

      {value.provider === 'gemini' && (
        <Fields>
          <KeyField label="GEMINI_API_KEY" value={value.geminiApiKey ?? ''}
            onChange={(v) => onChange({ ...value, geminiApiKey: v })} />
        </Fields>
      )}

      {value.provider === 'openai' && (
        <Fields>
          <KeyField label="OPENAI_API_KEY" value={value.openaiApiKey ?? ''}
            onChange={(v) => onChange({ ...value, openaiApiKey: v })} />
          <ModelField label="Model" value={value.openaiModel ?? ''} placeholder="text-embedding-3-small"
            kind="embedding" provider="openai" apiKey={value.openaiApiKey}
            onChange={(v) => onChange({ ...value, openaiModel: v })} />
        </Fields>
      )}

      {value.provider === 'nvidia' && (
        <Fields>
          <KeyField label="NVIDIA_API_KEY" value={value.nvidiaApiKey ?? ''}
            help="Free at build.nvidia.com — Nvidia hosts several embedding models including nv-embed-v1"
            onChange={(v) => onChange({ ...value, nvidiaApiKey: v })} />
          <ModelField label="Model" value={value.nvidiaModel ?? ''} placeholder="nvidia/nv-embed-v1"
            kind="embedding" provider="nvidia" apiKey={value.nvidiaApiKey}
            onChange={(v) => onChange({ ...value, nvidiaModel: v })} />
        </Fields>
      )}

      {value.provider === 'openai-compat' && (
        <Fields>
          <TextField label="Base URL" value={value.openaiCompatBaseUrl ?? ''}
            placeholder="http://localhost:8080/v1" required
            onChange={(v) => onChange({ ...value, openaiCompatBaseUrl: v })} />
          <ModelField label="Model" value={value.openaiCompatModel ?? ''}
            placeholder="custom-model-name"
            kind="embedding" provider="openai-compat" baseUrl={value.openaiCompatBaseUrl} apiKey={value.openaiCompatApiKey}
            onChange={(v) => onChange({ ...value, openaiCompatModel: v })} />
          <NumField label="Dimension" value={value.openaiCompatDimension}
            placeholder="768" required
            onChange={(v) => onChange({ ...value, openaiCompatDimension: v })} />
          <KeyField label="API key (optional for local servers)" value={value.openaiCompatApiKey ?? ''}
            onChange={(v) => onChange({ ...value, openaiCompatApiKey: v })} />
        </Fields>
      )}

      <CardActions>
        <Button variant="outline" onClick={onTest} disabled={testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        {testResult && <TestResultLine result={testResult} />}
      </CardActions>
    </Card>
  );
}

/**
 * One row in the summary picker. Each row is a unique selectable choice that
 * maps onto a (provider, cliPreset) pair. Local-CLI presets are exploded into
 * individual rows so users pick "Gemini CLI" directly instead of selecting
 * "Local CLI" → preset dropdown → preset.
 */
type SummaryChoice = {
  key: string;
  /** Group bucket — drives section heading and visual treatment */
  group: 'detected' | 'install' | 'cloud' | 'other';
  label: string;
  hint?: string;
  detected?: boolean;            // true → ✓ green, false → "install required"
  match: (s: SummarySettings) => boolean;
  apply: (s: SummarySettings) => SummarySettings;
};

function buildSummaryChoices(
  presets: SettingsResponse['presets'],
  status: SettingsResponse['status'],
): SummaryChoice[] {
  const detected = status.cliDetected || {};
  const cmds = presets.summaryCliPresetCommands || {};
  const cliRows: SummaryChoice[] = presets.summaryCliPresets.map((p) => ({
    key: `cli:${p}`,
    group: detected[p] ? 'detected' : 'install',
    label: prettyCliName(p),
    hint: cmds[p] || '',
    detected: !!detected[p],
    match: (s) => s.provider === 'cli' && s.cliPreset === p,
    apply: (s) => ({ ...s, provider: 'cli', cliPreset: p, cliCommand: cmds[p] }),
  }));

  // Hosted HTTP APIs. The OpenAI-compatible providers (openrouter / ollama-cloud
  // / openai / nvidia / custom) all share one `/chat/completions` backend in
  // summary-generator.ts — they differ only by default base URL + key.
  const cloudRows: SummaryChoice[] = [
    {
      key: 'claude-api',
      group: 'cloud',
      label: 'Anthropic Claude API',
      hint: 'ANTHROPIC_API_KEY',
      match: (s) => s.provider === 'claude',
      apply: (s) => ({ ...s, provider: 'claude' }),
    },
    {
      key: 'openrouter',
      group: 'cloud',
      label: 'OpenRouter',
      hint: 'openrouter.ai — many cheap/free models',
      match: (s) => s.provider === 'openai-compat' && (s.apiBaseUrl || '').includes('openrouter'),
      apply: (s) => ({ ...s, provider: 'openai-compat', apiBaseUrl: 'https://openrouter.ai/api/v1' }),
    },
    {
      key: 'ollama-cloud',
      group: 'cloud',
      label: 'Ollama Cloud',
      hint: 'ollama.com — hosted, no local compute',
      match: (s) => s.provider === 'ollama-cloud',
      apply: (s) => ({ ...s, provider: 'ollama-cloud', apiBaseUrl: 'https://ollama.com/v1' }),
    },
    {
      key: 'openai-api',
      group: 'cloud',
      label: 'OpenAI API',
      hint: 'api.openai.com',
      match: (s) => s.provider === 'openai',
      apply: (s) => ({ ...s, provider: 'openai', apiBaseUrl: 'https://api.openai.com/v1' }),
    },
    {
      key: 'nvidia-api',
      group: 'cloud',
      label: 'NVIDIA NIM',
      hint: 'integrate.api.nvidia.com — free credits at build.nvidia.com',
      match: (s) => s.provider === 'nvidia',
      apply: (s) => ({ ...s, provider: 'nvidia', apiBaseUrl: 'https://integrate.api.nvidia.com/v1' }),
    },
    {
      key: 'openai-compat-custom',
      group: 'cloud',
      label: 'Custom OpenAI-compatible',
      hint: 'Groq, Together, vLLM, llama.cpp, a gateway…',
      match: (s) => s.provider === 'openai-compat' && !(s.apiBaseUrl || '').includes('openrouter'),
      apply: (s) => ({ ...s, provider: 'openai-compat' }),
    },
  ];

  const otherRows: SummaryChoice[] = [
    {
      key: 'ollama',
      group: 'other',
      label: 'Ollama (local server)',
      hint: 'Needs `ollama serve` + a chat model',
      match: (s) => s.provider === 'ollama',
      apply: (s) => ({ ...s, provider: 'ollama' }),
    },
    {
      key: 'none',
      group: 'other',
      label: 'Off — use first prompt as fallback',
      hint: 'No external calls',
      match: (s) => s.provider === 'none',
      apply: (s) => ({ ...s, provider: 'none' }),
    },
  ];

  return [...cliRows, ...cloudRows, ...otherRows];
}

function prettyCliName(preset: string): string {
  switch (preset) {
    case 'gemini': return 'Google Gemini CLI';
    case 'claude-cli': return 'Claude CLI';
    case 'opencode': return 'OpenCode';
    case 'kilocode': return 'Kilo Code';
    case 'llm': return 'llm (Simon Willison)';
    case 'aichat': return 'aichat';
    default: return preset;
  }
}

function SummaryCard({
  value, onChange, presets, status, testResult, testing, onTest,
}: {
  value: SummarySettings;
  onChange: (s: SummarySettings) => void;
  presets: SettingsResponse['presets'];
  status: SettingsResponse['status'];
  testResult: TestResult | null;
  testing: boolean;
  onTest: () => void;
}) {
  const choices = useMemo(() => buildSummaryChoices(presets, status), [presets, status]);
  const detected = choices.filter((c) => c.group === 'detected');
  const install  = choices.filter((c) => c.group === 'install');
  const cloud    = choices.filter((c) => c.group === 'cloud');
  const other    = choices.filter((c) => c.group === 'other');
  const [showInstall, setShowInstall] = useState(false);
  const [showOther, setShowOther] = useState(false);

  return (
    <Card title="Session summaries"
      hint="Generate short summaries of indexed sessions. Auto-detects an installed CLI on first launch.">
      <ChoiceGroup
        title={detected.length ? 'Detected on this machine' : 'Local CLIs (none detected)'}
        accent="ok"
        choices={detected}
        value={value} onChange={onChange}
        kind="summary"
      />

      {install.length > 0 && (
        <Disclosure
          open={showInstall} onToggle={setShowInstall}
          label={`Other local CLIs (${install.length} — install required)`}
        >
          <ChoiceGroup
            choices={install}
            value={value} onChange={onChange}
            kind="summary"
            muted
          />
        </Disclosure>
      )}

      <ChoiceGroup
        title="Hosted APIs"
        choices={cloud}
        value={value} onChange={onChange}
        kind="summary"
      />

      <Disclosure
        open={showOther} onToggle={setShowOther}
        label="Advanced (local Ollama server, off)"
      >
        <ChoiceGroup
          choices={other}
          value={value} onChange={onChange}
          kind="summary"
        />
      </Disclosure>

      {/* Provider-specific extra fields */}
      {value.provider === 'cli' && (
        <Fields>
          <TextField label="Custom command" value={value.cliCommand ?? ''}
            placeholder="claude -p &quot; &quot;"
            help="Resolved from the picked CLI. {prompt_file} is replaced with the prompt path; otherwise the prompt is piped via stdin."
            onChange={(v) => onChange({ ...value, cliCommand: v || undefined })} />
          <NumField label="Timeout (ms)" value={value.cliTimeoutMs} placeholder="120000"
            onChange={(v) => onChange({ ...value, cliTimeoutMs: v })} />
        </Fields>
      )}

      {value.provider === 'ollama' && (
        <Fields>
          <TextField label="Chat model" value={value.ollamaModel ?? ''} placeholder="qwen2.5:7b"
            onChange={(v) => onChange({ ...value, ollamaModel: v })} />
        </Fields>
      )}

      {value.provider === 'claude' && (
        <Fields>
          <KeyField label="ANTHROPIC_API_KEY" value={value.anthropicApiKey ?? ''}
            onChange={(v) => onChange({ ...value, anthropicApiKey: v })} />
          <TextField label="Model" value={value.claudeModel ?? ''} placeholder="claude-3-5-haiku"
            onChange={(v) => onChange({ ...value, claudeModel: v })} />
        </Fields>
      )}

      {(value.provider === 'openai-compat' || value.provider === 'ollama-cloud' ||
        value.provider === 'openai' || value.provider === 'nvidia') && (
        <Fields>
          <TextField label="Base URL" value={value.apiBaseUrl ?? ''}
            placeholder="https://openrouter.ai/api/v1"
            help="OpenAI-compatible endpoint. POSTs to {base}/chat/completions."
            onChange={(v) => onChange({ ...value, apiBaseUrl: v || undefined })} />
          <KeyField label="API key" value={value.apiKey ?? ''}
            onChange={(v) => onChange({ ...value, apiKey: v || undefined })} />
          <ModelField label="Model" value={value.apiModel ?? ''}
            placeholder="e.g. anthropic/claude-3.5-haiku, deepseek/deepseek-v4-flash:free"
            kind="summary" provider={value.provider} baseUrl={value.apiBaseUrl} apiKey={value.apiKey}
            onChange={(v) => onChange({ ...value, apiModel: v || undefined })} />
        </Fields>
      )}

      <CardActions>
        <Button variant="outline" onClick={onTest} disabled={testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        {testResult && <TestResultLine result={testResult} />}
      </CardActions>
    </Card>
  );
}

// ── Sources / Privacy / Sync cards ──────────────────────────────────────

/**
 * Per-tool, per-source enable matrix + home-dir overrides. Disabled
 * sources never enter the index, so toggling these is the cheapest way
 * to scope what chat-recall sees.
 */
function SourcesCard({ value, onChange }: { value: SourceSettings; onChange: (v: SourceSettings) => void }) {
  const [pathsOpen, setPathsOpen] = useState(false);
  const setEnabled = <K extends keyof SourcesEnabled, F extends keyof SourcesEnabled[K]>(
    group: K, field: F, on: boolean,
  ) => {
    const next = { ...value.enabled, [group]: { ...value.enabled[group], [field]: on } };
    onChange({ ...value, enabled: next });
  };
  const groupRow = <K extends keyof SourcesEnabled>(label: string, group: K, fields: Array<keyof SourcesEnabled[K]>) => (
    <div key={String(group)} style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase',
        marginBottom: 6, color: 'var(--cr-fg-3)' }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {fields.map((f) => {
          const on = (value.enabled[group] as Record<string, boolean>)[f as string];
          return (
            <label key={String(f)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px',
              borderRadius: 999, fontSize: 12, cursor: 'pointer',
              background: on ? 'var(--cr-brand-surf)' : 'var(--cr-ink-1)',
              border: `1px solid ${on ? 'var(--cr-brand-line)' : 'var(--cr-line-1)'}`,
            }}>
              <input type="checkbox" checked={on}
                onChange={(e) => setEnabled(group, f, e.target.checked)} />
              <span>{String(f)}</span>
            </label>
          );
        })}
      </div>
    </div>
  );

  return (
    <Card title="Sources"
      hint="Pick exactly which surfaces chat-recall indexes. Anything off here never enters search, summary, or sync.">
      {groupRow('Claude Code',  'claude',
        ['sessions','plans','tasks','pasteCache','history','skills','agents','commands','hooks','plugins'])}
      {groupRow('Gemini',       'gemini',   ['sessions','plans','brain','extensions'])}
      {groupRow('OpenCode',     'opencode', ['sessions','plans','todos','skills'])}
      {groupRow('Codex',        'codex',    ['sessions','plugins','skills'])}
      {groupRow('Antigravity',  'agy',      ['sessions','plans'])}
      {groupRow('Cursor',       'cursor',   ['sessions','skills','agents','commands'])}
      {groupRow('Cross-tool',   'common',   ['mcps','agentMd'])}

      <Disclosure open={pathsOpen} onToggle={setPathsOpen} label="Path overrides (advanced)">
        <Fields>
          <TextField label="Claude home"   value={value.claudeHome ?? ''}     placeholder="~/.claude"
            onChange={(v) => onChange({ ...value, claudeHome: v || undefined })} />
          <TextField label="Gemini home"   value={value.geminiHome ?? ''}     placeholder="~/.gemini"
            onChange={(v) => onChange({ ...value, geminiHome: v || undefined })} />
          <TextField label="Antigravity home" value={value.agyHome ?? ''}     placeholder="~/.gemini/antigravity-cli"
            onChange={(v) => onChange({ ...value, agyHome: v || undefined })} />
          <TextField label="Codex home"    value={value.codexHome ?? ''}      placeholder="~/.codex"
            onChange={(v) => onChange({ ...value, codexHome: v || undefined })} />
          <TextField label="OpenCode DB"   value={value.opencodeDbPath ?? ''} placeholder="~/.local/share/opencode/opencode.db"
            onChange={(v) => onChange({ ...value, opencodeDbPath: v || undefined })} />
          <TextField label="Cursor home"   value={value.cursorHome ?? ''}     placeholder="~/.cursor"
            help="The cursor-agent CLI store."
            onChange={(v) => onChange({ ...value, cursorHome: v || undefined })} />
          <TextField label="Cursor IDE home" value={value.cursorIdeHome ?? ''} placeholder="~/.config/Cursor"
            help="The desktop app's user-data dir. Note the capital C — ~/.config/cursor is the CLI's auth dir."
            onChange={(v) => onChange({ ...value, cursorIdeHome: v || undefined })} />
          <TextField label="Extra Claude homes (comma-separated)"
            value={(value.extraClaudeHomes ?? []).join(', ')}
            placeholder="~/.claude-work, ~/.claude-personal"
            help="Multi-install support. CHAT_RECALL_*_HOME env vars still take precedence over these."
            onChange={(v) => onChange({
              ...value,
              extraClaudeHomes: v.split(',').map(s => s.trim()).filter(Boolean),
            })} />
        </Fields>
      </Disclosure>
    </Card>
  );
}

/**
 * Privacy controls. Apply at index-write time so they also constrain
 * sync (sync can't upload what was never indexed).
 */
function PrivacyCard({
  value, onChange, syncEnabled,
}: {
  value: PrivacySettings;
  onChange: (v: PrivacySettings) => void;
  syncEnabled: boolean;
}) {
  return (
    <Card title="Privacy"
      hint="Strip secrets, paths, and tool output before they enter the index. Recommended ON when Sync is enabled.">
      {syncEnabled && !value.redactIndex && (
        <Banner kind="error">Sync is on but index redaction is off. Secrets in your index would be uploaded.</Banner>
      )}
      <Fields>
        <BoolRow label="Redact secrets in indexed text"
          help="AWS keys, tokens, JWTs, private keys. Env CHAT_RECALL_REDACT_INDEX still wins."
          checked={value.redactIndex} onChange={(b) => onChange({ ...value, redactIndex: b })} />
        <BoolRow label="Replace tool-call results with placeholder"
          help="Most accidental secret leaks come from tool output (env dumps, curl bodies). Web search results are kept."
          checked={value.redactToolOutputs} onChange={(b) => onChange({ ...value, redactToolOutputs: b })} />
        <BoolRow label="Hash absolute file paths"
          help="Replaces /home/me/foo with [path:abc123def456] in chunks. Search by project still works because hashes are stable."
          checked={value.redactFilePaths} onChange={(b) => onChange({ ...value, redactFilePaths: b })} />
        <BoolRow label="Never index paste cache"
          help="Hard-skip ~/.claude/paste-cache regardless of the Sources toggle."
          checked={value.redactPasteCache} onChange={(b) => onChange({ ...value, redactPasteCache: b })} />
        <TextField label="Project denylist (one per line, supports trailing /*)"
          value={(value.projectDenylist ?? []).join('\n')}
          placeholder={'/home/me/secret-project\n/home/me/work/*'}
          onChange={(v) => onChange({ ...value, projectDenylist: v.split('\n').map(s => s.trim()).filter(Boolean) })} />
        <TextField label="Project allowlist (one per line — if non-empty, ONLY these are indexed)"
          value={(value.projectAllowlist ?? []).join('\n')}
          placeholder={'/home/me/code/personal/*'}
          onChange={(v) => {
            const list = v.split('\n').map(s => s.trim()).filter(Boolean);
            onChange({ ...value, projectAllowlist: list.length ? list : undefined });
          }} />
      </Fields>
    </Card>
  );
}

/**
 * Sync settings. Master switch is OFF by default. The token itself is
 * never persisted in settings.json — the user names an env var (e.g.
 * CHAT_RECALL_SYNC_TOKEN) and the uploader reads it at request time.
 */
function SyncCard({
  value, onChange, privacy,
}: {
  value: SyncSettings;
  onChange: (v: SyncSettings) => void;
  privacy: PrivacySettings;
}) {
  const setUpload = (k: keyof SyncSettings['upload'], on: boolean) => {
    onChange({ ...value, upload: { ...value.upload, [k]: on } });
  };
  const tools: Array<'claude' | 'gemini' | 'opencode' | 'codex' | 'agy' | 'cursor'> = ['claude','gemini','opencode','codex','agy','cursor'];

  return (
    <Card title="Sync to remote"
      hint="Upload redacted session data to a chat-recall server (SaaS or self-host). Raw chat content is redacted before it leaves the device; disable Raw archives if you only want derived summaries.">
      <Fields>
        <BoolRow label="Enable sync"
          help="Master switch. Off ⇒ nothing leaves the device, ever."
          checked={value.enabled} onChange={(b) => onChange({ ...value, enabled: b })} />
        {value.enabled && !privacy.redactIndex && (
          <Banner kind="error">Index redaction is OFF. Turn it on in Privacy before enabling Sync.</Banner>
        )}
        <TextField label="Endpoint URL" value={value.endpoint ?? ''}
          placeholder="https://sync.example.com/api/sync"
          onChange={(v) => onChange({ ...value, endpoint: v || undefined })} />
        <TextField label="Bearer token env var"
          help="Name of the env var holding the token. The token itself is NEVER stored in settings.json."
          value={value.tokenRef ?? ''} placeholder="CHAT_RECALL_SYNC_TOKEN"
          onChange={(v) => onChange({ ...value, tokenRef: v || undefined })} />

        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase',
          marginTop: 8, marginBottom: 4, color: 'var(--cr-fg-3)' }}>What leaves the device</div>
        <BoolRow label="Findings (redacted previews of detected secrets)"
          help="Preview is masked tail, never the raw secret."
          checked={value.upload.findings}    onChange={(b) => setUpload('findings', b)} />
        <BoolRow label="Session metadata (derived rows: diff, outcome, commits, markers)"
          help="Also gates KG triple extraction and the raw transcript archive."
          checked={value.upload.sessionMeta} onChange={(b) => setUpload('sessionMeta', b)} />
        <BoolRow label="Raw transcript archives (gzipped + redacted)"
          help="Ship the full redacted conversation archive so the dashboard can replay sessions."
          checked={value.upload.raw !== false} onChange={(b) => setUpload('raw', b)} />
        <BoolRow label="Dismissals (rotated / false-positive marks)"
          help="Dismissals live on the server and sync through the dashboard / MCP."
          checked={value.upload.dismissals}  onChange={(b) => setUpload('dismissals', b)} />
        <BoolRow label="Custom rules (server-managed tenant regex rules)"
          help="Rules are configured in the dashboard and fetched by each collector."
          checked={value.upload.customRules} onChange={(b) => setUpload('customRules', b)} />

        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase',
          marginTop: 8, marginBottom: 4, color: 'var(--cr-fg-3)' }}>Exclusions</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {tools.map(t => {
            const on = value.excludeTools.includes(t);
            return (
              <label key={t} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px',
                borderRadius: 999, fontSize: 12, cursor: 'pointer',
                background: on ? 'var(--cr-warn-surf, var(--cr-ink-1))' : 'var(--cr-ink-1)',
                border: `1px solid ${on ? 'var(--cr-warn-line, var(--cr-line-1))' : 'var(--cr-line-1)'}`,
              }}>
                <input type="checkbox" checked={on}
                  onChange={(e) => onChange({
                    ...value,
                    excludeTools: e.target.checked
                      ? Array.from(new Set([...value.excludeTools, t]))
                      : value.excludeTools.filter(x => x !== t),
                  })} />
                <span>Exclude {t}</span>
              </label>
            );
          })}
        </div>
        <TextField label="Project exclusions (one per line)"
          value={(value.excludeProjects ?? []).join('\n')}
          placeholder={'/home/me/secret-project'}
          onChange={(v) => onChange({ ...value, excludeProjects: v.split('\n').map(s => s.trim()).filter(Boolean) })} />
        <TextField label="Preview pattern exclusions (regex, one per line)"
          help="Last-line filter — any finding whose redacted preview matches one of these is dropped before upload."
          value={(value.excludePreviewPatterns ?? []).join('\n')}
          placeholder={'^npm_\\\\w+$'}
          onChange={(v) => {
            const list = v.split('\n').map(s => s.trim()).filter(Boolean);
            onChange({ ...value, excludePreviewPatterns: list.length ? list : undefined });
          }} />
      </Fields>
    </Card>
  );
}

function BoolRow({
  label, help, checked, onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <label style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0',
      cursor: 'pointer',
    }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
        {help && <span style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>{help}</span>}
      </span>
    </label>
  );
}


// ── Form primitives ─────────────────────────────────────────────────────

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{
      background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)',
      borderRadius: 'var(--cr-radius-md)', padding: 20, marginBottom: 16,
    }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{title}</h3>
      {hint && <p style={{ margin: 0, marginBottom: 16, fontSize: 12, color: 'var(--cr-fg-3)' }}>{hint}</p>}
      {children}
    </section>
  );
}

function CardActions({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>{children}</div>;
}

/**
 * Grouped picker section. Renders a (possibly empty) labeled list of compact
 * radio rows. Each row shows a name, a one-line hint, and an optional ✓/install
 * badge. Selection routes through the choice's `apply()` so the caller never
 * needs to know how a row maps to provider/preset state.
 */
function ChoiceGroup({
  title, accent, choices, value, onChange, kind, muted,
}: {
  title?: string;
  accent?: 'ok';
  choices: SummaryChoice[];
  value: SummarySettings;
  onChange: (s: SummarySettings) => void;
  kind: 'summary' | 'embedding';
  muted?: boolean;
}) {
  if (choices.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      {title && (
        <div style={{
          fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
          textTransform: 'uppercase', marginBottom: 6,
          color: accent === 'ok' ? 'var(--cr-ok-500)' : 'var(--cr-fg-3)',
        }}>{title}</div>
      )}
      <div role="radiogroup" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {choices.map((c) => {
          const sel = c.match(value);
          return (
            <label
              key={c.key}
              data-testid={`${kind}-choice-${c.key}`}
              data-selected={sel}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 12px', borderRadius: 6, cursor: 'pointer',
                background: sel ? 'var(--cr-brand-surf)' : 'transparent',
                border: `1px solid ${sel ? 'var(--cr-brand-line)' : 'var(--cr-line-1)'}`,
                opacity: muted ? 0.55 : 1,
              }}
            >
              <input
                type="radio"
                checked={sel}
                onChange={() => onChange(c.apply(value))}
              />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{c.label}</span>
                {c.hint && (
                  <span style={{
                    fontSize: 11, color: 'var(--cr-fg-3)',
                    fontFamily: c.hint.includes('-') || c.hint.includes('_') || c.hint.includes('"')
                      ? 'var(--cr-font-mono, ui-monospace, monospace)' : undefined,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{c.hint}</span>
                )}
              </span>
              {c.detected === true && (
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 3,
                  background: 'var(--cr-ok-surf)', color: 'var(--cr-ok-500)',
                }}>✓ detected</span>
              )}
              {c.detected === false && (
                <span style={{
                  fontSize: 10, padding: '2px 6px', borderRadius: 3,
                  background: 'var(--cr-ink-2)', color: 'var(--cr-fg-3)',
                }}>install required</span>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function Disclosure({
  open, onToggle, label, children,
}: {
  open: boolean;
  onToggle: (v: boolean) => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        onClick={() => onToggle(!open)}
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--cr-fg-2)', fontSize: 12, padding: 0,
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>▸</span>
        {label}
      </button>
      {open && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

function ProviderRadio<P extends string>({
  providers, value, hints, onChange, kind,
}: {
  providers: readonly P[];
  value: P;
  hints: Record<string, { label: string; requires: string }>;
  onChange: (p: P) => void;
  /** Namespace for the testid so embedding/summary radios don't collide */
  kind: 'embedding' | 'summary';
}) {
  return (
    <div role="radiogroup" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 4 }}>
      {providers.map((p) => {
        const sel = value === p;
        const hint = hints[p];
        return (
          <label
            key={p}
            data-testid={`${kind}-provider-${p}`}
            data-selected={sel}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
              borderRadius: 6, cursor: 'pointer',
              background: sel ? 'var(--cr-brand-surf)' : 'transparent',
              border: `1px solid ${sel ? 'var(--cr-brand-line)' : 'var(--cr-line-1)'}`,
            }}
          >
            <input
              type="radio"
              checked={sel}
              onChange={() => onChange(p)}
              style={{ marginTop: 3 }}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{hint?.label || p}</span>
              {hint?.requires && (
                <span style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>Requires: {hint.requires}</span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function Fields({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>{children}</div>;
}

function TextField(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; help?: string; required?: boolean }) {
  const id = useMemo(() => `field-${Math.random().toString(36).slice(2, 8)}`, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>
        {props.label}{props.required && <span style={{ color: 'var(--cr-warn-500)' }}> *</span>}
      </label>
      <input
        id={id}
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        style={inputStyle}
      />
      {props.help && <span style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>{props.help}</span>}
    </div>
  );
}

function NumField(props: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; placeholder?: string; required?: boolean }) {
  const id = useMemo(() => `field-${Math.random().toString(36).slice(2, 8)}`, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>
        {props.label}{props.required && <span style={{ color: 'var(--cr-warn-500)' }}> *</span>}
      </label>
      <input
        id={id}
        type="number"
        value={props.value ?? ''}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        style={inputStyle}
      />
    </div>
  );
}

function KeyField(props: { label: string; value: string; onChange: (v: string) => void; help?: string }) {
  return <TextField {...props} placeholder="Leave blank to keep current key" />;
}

function SelectField(props: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  optionLabels?: Record<string, string>;
}) {
  const id = useMemo(() => `field-${Math.random().toString(36).slice(2, 8)}`, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>{props.label}</label>
      <select id={id} value={props.value} onChange={(e) => props.onChange(e.target.value)} style={inputStyle}>
        {props.options.map((o) => (
          <option key={o} value={o}>
            {o ? (props.optionLabels?.[o] ?? o) : '(custom)'}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Model input with a "Load" button that fetches the provider's catalog and
 * populates a datalist — pick from the list or type a custom id. Used by both
 * summary and embedding cards.
 */
function ModelField(props: {
  label: string; value: string; placeholder?: string;
  onChange: (v: string) => void;
  kind: 'summary' | 'embedding';
  provider: string; baseUrl?: string; apiKey?: string;
}) {
  const id = useMemo(() => `model-${Math.random().toString(36).slice(2, 8)}`, []);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setErr(null);
    const r = await fetchProviderModels({ kind: props.kind, provider: props.provider, baseUrl: props.baseUrl, apiKey: props.apiKey });
    setModels(r.models);
    setErr(r.error || (r.models.length === 0 ? 'No models returned' : null));
    setLoading(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>{props.label}</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input id={id} list={`${id}-list`} value={props.value} placeholder={props.placeholder}
          onChange={(e) => props.onChange(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
        {/* Alphabetical; the label carries the $/M price when the provider reports it. */}
        <datalist id={`${id}-list`}>{models.map((m) => <option key={m.id} value={m.id} label={m.label} />)}</datalist>
        <button type="button" onClick={load} disabled={loading}
          style={{ ...inputStyle, width: 'auto', padding: '0 12px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          {loading ? '…' : 'Load models'}
        </button>
      </div>
      {models.length > 0 && <span style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>{models.length} models — pick or type</span>}
      {err && <span style={{ fontSize: 11, color: 'var(--cr-warn-500)' }}>{err}</span>}
    </div>
  );
}

function StatusBadge({ ok, message }: { ok: boolean; message: string }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 8px', borderRadius: 4, fontSize: 11,
      background: ok ? 'var(--cr-ok-surf)' : 'var(--cr-warn-surf)',
      color: ok ? 'var(--cr-ok-500)' : 'var(--cr-warn-500)',
      width: 'fit-content',
    }}>
      <span>{ok ? '✓' : '⚠'}</span> {message}
    </div>
  );
}

function TestResultLine({ result }: { result: TestResult }) {
  return (
    <div style={{ fontSize: 12, color: result.ok ? 'var(--cr-ok-500)' : 'var(--cr-warn-500)' }}>
      {result.ok
        ? <>✓ Connected{result.dimension ? ` (dim ${result.dimension})` : ''}{result.note ? ` — ${result.note}` : ''}{result.version ? ` — ${result.version}` : ''}</>
        : <>✗ {result.error || 'Failed'}</>}
    </div>
  );
}

function Banner({ kind, children }: { kind: 'ok' | 'error'; children: React.ReactNode }) {
  return (
    <div style={{
      padding: '10px 12px', marginBottom: 14, borderRadius: 6, fontSize: 12,
      background: kind === 'ok' ? 'var(--cr-ok-surf)' : 'var(--cr-warn-surf)',
      color: kind === 'ok' ? 'var(--cr-ok-500)' : 'var(--cr-warn-500)',
      border: `1px solid ${kind === 'ok' ? 'var(--cr-ok-line)' : 'var(--cr-warn-line)'}`,
    }}>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'var(--cr-ink-0)',
  border: '1px solid var(--cr-line-1)',
  borderRadius: 4,
  padding: '6px 10px',
  fontSize: 13,
  color: 'var(--cr-fg-1)',
  fontFamily: 'inherit',
};
