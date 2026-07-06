/**
 * Activity Timeline — chronological view of file edits across recent
 * Claude Code sessions. Sourced from a live transcript scan so the
 * currently-running session shows up immediately.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Card, Chip, Input, Button, SegmentedControl, ToolBadge } from './primitives';
import { getEditsTimeline, type EditRow, type EditOp, type AiTool } from '../services/api';
import { TOOL_IDS, VALID_TOOL_FILTERS, stripToolPrefix } from '../services/tools';
import { useSidebarExtrasRegister } from '../context/sidebar-extras';
import { isCloud } from '../services/auth';

interface Props {
  onSessionClick?: (sessionId: string) => void;
  /** Source filter from the global Sidebar. */
  toolFilter?: string;
  /** Project filter from the global Sidebar. */
  projectFilter?: string | null;
  /**
   * Optional: report the projects that have edits in the current window
   * back to the parent so it can rebuild the Sidebar tree to show only
   * active projects (not the stale all-time list from getStatus).
   */
  onActiveProjects?: (byProject: Record<string, number>) => void;
}

const PRESETS = [
  { label: '1h',  value: 1 },
  { label: '6h',  value: 6 },
  { label: '24h', value: 24 },
  { label: '7d',  value: 24 * 7 },
  { label: '30d', value: 24 * 30 },
  { label: '90d', value: 24 * 90 },
  { label: '1y',  value: 24 * 365 },
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
  const ageMs = Date.now() - d.getTime();
  const min = Math.round(ageMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  // Older than a day → calendar form, "MM-DD HH:MM" without seconds.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Bucket a timestamp to a stable label for day-grouping headers.
 * Returns "Today", "Yesterday", or "Mon Jul 14".
 */
function dayBucket(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayMs = 86400_000;
  const diffDays = Math.round((startOf(now) - startOf(d)) / dayMs);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function splitFilePath(file: string): { dir: string; base: string } {
  // Strip $HOME-ish prefix to "~/…" for readability, then split into
  // (dir, basename) so the UI can render the basename emphasized.
  let displayed = file;
  const home = '/home/';
  if (file.startsWith(home)) {
    const rest = file.slice(home.length);
    const slash = rest.indexOf('/');
    if (slash > 0) displayed = '~' + rest.slice(slash);
  }
  const i = displayed.lastIndexOf('/');
  if (i < 0) return { dir: '', base: displayed };
  return { dir: displayed.slice(0, i + 1), base: displayed.slice(i + 1) };
}

function shortFile(file: string): string {
  const { dir, base } = splitFilePath(file);
  return dir + base;
}

const ALL_TOOLS: AiTool[] = TOOL_IDS as unknown as AiTool[];

type ToolFilter = 'all' | AiTool;
type GroupBy = 'session' | 'repo';

export default function ActivityTimeline({ onSessionClick, toolFilter: toolFilterProp = 'all', projectFilter = null, onActiveProjects }: Props) {
  const [sinceHours, setSinceHours] = useState<number>(24);
  const [pattern, setPattern] = useState('');
  const [includeReads, setIncludeReads] = useState(false);
  // Sidebar drives the source filter. Coerce unknown strings to 'all'.
  const toolFilter: ToolFilter = VALID_TOOL_FILTERS.has(toolFilterProp as string)
    ? (toolFilterProp as ToolFilter)
    : 'all';
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
      project: projectFilter || undefined,
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
        // Report active projects up so the global Sidebar tree can
        // re-render with only the projects relevant to this window.
        if (onActiveProjects) onActiveProjects(res.byProject || {});
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
  }, [sinceHours, pattern, includeReads, toolFilter, groupBy, projectFilter]);

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

  // Time-window selector → Sidebar.
  useSidebarExtrasRegister(() => ([{
    heading: 'Window',
    rows: PRESETS.map(p => ({
      id: `activity-window-${p.value}`,
      label: p.label,
      on: sinceHours === p.value,
      onClick: () => setSinceHours(p.value),
      testId: `activity-window-${p.value}`,
    })),
  }]), [sinceHours]);

  return (
    <div className="cr-page-pad" style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
      <div className="cr-page-header-row" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--cr-fg-1)' }}>
          Activity Timeline
        </h2>
        <span className="cr-page-header-lead" style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
          {isCloud()
            ? 'file edits across your synced sessions'
            : 'live transcript scan — includes the active session'}
        </span>
      </div>

      {/* Tool filter and Window live in the global Sidebar. The
          remaining controls (search by path, include-reads, group-by)
          stay here since they're activity-specific. */}
      <Card style={{ padding: 14, marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
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
          <Button size="sm" variant="ghost" onClick={() => { setPattern(''); setIncludeReads(false); setSinceHours(24); setGroupBy('session'); }}>
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
        <div style={{ color: 'var(--cr-fg-3)', fontSize: 13, padding: 16, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <span>No edits in the last {sinceHours >= 24 ? `${Math.round(sinceHours / 24)}d` : `${sinceHours}h`}{pattern ? ` matching "${pattern}"` : ''}. Synced data may be older.</span>
          {sinceHours < 24 * 365 && (
            <button
              onClick={() => setSinceHours(24 * 365)}
              style={{ padding: '5px 12px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-2)', borderRadius: 'var(--cr-radius-sm)', color: 'var(--cr-fg-1)', cursor: 'pointer', fontSize: 12 }}
            >
              Widen to 1 year →
            </button>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {groupBy === 'session' && grouped.map((g, gi) => {
          const bucket = dayBucket(g.latest);
          const prevBucket = gi > 0 ? dayBucket(grouped[gi - 1].latest) : null;
          const showDayHeader = bucket !== prevBucket;
          return (
          <React.Fragment key={g.sessionId}>
          {showDayHeader && (
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: 'var(--cr-fg-3)',
              padding: '12px 4px 2px',
              borderBottom: '1px solid var(--cr-line-1)',
              marginTop: gi > 0 ? 6 : 0,
            }}>
              {bucket}
            </div>
          )}
          <Card style={{ padding: 12 }}>
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
                  {stripToolPrefix(g.sessionId).slice(0, 8)}
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
                    <td style={{ padding: '6px 0', fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)', wordBreak: 'break-all' }}>
                      {(() => { const { dir, base } = splitFilePath(e.file); return (
                        <>
                          <span style={{ color: 'var(--cr-fg-3)' }}>{dir}</span>
                          <span style={{ color: 'var(--cr-fg-1)', fontWeight: 600 }}>{base}</span>
                        </>
                      ); })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          </React.Fragment>
          );
        })}

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
                    <td style={{ padding: '6px 0', fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)', wordBreak: 'break-all' }}>
                      {(() => {
                        const display = g.repo !== '__no_repo__' && e.file.startsWith(g.repo + '/')
                          ? e.file.slice(g.repo.length + 1)
                          : shortFile(e.file);
                        const i = display.lastIndexOf('/');
                        const dir = i >= 0 ? display.slice(0, i + 1) : '';
                        const base = i >= 0 ? display.slice(i + 1) : display;
                        return (
                          <>
                            <span style={{ color: 'var(--cr-fg-3)' }}>{dir}</span>
                            <span style={{ color: 'var(--cr-fg-1)', fontWeight: 600 }}>{base}</span>
                          </>
                        );
                      })()}
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
