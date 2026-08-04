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
import { getSyncConfig, saveSyncConfig, getSyncSources, type ReportedSource } from '../services/api';

/** Display names for the tool a source belongs to. */
const TOOL_LABELS: Record<string, string> = {
  claude: 'Claude Code', gemini: 'Gemini CLI', codex: 'Codex',
  agy: 'Antigravity', opencode: 'OpenCode',
};

const TOOLS: Array<[string, string]> = [
  ['claude', 'Claude Code'], ['gemini', 'Gemini CLI'], ['opencode', 'OpenCode'], ['codex', 'Codex'], ['agy', 'Antigravity'],
];

export default function SyncRules() {
  const [tools, setTools] = useState<string[]>([]);
  const [projects, setProjects] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'error'>('loading');
  const [err, setErr] = useState('');
  const [sources, setSources] = useState<ReportedSource[]>([]);
  const [excludedSources, setExcludedSources] = useState<string[]>([]);
  const [approvedSources, setApprovedSources] = useState<string[]>([]);

  useEffect(() => {
    let on = true;
    getSyncConfig()
      .then((c) => {
        if (!on) return;
        setTools(c.excludeTools);
        setProjects(c.excludeProjects.join('\n'));
        setExcludedSources(c.excludeSources ?? []);
        setApprovedSources(c.approveSources ?? []);
        setState('ready');
      })
      .catch((e) => { if (!on) return; setErr(String(e.message || e)); setState('error'); });
    // Sources are reported by each collector; a server that has never been
    // synced simply shows none. Never fatal — the rest of the panel works.
    getSyncSources()
      .then((r) => { if (on) { setSources(r.sources ?? []); } })
      .catch(() => { /* older server, or nothing reported yet */ });
    return () => { on = false; };
  }, []);

  async function save() {
    setState('saving'); setErr('');
    try {
      const cfg = await saveSyncConfig({
        excludeTools: tools,
        excludeProjects: projects.split('\n').map((s) => s.trim()).filter(Boolean),
        excludeSources: excludedSources,
        approveSources: approvedSources,
      });
      setTools(cfg.excludeTools);
      setProjects(cfg.excludeProjects.join('\n'));
      setExcludedSources(cfg.excludeSources ?? []);
      setApprovedSources(cfg.approveSources ?? []);
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
      <div style={{ color: 'var(--cr-fg-2)', lineHeight: 1.55, marginBottom: 12 }}>
        Choose what chat-recall should <strong>never</strong> sync. These rules apply to every machine
        you connect, starting at its next sync. (A machine can always add its own stricter rules —
        nothing here can loosen those.)
      </div>
      <div style={{
        color: 'var(--cr-fg-2)', fontSize: 12.5, lineHeight: 1.5, marginBottom: 14,
        padding: '9px 12px', borderRadius: 'var(--cr-radius-md, 8px)',
        border: '1px solid var(--cr-line-1)', background: 'var(--cr-ink-1)',
      }}>
        🔒 Personal folders — Pictures, Music, Movies, Documents, Desktop, Downloads — are
        <strong> never indexed by default</strong>. To include a project that lives in one, run
        <code> chat-recall include project &lt;path&gt;</code> on that machine.
      </div>

      {/* Folders the collector found but nobody has decided about yet. These are
          NOT syncing — silence must never mean "we uploaded your work account" —
          so they get an explicit prompt rather than an easily-missed checkbox. */}
      {sources.filter((x) => x.decision === 'pending' && !approvedSources.includes(x.id)).length > 0 && (
        <div style={{
          margin: '0 0 16px', padding: '12px 14px', borderRadius: 'var(--cr-radius-md, 8px)',
          border: '1px solid var(--cr-warn-500, #c98a00)', background: 'var(--cr-ink-1)',
        }}>
          <div style={{ fontWeight: 700, color: 'var(--cr-fg-1)', marginBottom: 6 }}>
            New transcript folders found — not syncing yet
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--cr-fg-2)', lineHeight: 1.5, marginBottom: 10 }}>
            One of your machines found these and is waiting for a decision. A separate work
            account usually belongs out of this workspace — nothing from them has been uploaded.
          </div>
          {sources
            .filter((x) => x.decision === 'pending' && !approvedSources.includes(x.id))
            .map((src) => (
              <div key={`${src.device || ''}|${src.id}`} style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                padding: '7px 0', borderTop: '1px solid var(--cr-line-1)',
              }}>
                <span style={{ flex: 1, minWidth: 220 }}>
                  <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 12.5, color: 'var(--cr-fg-1)', wordBreak: 'break-all' }}>
                    {src.path}
                  </span>
                  <span style={{ display: 'block', color: 'var(--cr-fg-3)', fontSize: 11.5, marginTop: 2 }}>
                    {TOOL_LABELS[src.tool] || src.tool}
                    {src.device ? ` · ${src.device}` : ''}
                    {src.sessions > 0 ? ` · ${src.sessions} session${src.sessions === 1 ? '' : 's'}` : ''}
                  </span>
                </span>
                <Button
                  onClick={() => setApprovedSources((prev) => [...new Set([...prev, src.id])])}
                >
                  Sync this
                </Button>
                <button
                  onClick={() => setExcludedSources((prev) => [...new Set([...prev, src.id])])}
                  style={{ background: 'transparent', border: '1px solid var(--cr-line-1)', color: 'var(--cr-fg-2)', padding: '6px 12px', borderRadius: 4, cursor: 'pointer' }}
                >
                  Keep out
                </button>
              </div>
            ))}
          <div style={{ fontSize: 11.5, color: 'var(--cr-fg-3)', marginTop: 10 }}>
            Applies on that machine's next sync. Same thing from a terminal:
            <code style={{ marginLeft: 4 }}>chat-recall sources</code>
          </div>
        </div>
      )}

      {sources.length > 0 && (
        <>
          <div style={cap}>Transcript sources on your machines</div>
          <div style={{ color: 'var(--cr-fg-2)', fontSize: 12.5, lineHeight: 1.5, margin: '6px 0 10px' }}>
            Each machine reports the profile folders it finds for every AI tool — Claude Code, Gemini,
            Codex, Antigravity and OpenCode. Untick one to stop syncing it, which is how you keep a
            work profile out of this workspace. chat-recall can only switch off a folder a machine
            already found; it can never be pointed at a new path from here.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '0 0 16px' }}>
            {sources.map((src) => {
              const off = excludedSources.includes(src.id);
              return (
                <label
                  key={`${src.device || ''}|${src.id}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                    padding: '8px 10px', borderRadius: 'var(--cr-radius-md, 8px)',
                    border: '1px solid var(--cr-line-1)',
                    background: off ? 'transparent' : 'var(--cr-ink-1)',
                    opacity: off ? 0.6 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!off}
                    onChange={(e) => setExcludedSources((prev) =>
                      e.target.checked ? prev.filter((x) => x !== src.id) : [...prev, src.id])}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{
                      fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-1)',
                      wordBreak: 'break-all', fontSize: 12.5,
                    }}>{src.path}</span>
                    <span style={{ display: 'block', color: 'var(--cr-fg-3)', fontSize: 11.5, marginTop: 2 }}>
                      {TOOL_LABELS[src.tool] || src.tool}
                      {src.device ? ` · ${src.device}` : ''}
                      {/* OpenCode keeps sessions in a SQLite file, so a row count
                          would mean loading a native driver just to draw a
                          checkbox — the profile is listed without one. */}
                      {src.sessions > 0 ? ` · ${src.sessions} session${src.sessions === 1 ? '' : 's'}` : ''}
                      {src.isPrimary ? ' · main profile' : ''}
                      {off ? ' · not syncing' : ''}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </>
      )}

      <div style={cap}>Don't sync these AI tools</div>
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

      <div style={cap}>Don't sync these folders</div>
      <div style={{ color: 'var(--cr-fg-3)', fontSize: 12, marginTop: 4, marginBottom: 2 }}>
        One path per line. Matches any project whose path contains the text — so <code>.claude-pr-bot</code>
        skips every worktree under it.
      </div>
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
