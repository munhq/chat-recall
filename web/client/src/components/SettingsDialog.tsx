/**
 * Settings dialog. Two cards — Embeddings and Summaries — each with a radio
 * to pick a provider and provider-specific fields. The "Test" button validates
 * the current config without saving (POST /api/settings/test). API keys are
 * masked on the wire (••••xxxx); leaving the masked value untouched preserves
 * the stored key on save.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Icon, Button } from './primitives';
import {
  getSettings,
  saveSettings,
  testSettings,
  getCodeindexStatus,
  uninstallCodeindex,
  type AppSettings,
  type SettingsResponse,
  type TestResult,
  type EmbeddingSettings,
  type SummarySettings,
  type EmbedderProvider,
  type SummaryProvider,
  type CodeindexInfo,
} from '../services/api';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 'modal' (default) — overlay dialog. 'page' — render inline as a full page. */
  variant?: 'modal' | 'page';
}

export default function SettingsDialog({ open, onClose, variant = 'modal' }: Props) {
  const [resp, setResp] = useState<SettingsResponse | null>(null);
  const [emb, setEmb] = useState<EmbeddingSettings | null>(null);
  const [sm, setSm] = useState<SummarySettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [embTest, setEmbTest] = useState<TestResult | null>(null);
  const [smTest, setSmTest] = useState<TestResult | null>(null);
  const [embTesting, setEmbTesting] = useState(false);
  const [smTesting, setSmTesting] = useState(false);
  const [codeindex, setCodeindex] = useState<CodeindexInfo | null>(null);
  const [codeindexBusy, setCodeindexBusy] = useState(false);
  const [codeindexError, setCodeindexError] = useState('');

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
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // Codeindex status loads in parallel — separate spinner so the main
    // settings render isn't gated on it.
    getCodeindexStatus().then(setCodeindex).catch(() => { /* tolerate older servers */ });
  }, [open]);

  const refreshCodeindex = async () => {
    setCodeindexBusy(true); setCodeindexError('');
    try { setCodeindex(await getCodeindexStatus()); }
    catch (e) { setCodeindexError((e as Error).message); }
    finally { setCodeindexBusy(false); }
  };

  const handleUninstallCodeindex = async () => {
    setCodeindexBusy(true); setCodeindexError('');
    try {
      await uninstallCodeindex();
      await refreshCodeindex();
    } catch (e) {
      setCodeindexError((e as Error).message);
    } finally {
      setCodeindexBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = async () => {
    if (!emb || !sm) return;
    setSaving(true); setMessage(''); setError('');
    try {
      const r = await saveSettings({ embedding: emb, summary: sm } as Partial<AppSettings>);
      setMessage('Saved. ' + r.restartHint);
      // Re-pull masks from server so the input fields show ••••xxxx after save.
      const d = await getSettings();
      setResp(d);
      setEmb(d.settings.embedding);
      setSm(d.settings.summary);
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
  const outer: React.CSSProperties = isPage
    ? { flex: 1, overflowY: 'auto', background: 'var(--cr-ink-0)' }
    : {
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      };
  const inner: React.CSSProperties = isPage
    ? {
        maxWidth: 880, margin: '32px auto', padding: '0 32px 64px',
        color: 'var(--cr-fg-1)',
      }
    : {
        width: 'min(880px, 100%)', maxHeight: '92vh', overflowY: 'auto',
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
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--cr-fg-3)' }}
          >
            <Icon name="x" size={18} />
          </button>
        </header>

        {loading && <div style={{ color: 'var(--cr-fg-3)', padding: 24 }}>Loading…</div>}
        {error && <Banner kind="error">{error}</Banner>}
        {message && <Banner kind="ok">{message}</Banner>}

        {resp && emb && sm && (
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

            <CodeindexCard
              info={codeindex}
              busy={codeindexBusy}
              error={codeindexError}
              onRefresh={refreshCodeindex}
              onUninstall={handleUninstallCodeindex}
            />

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
  { key: 'none',          group: 'recommended', label: 'Keyword search only (FTS5)',       hint: 'No setup. Works out of the box.' },
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
      hint="Powers semantic search. Keyword search (FTS5) is the default and works without any provider.">
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
          <TextField label="Model" value={value.openaiModel ?? ''} placeholder="text-embedding-3-small"
            onChange={(v) => onChange({ ...value, openaiModel: v })} />
        </Fields>
      )}

      {value.provider === 'nvidia' && (
        <Fields>
          <KeyField label="NVIDIA_API_KEY" value={value.nvidiaApiKey ?? ''}
            help="Free at build.nvidia.com — Nvidia hosts several embedding models including nv-embed-v1"
            onChange={(v) => onChange({ ...value, nvidiaApiKey: v })} />
          <TextField label="Model" value={value.nvidiaModel ?? ''} placeholder="nvidia/nv-embed-v1"
            onChange={(v) => onChange({ ...value, nvidiaModel: v })} />
        </Fields>
      )}

      {value.provider === 'openai-compat' && (
        <Fields>
          <TextField label="Base URL" value={value.openaiCompatBaseUrl ?? ''}
            placeholder="http://localhost:8080/v1" required
            onChange={(v) => onChange({ ...value, openaiCompatBaseUrl: v })} />
          <TextField label="Model" value={value.openaiCompatModel ?? ''}
            placeholder="custom-model-name" required
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

  // Only providers with a working backend in summary-generator.ts.
  // 'gemini' / 'openai' / 'nvidia' / 'ollama-cloud' / 'openai-compat' are
  // listed by the embedding side but aren't implemented for summaries — they
  // were exposed in the old UI and silently did nothing. Keeping them out
  // until they're wired up.
  const cloudRows: SummaryChoice[] = [
    {
      key: 'claude-api',
      group: 'cloud',
      label: 'Anthropic Claude API',
      hint: 'ANTHROPIC_API_KEY',
      match: (s) => s.provider === 'claude',
      apply: (s) => ({ ...s, provider: 'claude' }),
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

      <CardActions>
        <Button variant="outline" onClick={onTest} disabled={testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        {testResult && <TestResultLine result={testResult} />}
      </CardActions>
    </Card>
  );
}

// ── Codeindex companion ─────────────────────────────────────────────────

function CodeindexCard({
  info, busy, error, onRefresh, onUninstall,
}: {
  info: CodeindexInfo | null;
  busy: boolean;
  error: string;
  onRefresh: () => void;
  onUninstall: () => void;
}) {
  if (!info) {
    return (
      <Card title="Code intelligence (codeindex)" hint="Loading status…">
        <div style={{ height: 12 }} />
      </Card>
    );
  }
  const s = info.status;
  return (
    <Card
      title="Code intelligence (codeindex)"
      hint="A separate MCP server that gives the agent code-level lookup. chat-recall remembers what you've done; codeindex understands what's currently in your code."
    >
      <div data-testid="codeindex-status" style={{ marginBottom: 12 }}>
        {s.installed ? (
          <StatusBadge ok={true}
            message={`Installed: ${s.path}${s.size ? ` · ${(s.size / 1024 / 1024).toFixed(1)} MB` : ''}${s.version ? ` · ${s.version}` : ''}. Auto-registered as an MCP server.`} />
        ) : (
          <StatusBadge ok={false} message="Not installed. chat-recall works without it; install separately to enable code-level lookups." />
        )}
      </div>

      {error && (
        <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--cr-warn-500)' }}>✗ {error}</div>
      )}

      {!s.installed && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--cr-fg-2)', marginBottom: 8 }}>To install, run one of:</div>
          <CommandLine label="chat-recall CLI" command={info.installHint.cli} />
          <CommandLine label="curl" command={info.installHint.curl} />
          <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginTop: 8 }}>
            Source &amp; releases: <a href={info.installHint.repo} target="_blank" rel="noreferrer" style={{ color: 'var(--cr-brand-500)' }}>{info.installHint.repo}</a>
          </div>
          <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginTop: 4 }}>
            After installing, click <strong>Refresh</strong>. chat-recall will detect the binary and register it as an MCP server.
          </div>
        </div>
      )}

      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--cr-fg-2)', marginBottom: 8 }}>
          What does it provide? ({info.capabilities.length} tools)
        </summary>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--cr-fg-2)' }}>
          {info.capabilities.map((c) => (
            <li key={c.name} style={{ marginBottom: 4 }}>
              <code style={{ fontSize: 11 }}>{c.name}</code> — {c.desc}
            </li>
          ))}
        </ul>
        <p style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginTop: 12 }}>{info.pitch}</p>
      </details>

      <CardActions>
        <Button variant="outline" size="sm" icon="refresh" onClick={onRefresh} disabled={busy}>
          {busy ? 'Checking…' : 'Refresh'}
        </Button>
        {s.installed && (
          <Button variant="ghost" onClick={onUninstall} disabled={busy}>
            {busy ? 'Removing…' : 'Disable / Uninstall'}
          </Button>
        )}
      </CardActions>
    </Card>
  );
}

function CommandLine({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard may be unavailable in non-secure contexts */ }
  };
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginBottom: 2 }}>{label}</div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', background: 'var(--cr-ink-0)',
        border: '1px solid var(--cr-line-1)', borderRadius: 4,
      }}>
        <code style={{ flex: 1, fontSize: 12, fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)', whiteSpace: 'nowrap', overflow: 'auto' }}>
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy"
          style={{
            background: 'transparent', border: '1px solid var(--cr-line-1)',
            color: 'var(--cr-fg-2)', fontSize: 11, padding: '2px 8px',
            borderRadius: 3, cursor: 'pointer', flexShrink: 0,
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
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
