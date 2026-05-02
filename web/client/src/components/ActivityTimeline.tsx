/**
 * Activity Timeline — chronological view of file edits across recent
 * Claude Code sessions. Sourced from a live transcript scan so the
 * currently-running session shows up immediately.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Card, Chip, Input, Button, SegmentedControl, ToolBadge } from './primitives';
import { getEditsTimeline, type EditRow, type EditOp, type AiTool } from '../services/api';

interface Props {
  onSessionClick?: (sessionId: string) => void;
}

const PRESETS = [
  { label: '1h',  value: 1 },
  { label: '6h',  value: 6 },
  { label: '24h', value: 24 },
  { label: '7d',  value: 24 * 7 },
];

const OP_LABELS: Record<EditOp, string> = {
  edit: 'Edit',
  write: 'Write',
  multi_edit: 'MultiEdit',
  notebook_edit: 'NotebookEdit',
  read: 'Read',
};

const OP_TONE: Record<EditOp, 'ok' | 'info' | 'warn' | 'neutral'> = {
  write: 'ok',
  edit: 'info',
  multi_edit: 'info',
  notebook_edit: 'info',
  read: 'neutral',
};

function formatTs(iso: string | undefined, ms: number): string {
  const d = iso ? new Date(iso) : new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  // Local time, "MM-DD HH:MM:SS" — short and unambiguous.
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function shortFile(file: string): string {
  // Strip $HOME-ish prefixes for readability while keeping the structure.
  const home = '/home/';
  if (file.startsWith(home)) {
    const rest = file.slice(home.length);
    const slash = rest.indexOf('/');
    if (slash > 0) return '~' + rest.slice(slash);
  }
  return file;
}

const ALL_TOOLS: AiTool[] = ['claude', 'gemini', 'opencode', 'codex'];

type ToolFilter = 'all' | AiTool;
type GroupBy = 'session' | 'repo';

export default function ActivityTimeline({ onSessionClick }: Props) {
  const [sinceHours, setSinceHours] = useState<number>(24);
  const [pattern, setPattern] = useState('');
  const [includeReads, setIncludeReads] = useState(false);
  const [toolFilter, setToolFilter] = useState<ToolFilter>('all');
  const [edits, setEdits] = useState<EditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [byTool, setByTool] = useState<Partial<Record<AiTool, number>>>({});
  const [byRepo, setByRepo] = useState<Record<string, { name: string; count: number; sample: string }>>({});
  const [groupBy, setGroupBy] = useState<GroupBy>('session');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Radio-style: 'all' = no filter, otherwise restrict to that one tool.
    const tools = toolFilter === 'all' ? undefined : [toolFilter];
    getEditsTimeline({
      sinceHours,
      pattern: pattern.trim() || undefined,
      includeReads,
      limit: 500,
      groupByRepo: groupBy === 'repo',
      tools,
    })
      .then((res) => {
        if (cancelled) return;
        setEdits(res.edits);
        setTotal(res.total);
        setTruncated(res.truncated);
        setByTool(res.byTool || {});
        setByRepo(res.byRepo || {});
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setEdits([]);
        setTotal(0);
        setTruncated(false);
        setByTool({});
        setByRepo({});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sinceHours, pattern, includeReads, toolFilter, groupBy]);

  const grouped = useMemo(() => {
    const out: { sessionId: string; project: string; latest: number; tool: AiTool; rows: EditRow[] }[] = [];
    const idx = new Map<string, number>();
    for (const e of edits) {
      const key = e.sessionId;
      if (!idx.has(key)) {
        idx.set(key, out.length);
        out.push({ sessionId: e.sessionId, project: e.projectPath, latest: e.ts, tool: e.tool, rows: [] });
      }
      const slot = out[idx.get(key)!];
      slot.rows.push(e);
      if (e.ts > slot.latest) slot.latest = e.ts;
    }
    out.sort((a, b) => b.latest - a.latest);
    return out;
  }, [edits]);

  const groupedByRepo = useMemo(() => {
    if (groupBy !== 'repo') return [];
    const out: { repo: string; name: string; latest: number; rows: EditRow[] }[] = [];
    const idx = new Map<string, number>();
    for (const e of edits) {
      const repo = e.repoRoot || '__no_repo__';
      if (!idx.has(repo)) {
        idx.set(repo, out.length);
        out.push({
          repo,
          name: e.repoName || (repo === '__no_repo__' ? '(no repo)' : repo.split('/').pop() || repo),
          latest: e.ts,
          rows: [],
        });
      }
      const slot = out[idx.get(repo)!];
      slot.rows.push(e);
      if (e.ts > slot.latest) slot.latest = e.ts;
    }
    out.sort((a, b) => b.rows.length - a.rows.length);
    return out;
  }, [edits, groupBy]);

  const distinctSessions = grouped.length;
  const distinctFiles = useMemo(() => new Set(edits.map(e => e.file)).size, [edits]);
  const distinctRepos = Object.keys(byRepo).length;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--cr-fg-1)' }}>
          Activity Timeline
        </h2>
        <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
          live transcript scan — includes the active session
        </span>
      </div>

      {/* Row 1: Tool filter — radio-style, same pattern as Memory / Toolkit / Insights. */}
      <Card style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>Tool</span>
          {(['all', ...ALL_TOOLS] as ToolFilter[]).map(t => {
            const on = toolFilter === t;
            const count = t === 'all'
              ? Object.values(byTool).reduce<number>((a, b) => a + (b || 0), 0)
              : (byTool[t] ?? 0);
            const label = t === 'all' ? 'All'
              : t === 'claude' ? 'Claude'
              : t === 'gemini' ? 'Gemini'
              : t === 'opencode' ? 'OpenCode'
              : 'Codex';
            return (
              <button
                key={t}
                onClick={() => setToolFilter(t)}
                style={{
                  height: 28,
                  padding: '0 12px',
                  background: on ? 'var(--cr-ink-3)' : 'var(--cr-ink-2)',
                  border: `1px solid ${on ? 'var(--cr-line-2)' : 'var(--cr-line-1)'}`,
                  borderRadius: 'var(--cr-radius-sm)',
                  color: on ? 'var(--cr-fg-1)' : 'var(--cr-fg-2)',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: on ? 500 : 400,
                  transition: 'background var(--cr-dur-fast)',
                }}
              >
                {t !== 'all' && <ToolBadge tool={t} size="sm" />}
                {t === 'all' && <span>{label}</span>}
                <span style={{ fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)', color: 'var(--cr-fg-3)', fontSize: 11 }}>{count}</span>
              </button>
            );
          })}
        </div>
      </Card>

      {/* Row 2: Secondary controls (window / pattern / include-reads / reset). */}
      <Card style={{ padding: 14, marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>Window</span>
            <SegmentedControl
              options={PRESETS.map(p => ({ value: String(p.value), label: p.label }))}
              value={String(sinceHours)}
              onChange={(v) => setSinceHours(Number(v))}
              size="sm"
            />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="Filter by file path substring (e.g. src/core)"
              onClear={pattern ? () => setPattern('') : undefined}
              inputSize="sm"
            />
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--cr-fg-2)' }}>
            <input
              type="checkbox"
              checked={includeReads}
              onChange={(e) => setIncludeReads(e.target.checked)}
            />
            Include reads
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>Group by</span>
            <SegmentedControl
              options={[
                { value: 'session', label: 'Session' },
                { value: 'repo',    label: 'Repo' },
              ]}
              value={groupBy}
              onChange={(v) => setGroupBy(v as GroupBy)}
              size="sm"
            />
          </div>
          <Button size="sm" variant="ghost" onClick={() => { setPattern(''); setIncludeReads(false); setSinceHours(24); setToolFilter('all'); setGroupBy('session'); }}>
            Reset
          </Button>
        </div>
      </Card>

      <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <Chip kind="info">{total} edit{total === 1 ? '' : 's'}</Chip>
        <Chip kind="neutral">{distinctSessions} session{distinctSessions === 1 ? '' : 's'}</Chip>
        <Chip kind="neutral">{distinctFiles} file{distinctFiles === 1 ? '' : 's'}</Chip>
        {groupBy === 'repo' && distinctRepos > 0 && (
          <Chip kind="brand">{distinctRepos} repo{distinctRepos === 1 ? '' : 's'}</Chip>
        )}
        {truncated && <Chip kind="warn">truncated — narrow filter to see more</Chip>}
      </div>

      {error && (
        <Card style={{ padding: 12, marginBottom: 12, borderColor: 'var(--cr-err-500)' }}>
          <span style={{ color: 'var(--cr-err-500)' }}>Error: {error}</span>
        </Card>
      )}

      {loading && (
        <div style={{ color: 'var(--cr-fg-3)', fontSize: 13, padding: 16 }}>Scanning transcripts…</div>
      )}

      {!loading && grouped.length === 0 && !error && (
        <div style={{ color: 'var(--cr-fg-3)', fontSize: 13, padding: 16 }}>
          No edits in the last {sinceHours}h{pattern ? ` matching "${pattern}"` : ''}.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {groupBy === 'session' && grouped.map((g) => (
          <Card key={g.sessionId} style={{ padding: 12 }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
              gap: 8,
              flexWrap: 'wrap',
            }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <ToolBadge tool={g.tool} size="sm" />
                <button
                  onClick={() => onSessionClick?.(g.sessionId)}
                  style={{
                    background: 'transparent',
                    border: 0,
                    padding: 0,
                    color: 'var(--cr-brand-500)',
                    fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)',
                    fontSize: 12,
                    cursor: onSessionClick ? 'pointer' : 'default',
                    textDecoration: onSessionClick ? 'underline' : 'none',
                  }}
                  title={g.sessionId}
                >
                  {g.sessionId.replace(/^(opencode_|gemini_|codex_)/, '').slice(0, 8)}
                </button>
                <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>{g.project}</span>
              </div>
              <Chip kind="neutral" size="sm">{g.rows.length} edit{g.rows.length === 1 ? '' : 's'}</Chip>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <tbody>
                {g.rows.map((e, i) => (
                  <tr key={`${e.sessionId}-${e.line}-${i}`} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--cr-line-1)' }}>
                    <td style={{ padding: '6px 8px 6px 0', color: 'var(--cr-fg-3)', whiteSpace: 'nowrap', fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)' }}>
                      {formatTs(e.tsIso, e.ts)}
                    </td>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                      <Chip kind={OP_TONE[e.op]} size="sm">{OP_LABELS[e.op]}</Chip>
                    </td>
                    <td style={{ padding: '6px 0', color: 'var(--cr-fg-1)', fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)', wordBreak: 'break-all' }}>
                      {shortFile(e.file)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))}

        {groupBy === 'repo' && groupedByRepo.map((g) => (
          <Card key={g.repo} style={{ padding: 12 }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
              gap: 8,
              flexWrap: 'wrap',
            }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--cr-fg-1)' }}>{g.name}</span>
                {g.repo !== '__no_repo__' && (
                  <span style={{ fontSize: 11, color: 'var(--cr-fg-3)', fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)' }}>{g.repo}</span>
                )}
              </div>
              <Chip kind="neutral" size="sm">{g.rows.length} edit{g.rows.length === 1 ? '' : 's'}</Chip>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <tbody>
                {g.rows.map((e, i) => (
                  <tr key={`${e.sessionId}-${e.line}-${i}`} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--cr-line-1)' }}>
                    <td style={{ padding: '6px 8px 6px 0', color: 'var(--cr-fg-3)', whiteSpace: 'nowrap', fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)' }}>
                      {formatTs(e.tsIso, e.ts)}
                    </td>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                      <ToolBadge tool={e.tool} size="sm" />
                    </td>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                      <button
                        onClick={() => onSessionClick?.(e.sessionId)}
                        style={{
                          background: 'transparent', border: 0, padding: 0,
                          color: 'var(--cr-brand-500)',
                          fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)',
                          fontSize: 11,
                          cursor: onSessionClick ? 'pointer' : 'default',
                        }}
                        title={e.sessionId}
                      >
                        {e.sessionId.replace(/^(opencode_|gemini_|codex_)/, '').slice(0, 8)}
                      </button>
                    </td>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                      <Chip kind={OP_TONE[e.op]} size="sm">{OP_LABELS[e.op]}</Chip>
                    </td>
                    <td style={{ padding: '6px 0', color: 'var(--cr-fg-1)', fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)', wordBreak: 'break-all' }}>
                      {g.repo !== '__no_repo__' && e.file.startsWith(g.repo + '/')
                        ? e.file.slice(g.repo.length + 1)
                        : shortFile(e.file)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))}
      </div>
    </div>
  );
}
