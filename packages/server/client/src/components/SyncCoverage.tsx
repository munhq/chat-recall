/**
 * Sync coverage — "what does this server actually hold?" in one card.
 *
 * The trust question every synced user asks: which conversations made it,
 * from which AI tools, which projects, which memory types, and did code
 * intelligence index anything. All of it already exists server-side
 * (/api/memory/status, /api/status, code projects) — this card just makes
 * it visible instead of leaving users to infer coverage from search results.
 */
import React, { useEffect, useState } from 'react';
import { Chip } from './primitives';
import {
  getMemoryStatus, getStatus, getCodeProjects,
  type MemoryStatus, type CodeProject,
} from '../services/api';

const TOOL_LABELS: Record<string, string> = {
  claude: 'Claude Code', gemini: 'Gemini CLI', opencode: 'OpenCode', codex: 'Codex', agy: 'Antigravity', cursor: 'Cursor',
};

/** Order + labels for the source types worth surfacing (rest fold into "other"). */
const TYPE_LABELS: Array<[string, string]> = [
  ['session', 'Conversations'], ['plan', 'Plans'], ['task', 'Tasks'],
  ['skill', 'Skills'], ['claude_md', 'Instructions'], ['history', 'History'],
  ['paste', 'Pastes'], ['diary', 'Diaries'], ['mcp', 'MCPs'],
  ['command', 'Commands'], ['agent', 'Subagents'], ['hook', 'Hooks'], ['plugin', 'Plugins'],
];

function shortProject(p: string): string {
  return p.replace(/\/+$/, '').split('/').filter(Boolean).slice(-1)[0] || p;
}

export default function SyncCoverage({ onOpenProject }: { onOpenProject?: (project: string) => void }) {
  const [memory, setMemory] = useState<MemoryStatus | null>(null);
  const [projects, setProjects] = useState<Record<string, number>>({});
  const [code, setCode] = useState<CodeProject[]>([]);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let on = true;
    Promise.allSettled([getMemoryStatus(), getStatus(), getCodeProjects()]).then(([m, s, c]) => {
      if (!on) return;
      if (m.status === 'fulfilled') setMemory(m.value);
      if (s.status === 'fulfilled') setProjects((s.value as any).projects || {});
      if (c.status === 'fulfilled') setCode(c.value);
      if (m.status === 'rejected' && s.status === 'rejected') setErr(true);
    });
    return () => { on = false; };
  }, []);

  if (err) return <div style={{ color: 'var(--cr-fg-3)', fontSize: 13 }}>Coverage unavailable.</div>;
  if (!memory) return <div style={{ color: 'var(--cr-fg-3)', fontSize: 13 }}>Loading coverage…</div>;

  const sessionsByTool = Object.entries(memory.bySourceAndTool?.session || {})
    .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const byType = TYPE_LABELS
    .map(([key, label]) => ({ key, label, items: memory.bySourceType[key]?.items || 0 }))
    .filter((t) => t.items > 0);
  const topProjects = Object.entries(projects).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const row: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 };
  const cap: React.CSSProperties = { fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cr-fg-3)', marginTop: 14 };

  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ ...cap, marginTop: 0 }}>Conversations by AI tool</div>
      <div style={row}>
        {sessionsByTool.length === 0 && <span style={{ color: 'var(--cr-fg-3)' }}>none yet</span>}
        {sessionsByTool.map(([tool, n]) => (
          <Chip key={tool} size="sm">{TOOL_LABELS[tool] || tool} · {n.toLocaleString()}</Chip>
        ))}
      </div>

      <div style={cap}>Memory types</div>
      <div style={row}>
        {byType.map((t) => <Chip key={t.key} size="sm">{t.label} · {t.items.toLocaleString()}</Chip>)}
      </div>

      {topProjects.length > 0 && (
        <>
          <div style={cap}>Top projects</div>
          <div style={row}>
            {topProjects.map(([p, n]) => (
              <span
                key={p}
                title={p}
                onClick={onOpenProject ? () => onOpenProject(p) : undefined}
                style={onOpenProject ? { cursor: 'pointer' } : undefined}
              >
                <Chip size="sm">{shortProject(p)} · {n.toLocaleString()}</Chip>
              </span>
            ))}
          </div>
        </>
      )}

      <div style={cap}>Code intelligence</div>
      <div style={row}>
        {code.length === 0
          ? <span style={{ color: 'var(--cr-fg-3)' }}>no code indexed</span>
          : code.slice(0, 6).map((c) => (
            <span key={c.projectId} title={c.rootPath}>
              <Chip size="sm">{c.label || shortProject(c.rootPath || c.projectId)} · {c.fileCount.toLocaleString()} files</Chip>
            </span>
          ))}
        {code.length > 6 && <Chip size="sm">+{code.length - 6} more</Chip>}
      </div>
    </div>
  );
}
