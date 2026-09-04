/**
 * Activity — the "work rhythm" view. Not a raw edit-op log (that read like
 * syslog and answered a question nobody asked); instead it answers "where did
 * my effort go, what's hot, am I shipping or thrashing?" from data we already
 * compute: the edits timeline + per-session diff/outcome, aggregated server-side
 * by /api/edits/summary.
 *
 * Sections: pulse heatmap (intensity over the window) · totals · by-project
 * churn (files, ±lines, sessions, sparkline, outcome mix, hot files) · global
 * hottest files · titled session rows (click → the session's Changes tab).
 *
 * Visuals follow the dataviz method with the app's own cr-* tokens as the
 * palette: sequential brand hue for magnitude (heatmap/sparkline), status
 * colors WITH labels for outcomes (never color-alone), green/red for ±lines.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Card, Chip, ToolBadge, Schedule, Metrics, Plate } from './primitives';
import { getActivitySummary, type ActivitySummaryResponse, type AiTool } from '../services/api';
import { VALID_TOOL_FILTERS } from '../services/tools';
import { useSidebarExtrasRegister } from '../context/sidebar-extras';
import { isCloud } from '../services/auth';

interface Props {
  onSessionClick?: (sessionId: string) => void;
  toolFilter?: string;
  projectFilter?: string | null;
  onActiveProjects?: (byProject: Record<string, number>) => void;
}

const PRESETS = [
  { label: '24h', value: 24 },
  { label: '7d', value: 24 * 7 },
  { label: '30d', value: 24 * 30 },
  { label: '90d', value: 24 * 90 },
];

const OUTCOME_META: Record<string, { label: string; kind: 'ok' | 'warn' | 'err' | 'neutral' }> = {
  shipped: { label: 'shipped', kind: 'ok' },
  interrupted: { label: 'interrupted', kind: 'warn' },
  abandoned: { label: 'abandoned', kind: 'err' },
  inProgress: { label: 'in progress', kind: 'neutral' },
  in_progress: { label: 'in progress', kind: 'neutral' },
};
const OUTCOME_COLOR: Record<string, string> = {
  shipped: 'var(--cr-ok-500)',
  interrupted: 'var(--cr-warn-500)',
  abandoned: 'var(--cr-err-500)',
  inProgress: 'var(--cr-fg-3)',
};

function fmtLines(added: number, removed: number): React.ReactNode {
  return (
    <span style={{ fontFamily: 'var(--cr-font-annot)', fontSize: 12 }}>
      <span style={{ color: 'var(--cr-ok-500)' }}>+{added.toLocaleString()}</span>
      <span style={{ color: 'var(--cr-fg-3)' }}> / </span>
      <span style={{ color: 'var(--cr-err-500)' }}>−{removed.toLocaleString()}</span>
    </span>
  );
}

function base(file: string): string { return file.split('/').filter(Boolean).pop() || file; }

function bucketLabel(ms: number, hourly: boolean): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hourly ? `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:00`
    : `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

/** Sequential magnitude heatmap — one hue (brand), intensity by edits/max. */
function Pulse({ pulse, hourly }: { pulse: ActivitySummaryResponse['pulse']; hourly: boolean }) {
  const max = Math.max(1, ...pulse.map(p => p.edits));
  return (
    <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      {pulse.map((p) => {
        const t = p.edits / max; // 0..1 intensity
        const bg = p.edits === 0 ? 'var(--cr-ink-2)' : `color-mix(in srgb, var(--cr-brand-500) ${Math.round(18 + t * 82)}%, transparent)`;
        return (
          <div
            key={p.bucket}
            title={`${bucketLabel(p.bucket, hourly)} · ${p.edits} edit${p.edits === 1 ? '' : 's'} · ${p.sessions} session${p.sessions === 1 ? '' : 's'}`}
            style={{ width: 16, height: 34, borderRadius: 0, background: bg, border: '1px solid var(--cr-line-1)', flex: '0 0 auto' }}
          />
        );
      })}
    </div>
  );
}

/** Single-series sparkline (change over time) — brand hue, no legend. */
function Sparkline({ data, w = 96, h = 22 }: { data: number[]; w?: number; h?: number }) {
  if (!data.length) return null;
  const max = Math.max(1, ...data);
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block' }} aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--cr-brand-500)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Outcome mix as a thin stacked bar — status colors, with a labeled legend. */
function OutcomeBar({ o }: { o: ActivitySummaryResponse['totals'] }) {
  const parts: Array<[keyof typeof OUTCOME_COLOR, number]> = [
    ['shipped', o.shipped], ['interrupted', o.interrupted], ['abandoned', o.abandoned], ['inProgress', o.inProgress],
  ];
  const total = parts.reduce((s, [, n]) => s + n, 0);
  if (total === 0) return null;
  return (
    <div style={{ display: 'flex', height: 6, borderRadius: 0, overflow: 'hidden', gap: 1, background: 'var(--cr-ink-2)' }}>
      {parts.filter(([, n]) => n > 0).map(([k, n]) => (
        <div key={k} title={`${OUTCOME_META[k].label}: ${n}`} style={{ width: `${(n / total) * 100}%`, background: OUTCOME_COLOR[k] }} />
      ))}
    </div>
  );
}

function StatTile({ value, label, sub }: { value: React.ReactNode; label: string; sub?: React.ReactNode }) {
  return (
    <div style={{ padding: '10px 14px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)', borderRadius: 0, minWidth: 96 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--cr-fg-1)', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      {sub && <div style={{ marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

export default function ActivityTimeline({ onSessionClick, toolFilter: toolFilterProp = 'all', projectFilter = null, onActiveProjects }: Props) {
  const [sinceHours, setSinceHours] = useState<number>(24 * 7);
  const toolFilter = VALID_TOOL_FILTERS.has(toolFilterProp as string) ? (toolFilterProp as string) : 'all';
  const [data, setData] = useState<ActivitySummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const tools = toolFilter === 'all' ? undefined : ([toolFilter] as AiTool[]);
    getActivitySummary({ sinceHours, project: projectFilter || undefined, tools })
      .then((res) => {
        if (cancelled) return;
        setData(res);
        if (onActiveProjects) onActiveProjects(Object.fromEntries(res.projects.map(p => [p.id, p.sessions])));
      })
      .catch((e: Error) => { if (!cancelled) { setError(e.message); setData(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sinceHours, toolFilter, projectFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useSidebarExtrasRegister(() => ([{
    heading: 'Window',
    rows: PRESETS.map(p => ({
      id: `activity-window-${p.value}`, label: p.label, on: sinceHours === p.value,
      onClick: () => setSinceHours(p.value), testId: `activity-window-${p.value}`,
    })),
  }]), [sinceHours]);

  const hourly = sinceHours <= 48;
  const t = data?.totals;
  const hasData = !!data && (data.projects.length > 0 || data.sessions.length > 0);

  return (
    <div className="cr-page-pad" style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
      <div className="cr-page-header-row" style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--cr-fg-1)' }}>Activity</h2>
        <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
          {isCloud() ? 'what you worked on, and how much' : 'what you worked on — includes the live session'}
        </span>
      </div>

      {loading && !data && <Card style={{ padding: 20, color: 'var(--cr-fg-3)' }}>Loading activity…</Card>}
      {error && <Card style={{ padding: 12, marginTop: 12, borderColor: 'var(--cr-err-500)' }}><span style={{ color: 'var(--cr-err-500)' }}>Error: {error}</span></Card>}

      {data && !hasData && !loading && (
        <Card style={{ padding: 20, color: 'var(--cr-fg-3)', marginTop: 12 }}>
          No changes in this window. Widen it, or clear the project/tool filter.
        </Card>
      )}

      {data && hasData && t && (
        <>
          {/* Pulse + totals */}
          {/* The pulse chart, then its totals as a schedule. The four boxes were
              a stat-tile row on --cr-ink-2 — the template AND a second raised
              ground — and "PULSE · HOURLY" above them was an eyebrow, so it is
              the plate's own name now. */}
          <Plate
            style={{ marginTop: 12 }}
            title={<>Pulse <span style={{ color: 'var(--cr-fg-3)', fontWeight: 400, fontSize: 12.5 }}>{hourly ? 'hourly' : 'daily'}</span></>}
          >
            <Pulse pulse={data.pulse} hourly={hourly} />
          </Plate>
          <Metrics
            
            items={[
              { label: 'Sessions', value: String(t.sessions) },
              { label: 'Files touched', value: String(t.files) },
              { label: 'Lines changed', value: fmtLines(t.linesAdded, t.linesRemoved) },
              { label: 'Shipped', value: String(t.shipped), tone: 'ok', sub: `${t.interrupted} interrupted, ${t.abandoned} abandoned, ${t.inProgress} in progress` },
            ]}
          />

          {/* By project */}
          {data.projects.length > 0 && (
            /* A card grid of per-project boxes becomes one schedule. Each box
               held a name, a sparkline, three counts and a chip row — that is a
               row of comparable data, and in a schedule the counts line up into
               columns you can read down. The "BY PROJECT" label above it was an
               eyebrow; the schedule's caption names it. */
            <Schedule
              scroll
              style={{ marginBottom: 18 }}
              caption="By project"
              cols={[
                { key: 'name', kind: 'pn', head: 'Project' },
                { key: 'trend', head: 'Trend', optional: true },
                { key: 'files', kind: 'val', head: 'Files' },
                { key: 'lines', kind: 'rt', head: 'Lines', optional: true },
                { key: 'sessions', kind: 'val', head: 'Sessions' },
                { key: 'outcomes', head: 'Outcomes', optional: true },
              ]}
              rows={data.projects.map((p) => ({
                id: p.id,
                cells: {
                  name: (
                    <>
                      <span style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{p.name}</span>
                      {p.hotFiles.length > 0 && (
                        <span className="pn-sub">
                          hot: {p.hotFiles.map((h) => `${base(h.file)} ×${h.edits}`).join(', ')}
                        </span>
                      )}
                    </>
                  ),
                  trend: <Sparkline data={p.sparkline} />,
                  files: p.files,
                  lines: fmtLines(p.linesAdded, p.linesRemoved),
                  sessions: p.sessions,
                  outcomes: <OutcomeBar o={{ ...p.outcomes, sessions: p.sessions, files: p.files, linesAdded: p.linesAdded, linesRemoved: p.linesRemoved }} />,
                },
              }))}
            />
          )}

          {/* Hottest files */}
          {data.hotFiles.length > 0 && (
            <Card style={{ padding: 14, marginBottom: 18 }}>
              <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Hottest files</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {data.hotFiles.map((h) => (
                  <div key={`${h.project}-${h.file}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, padding: '3px 0', borderTop: '1px solid var(--cr-line-1)' }}>
                    <span style={{ fontFamily: 'var(--cr-font-annot)', color: 'var(--cr-fg-1)', wordBreak: 'break-all' }} title={h.file}>{base(h.file)}</span>
                    <span style={{ display: 'flex', gap: 10, whiteSpace: 'nowrap', color: 'var(--cr-fg-3)' }}>
                      <span>{h.project}</span><span style={{ color: 'var(--cr-brand-500)', fontWeight: 600 }}>{h.edits} edits</span>
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Sessions — narrative rows */}
          {data.sessions.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 4px 8px' }}>Sessions</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {data.sessions.map((s) => {
                  const om = OUTCOME_META[s.outcome] || OUTCOME_META.in_progress;
                  return (
                    <Card
                      key={s.id}
                      style={{ padding: '10px 14px', cursor: onSessionClick ? 'pointer' : 'default' }}
                      onClick={() => onSessionClick?.(s.id)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <Chip kind={om.kind} size="sm">{om.label}</Chip>
                        <ToolBadge tool={s.tool} size="sm" />
                        <span style={{ flex: 1, minWidth: 160, fontSize: 13, color: 'var(--cr-fg-1)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.title || <span style={{ color: 'var(--cr-fg-3)', fontStyle: 'italic' }}>(untitled session)</span>}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--cr-fg-3)', whiteSpace: 'nowrap' }}>{s.files} file{s.files === 1 ? '' : 's'}</span>
                        {(s.linesAdded > 0 || s.linesRemoved > 0) && fmtLines(s.linesAdded, s.linesRemoved)}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
