import { useMemo } from 'react';
import type { Message, Subagent } from '../services/api';

/**
 * Session waterfall (the Sentry "AI Spans" steal). Renders a session as an
 * ordered trace: user prompt → assistant turn → nested tool calls (with
 * error/target) → subagent handoffs, with relative timestamps. Built entirely
 * from the conversation data the viewer already loads — no new endpoint.
 */
export default function SessionTrace({ messages, subagents }: { messages: Message[]; subagents: Subagent[] }) {
  const t0 = useMemo(() => {
    const first = messages.find((m) => m.timestamp)?.timestamp;
    return first ? new Date(first).getTime() : null;
  }, [messages]);

  const rel = (ts?: string): string => {
    if (!ts || !t0) return '';
    const d = (new Date(ts).getTime() - t0) / 1000;
    if (d < 0) return '';
    return d < 60 ? `+${d.toFixed(0)}s` : d < 3600 ? `+${(d / 60).toFixed(1)}m` : `+${(d / 3600).toFixed(1)}h`;
  };

  // Tool-usage summary across the session (count + failures per tool).
  const toolCounts = useMemo(() => {
    const m = new Map<string, { n: number; err: number }>();
    for (const msg of messages) for (const tc of msg.toolCalls || []) {
      const e = m.get(tc.name) || { n: 0, err: 0 };
      e.n++; if (tc.isError) e.err++; m.set(tc.name, e);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [messages]);

  const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (turns.length === 0) return <div className="trace-empty">No turns to trace for this session.</div>;

  return (
    <div className="trace">
      <style>{CSS}</style>

      {toolCounts.length > 0 && (
        <div className="trace-tools">
          {toolCounts.map(([name, c]) => (
            <span key={name} className="trace-chip">
              {name} <b>×{c.n}</b>{c.err > 0 && <em className="err"> · {c.err}✗</em>}
            </span>
          ))}
        </div>
      )}

      <div className="trace-timeline">
        {turns.map((m, i) => (
          <div key={i} className={`trace-node ${m.role}`}>
            <span className="trace-dot" />
            <div className="trace-body">
              <div className="trace-line">
                <span className="trace-who">{m.role === 'user' ? 'You' : 'Assistant'}</span>
                {m.timestamp && <span className="trace-time">{rel(m.timestamp)}</span>}
              </div>
              {m.content && <div className="trace-text">{firstLine(m.content)}</div>}
              {(m.toolCalls || []).length > 0 && (
                <div className="trace-tools-list">
                  {m.toolCalls!.map((tc, j) => (
                    <div key={j} className={`trace-call ${tc.isError ? 'err' : ''}`}>
                      <span className="trace-call-name">🔧 {tc.name}</span>
                      <span className="trace-call-target">{toolTarget(tc.input)}</span>
                      {tc.isError && <span className="trace-call-badge">✗</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {subagents.length > 0 && (
        <div className="trace-subs">
          <div className="trace-subs-head">↪ Subagent handoffs ({subagents.length})</div>
          {subagents.map((s) => (
            <div key={s.id} className="trace-sub">
              <span className="trace-sub-kind">{s.agentType || s.kind}</span>
              <span className="muted">{s.toolUseCount} tool calls · {s.messageCount} msgs</span>
              {s.description && <div className="trace-sub-desc">{firstLine(s.description)}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function firstLine(s: string): string {
  const line = (s || '').replace(/\s+/g, ' ').trim();
  return line.length > 160 ? line.slice(0, 160) + '…' : line;
}

/** Pull a short, human target out of a tool-call input (file, command, query). */
function toolTarget(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const v = (o.file_path || o.path || o.command || o.pattern || o.query || o.url || o.notebook_path) as string | undefined;
  if (!v) return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 80 ? '…' + s.slice(-80) : s;
}

const CSS = `
.trace { padding: 4px 2px; }
.trace-empty { color: var(--cr-fg-3,#6b7280); padding: 24px; font-size: 14px; }
.trace-tools { display:flex; flex-wrap:wrap; gap:8px; margin-bottom: 18px; }
.trace-chip { font-size:12px; background: var(--cr-ink-2,#171b21); border:1px solid var(--cr-line-1,#1e232b); border-radius:999px; padding:4px 11px; color: var(--cr-fg-2,#aab1bd); }
.trace-chip b { color: var(--cr-fg-1,#e8eaed); }
.trace-chip .err { color: var(--cr-err-500,#f87171); font-style:normal; }
.trace-timeline { position:relative; padding-left: 8px; }
.trace-node { display:flex; gap:12px; padding-bottom: 4px; position:relative; }
.trace-node::before { content:''; position:absolute; left:4px; top:14px; bottom:-4px; width:1px; background: var(--cr-line-1,#1e232b); }
.trace-node:last-child::before { display:none; }
.trace-dot { width:9px; height:9px; border-radius:50%; flex:none; margin-top:5px; background: var(--cr-line-3,#39404a); z-index:1; }
.trace-node.user .trace-dot { background: var(--cr-brand-500,#5b8def); }
.trace-node.assistant .trace-dot { background: var(--cr-ok-500,#4ade80); }
.trace-body { flex:1; min-width:0; padding-bottom: 14px; }
.trace-line { display:flex; align-items:center; gap:10px; }
.trace-who { font-size:13px; font-weight:600; }
.trace-node.user .trace-who { color: var(--cr-brand-500,#5b8def); }
.trace-time { font-size:11px; color: var(--cr-fg-3,#6b7280); font-family: var(--cr-font-mono,monospace); }
.trace-text { font-size:13px; color: var(--cr-fg-2,#aab1bd); margin-top:3px; line-height:1.45; }
.trace-tools-list { margin-top:8px; display:flex; flex-direction:column; gap:4px; }
.trace-call { display:flex; align-items:center; gap:8px; font-size:12px; padding:4px 8px; background: var(--cr-ink-1,#12151a); border:1px solid var(--cr-line-1,#1e232b); border-radius:7px; }
.trace-call.err { border-color: var(--cr-err-line,#5a2329); }
.trace-call-name { font-weight:600; white-space:nowrap; }
.trace-call-target { color: var(--cr-fg-3,#6b7280); font-family: var(--cr-font-mono,monospace); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.trace-call-badge { margin-left:auto; color: var(--cr-err-500,#f87171); font-weight:700; }
.trace-subs { margin-top: 22px; border-top:1px solid var(--cr-line-1,#1e232b); padding-top:16px; }
.trace-subs-head { font-size:13px; font-weight:600; margin-bottom:10px; }
.trace-sub { padding:8px 12px; background: var(--cr-ink-1,#12151a); border:1px solid var(--cr-line-1,#1e232b); border-radius:8px; margin-bottom:6px; display:flex; flex-wrap:wrap; gap:10px; align-items:baseline; }
.trace-sub-kind { font-size:12.5px; font-weight:600; color: var(--cr-brand-500,#5b8def); }
.trace-sub .muted { font-size:12px; color: var(--cr-fg-3,#6b7280); }
.trace-sub-desc { flex-basis:100%; font-size:12px; color: var(--cr-fg-2,#aab1bd); }
`;
