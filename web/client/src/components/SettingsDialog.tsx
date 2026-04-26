import React, { useEffect, useState } from 'react';
import { Icon, Button } from './primitives';
import {
  getSettings,
  saveSettings,
  type AppSettings,
  type SettingsResponse,
} from '../services/api';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsDialog({ open, onClose }: Props) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<AppSettings>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setMessage('');
    setError('');
    getSettings()
      .then((d) => {
        setData(d);
        setForm({ ...d.settings });
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const set = (k: keyof AppSettings, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const res = await saveSettings(form);
      setMessage(`Saved ${res.updated.length} setting${res.updated.length === 1 ? '' : 's'}. ${res.restartHint}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const provider = form.SUMMARY_PROVIDER || 'gemini-cli';
  const showCliFields = provider === 'cli';
  const showOllamaModel = provider === 'ollama';

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="settings-dialog"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(640px, 92vw)',
          maxHeight: '88vh',
          overflowY: 'auto',
          background: 'var(--cr-ink-1)',
          color: 'var(--cr-fg-1)',
          border: '1px solid var(--cr-line-1)',
          borderRadius: 12,
          boxShadow: '0 16px 48px rgba(0,0,0,0.4)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 18px', borderBottom: '1px solid var(--cr-line-1)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
            <Icon name="settings" size={16} />
            Settings
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--cr-fg-2)' }}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {loading && <div style={{ color: 'var(--cr-fg-3)' }}>Loading…</div>}
          {error && (
            <div style={{ color: '#f87171', fontSize: 13 }}>
              {error}
            </div>
          )}

          {data && (
            <>
              <Section title="Summary provider" hint="Used when (re)generating session summaries.">
                <Select
                  label="Provider"
                  value={provider}
                  onChange={(v) => set('SUMMARY_PROVIDER', v)}
                  options={data.presets.summaryProviders}
                />
                {showCliFields && (
                  <>
                    <Select
                      label="CLI preset"
                      value={form.SUMMARY_CLI_PRESET || ''}
                      onChange={(v) => set('SUMMARY_CLI_PRESET', v)}
                      options={['', ...data.presets.summaryCliPresets]}
                      hint="Pick a preset or leave blank and set a custom command below."
                    />
                    <TextInput
                      label="Custom CLI command (optional)"
                      value={form.SUMMARY_CLI_CMD || ''}
                      onChange={(v) => set('SUMMARY_CLI_CMD', v)}
                      placeholder={'opencode run "$(cat {prompt_file})"'}
                      hint="Overrides preset. {prompt_file} is substituted; omit to pipe on stdin."
                    />
                    <TextInput
                      label="Timeout (ms)"
                      value={form.SUMMARY_CLI_TIMEOUT_MS || ''}
                      onChange={(v) => set('SUMMARY_CLI_TIMEOUT_MS', v)}
                      placeholder="120000"
                    />
                  </>
                )}
                {provider === 'gemini-cli' && (
                  <TextInput
                    label="Gemini model"
                    value={form.GEMINI_MODEL || ''}
                    onChange={(v) => set('GEMINI_MODEL', v)}
                    placeholder="gemini-3-flash-preview"
                  />
                )}
                {showOllamaModel && (
                  <TextInput
                    label="Ollama chat model"
                    value={form.OLLAMA_SUMMARY_MODEL || ''}
                    onChange={(v) => set('OLLAMA_SUMMARY_MODEL', v)}
                    placeholder="qwen2.5:7b"
                    hint="Must be pulled locally: `ollama pull <model>`."
                  />
                )}
              </Section>

              <Section title="Embedding provider" hint="Used for vector search indexing.">
                <Select
                  label="Provider"
                  value={form.EMBEDDING_PROVIDER || ''}
                  onChange={(v) => set('EMBEDDING_PROVIDER', v)}
                  options={data.presets.embeddingProviders}
                />
                <TextInput
                  label="Ollama host"
                  value={form.OLLAMA_HOST || ''}
                  onChange={(v) => set('OLLAMA_HOST', v)}
                  placeholder="http://localhost:11434"
                />
              </Section>

              <Section title="Paths">
                <TextInput
                  label="Claude data dir"
                  value={form.CLAUDE_DIR || ''}
                  onChange={(v) => set('CLAUDE_DIR', v)}
                  placeholder="~/.claude"
                />
              </Section>

              <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>
                Stored in <code>{data.envPath}</code>. Restart the backend to apply
                (<code>systemctl --user restart chat-recall-api</code>).
              </div>

              {message && (
                <div
                  style={{
                    fontSize: 12, color: 'var(--cr-fg-2)', background: 'var(--cr-ink-2)',
                    padding: '8px 10px', borderRadius: 6,
                  }}
                >
                  {message}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex', justifyContent: 'flex-end', gap: 8,
            padding: '12px 18px', borderTop: '1px solid var(--cr-line-1)',
          }}
        >
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || loading || !data} data-testid="settings-save">
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--cr-fg-1)', letterSpacing: '0.02em', textTransform: 'uppercase' }}>
          {title}
        </div>
        {hint && <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginTop: 2 }}>{hint}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  );
}

function Select({
  label, value, onChange, options, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  hint?: string;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: 'var(--cr-ink-2)', color: 'var(--cr-fg-1)',
          border: '1px solid var(--cr-line-1)', borderRadius: 6,
          padding: '6px 8px', fontSize: 13,
        }}
      >
        {options.map((o) => (
          <option key={o} value={o}>{o || '(none)'}</option>
        ))}
      </select>
      {hint && <span style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>{hint}</span>}
    </label>
  );
}

function TextInput({
  label, value, onChange, placeholder, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          background: 'var(--cr-ink-2)', color: 'var(--cr-fg-1)',
          border: '1px solid var(--cr-line-1)', borderRadius: 6,
          padding: '6px 8px', fontSize: 13, fontFamily: 'var(--cr-font-mono, monospace)',
        }}
      />
      {hint && <span style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>{hint}</span>}
    </label>
  );
}
