import React, { useState, useEffect } from 'react';
import { Icon, Chip, MetricCard, Card, Avatar, IconButton } from './primitives';
import { getAnalytics, getPatterns, type AnalyticsData, type PatternsResponse } from '../services/api';

type InsightsToolFilter = 'all' | 'claude' | 'gemini' | 'opencode' | 'codex';

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function fmtSignedDelta(n: number, unit: string): string {
  if (n === 0) return `No change ${unit}`;
  return `${n > 0 ? '+' : ''}${n.toLocaleString()} ${unit}`;
}

function fmtDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const m = mins % 60;
  if (hours < 24) return m > 0 ? `${hours}h ${m}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `${days}d ${h}h` : `${days}d`;
}

function fmtCost(n: number): string {
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

function cleanDesc(d: string): string {
  return d
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*[-:]\s*/, '')
    .trim();
}

interface DashboardProps {
  /** Switch to the conversation list with this session selected. */
  onJumpToSession?: (sessionId: string) => void;
  /** Switch to search view with this query pre-filled. */
  onJumpToSearch?: (query: string) => void;
  /** Source filter from the global Sidebar (passed-through; Insights
      currently shows all-tool stats but the prop is here so the App
      doesn't have to special-case the view). */
  toolFilter?: string;
}

export default function Dashboard({ onJumpToSession, onJumpToSearch, toolFilter: toolFilterProp = 'all' }: DashboardProps = {}) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [patterns, setPatterns] = useState<PatternsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Sidebar drives the source filter — coerce unknown strings to 'all'.
  const toolFilter: InsightsToolFilter = (['all', 'claude', 'gemini', 'opencode', 'codex'] as const).includes(toolFilterProp as any)
    ? (toolFilterProp as InsightsToolFilter)
    : 'all';

  const load = (tool: InsightsToolFilter) => {
    setLoading(true);
    setError(null);
    getAnalytics(tool)
      .then(setData)
      .catch((err) => setError(err.message || 'Failed to load analytics'))
      .finally(() => setLoading(false));
    // Patterns are global (not yet tool-filterable); load once on mount.
    if (tool === 'all') {
      getPatterns().then(setPatterns).catch(() => { /* tolerate */ });
    }
  };

  useEffect(() => {
    load(toolFilter);
  }, [toolFilter]);

  if (loading)
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cr-fg-3)' }}>
        Loading analytics…
      </div>
    );
  if (error || !data)
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
        <div style={{ color: 'var(--cr-err-500)' }}>{error || 'No data'}</div>
        <button onClick={() => load(toolFilter)} style={{ padding: '8px 16px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-2)', borderRadius: 'var(--cr-radius-sm)', color: 'var(--cr-fg-1)', cursor: 'pointer' }}>
          Retry
        </button>
      </div>
    );

  const { summary } = data;
  const maxDailyCost = Math.max(...data.dailyCost.map((d) => d.cost), 1);

  const costDelta =
    data.periodComparison.lastWeek.cost > 0
      ? Math.round(
          ((data.periodComparison.thisWeek.cost - data.periodComparison.lastWeek.cost) /
            data.periodComparison.lastWeek.cost) *
            100
        )
      : 0;

  const insights: string[] = [];
  if (costDelta > 100) {
    insights.push(`Cost is up ${costDelta}% vs last week — check expensive sessions below.`);
  } else if (costDelta < -20) {
    insights.push(`Cost is down ${Math.abs(costDelta)}% vs last week.`);
  }
  if (data.contextExhausted.length > 3) {
    insights.push(`${data.contextExhausted.length} sessions hit high context usage — consider splitting large tasks.`);
  }

  return (
    <div className="cr-dashboard" style={{ flex: 1, overflowY: 'auto', background: 'var(--cr-ink-0)' }}>
      <div className="cr-dashboard-inner" style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 40px 64px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h2>Insights</h2>
            <p className="cr-lead" style={{ marginTop: 4 }}>
              Where your tokens go — and what you can cut.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <IconButton icon="refresh" onClick={() => load(toolFilter)} title="Refresh analytics" />
          </div>
        </div>

        {/* Tool filter is in the Sidebar. We keep just a small status
            line here so users know which slice they're seeing. */}
        {toolFilter !== 'all' && (
          <div style={{ marginBottom: 16, fontSize: 12, color: 'var(--cr-fg-3)' }}>
            showing <strong style={{ color: 'var(--cr-fg-1)' }}>{toolFilter}</strong> only — totals reflect this tool's slice
          </div>
        )}

        {/* This-week digest card */}
        <div
          style={{
            background: 'var(--cr-ink-1)',
            border: '1px solid var(--cr-line-1)',
            borderRadius: 'var(--cr-radius-lg)',
            padding: 28,
            marginBottom: 24,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: -80,
              right: -80,
              width: 260,
              height: 260,
              background: 'radial-gradient(circle, rgba(245,169,127,0.12) 0%, transparent 60%)',
              pointerEvents: 'none',
            }}
          />
          <div style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <h3>This week</h3>
              {costDelta !== 0 && (
                <Chip kind={costDelta > 0 ? 'warn' : 'ok'} icon={costDelta > 0 ? 'arrowUp' : 'arrowDown'}>
                  {Math.abs(costDelta)}% vs last week
                </Chip>
              )}
            </div>
            <div
              className="cr-stat-grid-4"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 32, marginBottom: 20 }}
            >
              {[
                { v: String(data.periodComparison.thisWeek.sessions), l: 'Sessions', tone: 'neutral' as const },
                { v: fmtCost(data.periodComparison.thisWeek.cost), l: 'Cost', tone: 'cost' as const },
                { v: `${data.periodComparison.thisWeek.cacheRate}%`, l: 'Cache hit', tone: 'savings' as const },
                { v: fmtTokens(data.periodComparison.thisWeek.tokens), l: 'Tokens used', tone: 'neutral' as const },
              ].map((s) => (
                <div key={s.l}>
                  <div
                    style={{
                      fontSize: 32,
                      fontWeight: 600,
                      letterSpacing: '-0.025em',
                      color:
                        s.tone === 'cost'
                          ? 'var(--cr-warn-500)'
                          : s.tone === 'savings'
                          ? 'var(--cr-ok-500)'
                          : 'var(--cr-fg-1)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {s.v}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginTop: 2, fontWeight: 500 }}>{s.l}</div>
                </div>
              ))}
            </div>
            {insights.length > 0 && (
              <div
                style={{
                  padding: '12px 14px',
                  borderRadius: 'var(--cr-radius-sm)',
                  background: 'var(--cr-warn-surf)',
                  border: '1px solid var(--cr-warn-line)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: 13,
                }}
              >
                <Icon name="sparkle" size={14} style={{ color: 'var(--cr-warn-500)' }} />
                <span style={{ color: 'var(--cr-fg-1)' }}>{insights[0]}</span>
              </div>
            )}
          </div>
        </div>

        {/* Lifetime metric grid */}
        <div className="cr-stat-grid-4" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
          <MetricCard
            label="Total sessions"
            value={String(summary.totalSessions)}
            sub={fmtSignedDelta(data.periodComparison.thisWeek.sessions, 'this week')}
            icon="message"
          />
          <MetricCard
            label="Total cost"
            value={fmtCost(summary.totalCostUsd)}
            sub={
              summary.sessionsWithoutPricing > 0
                ? `${summary.sessionsWithoutPricing} session${summary.sessionsWithoutPricing === 1 ? '' : 's'} w/o pricing`
                : 'Lifetime'
            }
            tone="cost"
            icon="sparkle"
          />
          <MetricCard
            label="Compute time"
            value={fmtDuration(summary.totalDurationMin)}
            sub={`Across ${data.projects.length} project${data.projects.length === 1 ? '' : 's'}`}
            icon="clock"
          />
          <MetricCard
            label="Cache reads"
            value={`${fmtTokens(summary.totalCacheReadTokens)} tokens`}
            // Cache reads are billed at ~10% of base input on Anthropic; we don't
            // know the actual base price for non-Anthropic models, so keep this
            // a token count rather than a fabricated dollar amount.
            sub="Saved vs. re-uploading"
            tone="savings"
            icon="zap"
          />
        </div>

        {/* Cost chart */}
        {data.dailyCost.length > 0 && (
          <Card style={{ padding: 24, marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
              <h3>Daily cost</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12, color: 'var(--cr-fg-3)' }}>
                <LegendDot color="var(--cr-brand-500)" label="Normal" />
                <LegendDot color="var(--cr-warn-500)" label="Spike" />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 160, padding: '8px 0' }}>
              {data.dailyCost.map((v, i) => (
                <div
                  key={i}
                  title={`${v.day}: $${v.cost.toFixed(2)}`}
                  style={{
                    flex: 1,
                    height: `${(v.cost / maxDailyCost) * 100}%`,
                    background: v.cost > 3 ? 'var(--cr-warn-500)' : 'var(--cr-brand-500)',
                    opacity: v.cost > 3 ? 0.95 : 0.75,
                    borderRadius: '3px 3px 0 0',
                    minHeight: 2,
                    transition: 'opacity var(--cr-dur-fast)',
                  }}
                />
              ))}
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: 10,
                fontSize: 11,
                color: 'var(--cr-fg-3)',
              }}
            >
              <span>30 days ago</span>
              <span>Today</span>
            </div>
          </Card>
        )}

        {/* Two-column: tools + projects */}
        <div className="cr-stat-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Card style={{ padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
              <h3>Top tools</h3>
              <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>{data.tools.length} total</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {data.tools.slice(0, 5).map((b) => {
                const max = data.tools[0]?.sessions || 1;
                return (
                  <div key={b.tool} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span
                      style={{ fontSize: 13, color: 'var(--cr-fg-1)', fontWeight: 500, minWidth: 70 }}
                    >
                      {b.tool}
                    </span>
                    <div
                      style={{
                        flex: 1,
                        height: 8,
                        background: 'var(--cr-ink-2)',
                        borderRadius: 4,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${(b.sessions / max) * 100}%`,
                          background: 'var(--cr-brand-500)',
                          borderRadius: 4,
                        }}
                      />
                    </div>
                    <span
                      style={{
                        fontSize: 12,
                        color: 'var(--cr-fg-3)',
                        minWidth: 50,
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                        fontFamily: 'var(--cr-font-mono)',
                      }}
                    >
                      {b.sessions.toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card style={{ padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
              <h3>Top projects</h3>
              <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>{data.projects.length} total</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {data.projects
                .filter((p) => p.name.length > 1)
                .slice(0, 5)
                .map((p, i, arr) => (
                  <div
                    key={p.path}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 0',
                      borderBottom: i < arr.length - 1 ? '1px solid var(--cr-line-1)' : 'none',
                    }}
                  >
                    <Avatar name={p.name} size={30} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--cr-fg-1)', letterSpacing: '-0.005em' }}>
                        {p.name}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginTop: 2 }}>
                        {p.sessions} sessions · {p.languages.slice(0, 3).map((l) => l.language).join(' · ')}
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: 'var(--cr-warn-500)',
                        fontVariantNumeric: 'tabular-nums',
                        fontFamily: 'var(--cr-font-mono)',
                      }}
                    >
                      {fmtCost(p.totalCost)}
                    </span>
                  </div>
                ))}
            </div>
          </Card>
        </div>

        <PatternsSection
          patterns={patterns}
          onJumpToSession={onJumpToSession}
          onJumpToSearch={onJumpToSearch}
        />
      </div>
    </div>
  );
}

/**
 * Cross-session pattern panel: hot files, repeated topics, redundancy alerts.
 * Loads asynchronously after the cost dashboard since the aggregation can be
 * slow on libraries with thousands of sessions.
 *
 * Cards are interactive: clicking a topic searches for it, clicking a hot-file
 * row searches by filename, clicking a redundancy pair opens the more recent
 * of the two sessions. Falls back to no-op when handlers aren't provided.
 */
function PatternsSection({
  patterns, onJumpToSession, onJumpToSearch,
}: {
  patterns: PatternsResponse | null;
  onJumpToSession?: (sessionId: string) => void;
  onJumpToSearch?: (query: string) => void;
}) {
  if (!patterns) {
    return (
      <Card style={{ padding: 24, marginTop: 24 }} data-testid="patterns-section">
        <h3>Patterns</h3>
        <p style={{ fontSize: 13, color: 'var(--cr-fg-3)', marginTop: 8 }}>Loading cross-session patterns…</p>
      </Card>
    );
  }
  const hasAnything = patterns.hotFiles.length || patterns.topics.length || patterns.redundancyPairs.length;
  if (!hasAnything) {
    return (
      <Card style={{ padding: 24, marginTop: 24 }} data-testid="patterns-section">
        <h3>Patterns</h3>
        <p style={{ fontSize: 13, color: 'var(--cr-fg-3)', marginTop: 8 }}>
          No patterns yet. Once chat-recall has indexed sessions with file activity, this panel surfaces
          repeated work, hot files, and likely-redundant sessions.
        </p>
      </Card>
    );
  }

  return (
    <div data-testid="patterns-section" style={{ marginTop: 32 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Patterns</h2>
        <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
          across {patterns.meta.sessionsAnalyzed} indexed sessions
        </span>
      </div>

      {patterns.topics.length > 0 && (
        <Card style={{ padding: 24, marginBottom: 16 }} data-testid="patterns-topics">
          <h3 style={{ marginTop: 0 }}>Repeated work</h3>
          <p style={{ fontSize: 12, color: 'var(--cr-fg-3)', margin: '4px 0 16px' }}>
            Topics that show up across many sessions — recurring problem areas.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {patterns.topics.slice(0, 9).map((t) => (
              <div
                key={t.topic}
                role={onJumpToSearch ? 'button' : undefined}
                tabIndex={onJumpToSearch ? 0 : undefined}
                onClick={() => onJumpToSearch?.(t.topic)}
                onKeyDown={(e) => { if (onJumpToSearch && (e.key === 'Enter' || e.key === ' ')) onJumpToSearch(t.topic); }}
                data-testid="patterns-topic"
                style={{
                  padding: 14,
                  border: '1px solid var(--cr-line-1)',
                  borderRadius: 'var(--cr-radius-md)',
                  background: 'var(--cr-ink-0)',
                  cursor: onJumpToSearch ? 'pointer' : 'default',
                  transition: 'border-color var(--cr-dur-fast), background var(--cr-dur-fast)',
                }}
                onMouseEnter={(e) => { if (onJumpToSearch) e.currentTarget.style.borderColor = 'var(--cr-brand-line)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--cr-line-1)'; }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>{t.topic}</span>
                  <Chip kind="info">{t.sessionCount}</Chip>
                </div>
                {t.sampleSessions[0] && (
                  <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', lineHeight: 1.45 }}>
                    {t.sampleSessions[0].snippet}…
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {patterns.hotFiles.length > 0 && (
        <Card style={{ padding: 24, marginBottom: 16 }} data-testid="patterns-hot-files">
          <h3 style={{ marginTop: 0 }}>Hot files</h3>
          <p style={{ fontSize: 12, color: 'var(--cr-fg-3)', margin: '4px 0 16px' }}>
            Files touched by the most sessions. Multiple-project hits often signal a copy-paste pattern.
          </p>
          <div style={{ fontSize: 12, fontFamily: 'var(--cr-mono, monospace)' }}>
            {patterns.hotFiles.slice(0, 12).map((f) => {
              // Search by basename so the FTS5 hit lands on sessions whose
              // chunks mention the file in question — better recall than
              // searching the full path.
              const basename = f.file.split('/').pop() || f.file;
              const onClick = onJumpToSearch ? () => onJumpToSearch(basename) : undefined;
              return (
                <div
                  key={f.file}
                  role={onClick ? 'button' : undefined}
                  tabIndex={onClick ? 0 : undefined}
                  onClick={onClick}
                  onKeyDown={(e) => { if (onClick && (e.key === 'Enter' || e.key === ' ')) onClick(); }}
                  data-testid="patterns-hot-file"
                  title={onClick ? `Click to search for sessions touching ${basename}` : undefined}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto auto',
                    gap: 12,
                    padding: '6px 8px',
                    borderBottom: '1px solid var(--cr-line-1)',
                    alignItems: 'baseline',
                    borderRadius: 4,
                    cursor: onClick ? 'pointer' : 'default',
                    transition: 'background var(--cr-dur-fast)',
                  }}
                  onMouseEnter={(e) => { if (onClick) e.currentTarget.style.background = 'var(--cr-ink-1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{ wordBreak: 'break-all' }}>{f.file}</span>
                  <span style={{ color: 'var(--cr-fg-3)' }}>{f.projects.length} project{f.projects.length === 1 ? '' : 's'}</span>
                  <Chip kind="info">{f.touchedInSessions} sessions</Chip>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {patterns.redundancyPairs.length > 0 && (
        <Card style={{ padding: 24, marginBottom: 16 }} data-testid="patterns-redundancy">
          <h3 style={{ marginTop: 0 }}>Redundancy alerts</h3>
          <p style={{ fontSize: 12, color: 'var(--cr-fg-3)', margin: '4px 0 16px' }}>
            Pairs of sessions in the same project with significant file overlap — flagged as likely
            duplicate work. The agent can read the older one before redoing it.
          </p>
          {patterns.redundancyPairs.slice(0, 6).map((r, i) => {
            const projShort = r.projectPath.split('/').slice(-2).join('/') || r.projectPath;
            // Pairs are sorted; "a" tends to be more recent. Click → open the
            // older one (b) so the agent can read the prior work before
            // redoing it. Two clickable session-id chips for finer control.
            return (
              <div
                key={`${r.a.id}-${r.b.id}-${i}`}
                data-testid="patterns-redundancy-pair"
                style={{
                  padding: '10px 12px',
                  border: '1px solid var(--cr-line-1)',
                  borderRadius: 'var(--cr-radius-md)',
                  marginBottom: 8,
                  background: 'var(--cr-ink-0)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>{projShort}</span>
                  <Chip kind="warn">{Math.round(r.overlap * 100)}% overlap · {r.sharedFiles.length} shared file{r.sharedFiles.length === 1 ? '' : 's'}</Chip>
                </div>
                <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', fontFamily: 'var(--cr-mono, monospace)', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <SessionLink id={r.a.id} date={r.a.mtime.slice(0, 10)} onClick={onJumpToSession} />
                  <span>↔</span>
                  <SessionLink id={r.b.id} date={r.b.mtime.slice(0, 10)} onClick={onJumpToSession} />
                </div>
                <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginTop: 4, fontFamily: 'var(--cr-mono, monospace)', wordBreak: 'break-all' }}>
                  {r.sharedFiles.slice(0, 3).join(' · ')}
                  {r.sharedFiles.length > 3 ? ` · +${r.sharedFiles.length - 3} more` : ''}
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

/** Clickable session-id chip used in the redundancy-pair card. */
function SessionLink({
  id, date, onClick,
}: { id: string; date: string; onClick?: (sessionId: string) => void }) {
  const cb = onClick ? () => onClick(id) : undefined;
  return (
    <span
      role={cb ? 'button' : undefined}
      tabIndex={cb ? 0 : undefined}
      onClick={cb}
      onKeyDown={(e) => { if (cb && (e.key === 'Enter' || e.key === ' ')) cb(); }}
      title={cb ? `Open session ${id}` : undefined}
      style={{
        cursor: cb ? 'pointer' : 'default',
        textDecoration: cb ? 'underline dotted' : 'none',
        textUnderlineOffset: 2,
      }}
    >
      {id.slice(0, 8)} <span style={{ color: 'var(--cr-fg-3)' }}>({date})</span>
    </span>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
      {label}
    </span>
  );
}
