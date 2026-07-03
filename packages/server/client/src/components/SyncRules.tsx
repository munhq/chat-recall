/**
 * Sync rules — the dashboard-editable half of sync exclusions.
 *
 * Saved server-side per tenant; every device's sync client pulls this at the
 * start of each sync and UNIONS it with the machine's local rules
 * (`chat-recall exclude …`). Union means this panel can only ADD protection
 * across the fleet — it can never re-enable something a machine excluded
 * locally. Changes apply from each device's next sync; rows already synced
 * stay until deleted.
 */
import React, { useEffect, useState } from 'react';
import { Button } from './primitives';
import { getSyncConfig, saveSyncConfig } from '../services/api';

const TOOLS: Array<[string, string]> = [
  ['claude', 'Claude Code'], ['gemini', 'Gemini CLI'], ['opencode', 'OpenCode'], ['codex', 'Codex'], ['agy', 'Antigravity'],
];

export default function SyncRules() {
  const [tools, setTools] = useState<string[]>([]);
  const [projects, setProjects] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'error'>('loading');
  const [err, setErr] = useState('');

  useEffect(() => {
    let on = true;
    getSyncConfig()
      .then((c) => { if (!on) return; setTools(c.excludeTools); setProjects(c.excludeProjects.join('\n')); setState('ready'); })
      .catch((e) => { if (!on) return; setErr(String(e.message || e)); setState('error'); });
    return () => { on = false; };
  }, []);

  async function save() {
    setState('saving'); setErr('');
    try {
      const cfg = await saveSyncConfig({
        excludeTools: tools,
        excludeProjects: projects.split('\n').map((s) => s.trim()).filter(Boolean),
      });
      setTools(cfg.excludeTools);
      setProjects(cfg.excludeProjects.join('\n'));
      setState('saved');
      setTimeout(() => setState('ready'), 1500);
    } catch (e: any) {
      setErr(String(e.message || e));
      setState('error');
    }
  }

  if (state === 'loading') return <div style={{ color: 'var(--cr-fg-3)', fontSize: 13 }}>Loading rules…</div>;

  const cap: React.CSSProperties = { fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cr-fg-3)' };

  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ color: 'var(--cr-fg-2)', lineHeight: 1.5, marginBottom: 10 }}>
        Applies to <strong>every connected device</strong> from its next sync. Devices can add stricter
        local rules with <code>chat-recall exclude</code> — server rules never override those.
      </div>

      <div style={cap}>Exclude AI tools</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, margin: '8px 0 14px' }}>
        {TOOLS.map(([id, label]) => (
          <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--cr-fg-1)' }}>
            <input
              type="checkbox"
              checked={tools.includes(id)}
              onChange={(e) => setTools(e.target.checked ? [...new Set([...tools, id])] : tools.filter((t) => t !== id))}
            />
            {label}
          </label>
        ))}
      </div>

      <div style={cap}>Exclude project paths (one per line, substring match)</div>
      <textarea
        value={projects}
        onChange={(e) => setProjects(e.target.value)}
        placeholder={'/home/me/secret-project\n.claude-pr-bot'}
        rows={4}
        style={{
          width: '100%', marginTop: 8, font: 'inherit', fontSize: 12.5, padding: '8px 10px',
          borderRadius: 'var(--cr-radius-md, 8px)', border: '1px solid var(--cr-line-2)',
          background: 'var(--cr-ink-0)', color: 'var(--cr-fg-1)', resize: 'vertical',
        }}
      />

      {err && <div style={{ color: 'var(--cr-err-500)', marginTop: 8 }}>{err}</div>}
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button variant="primary" onClick={save} disabled={state === 'saving'}>
          {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved ✓' : 'Save rules'}
        </Button>
      </div>
    </div>
  );
}
