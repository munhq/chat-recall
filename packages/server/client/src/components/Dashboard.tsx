import React, { useState, useEffect } from 'react';
import { Icon, Chip, Metrics, Card, Avatar, IconButton, Plate, Schedule } from './primitives';
import { getAnalytics, getPatterns, getSyncStatus, getSecretsSummary, type AnalyticsData, type PatternsResponse, type SyncStatus, type SecretsSummary } from '../services/api';

type InsightsToolFilter = 'all' | 'claude' | 'gemini' | 'opencode' | 'codex' | 'agy' | 'cursor';

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
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [securitySummary, setSecuritySummary] = useState<SecretsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Sidebar drives the source filter — coerce unknown strings to 'all'.
  const toolFilter: InsightsToolFilter = (['all', 'claude', 'gemini', 'opencode', 'codex', 'agy', 'cursor'] as const).includes(toolFilterProp as any)
    ? (toolFilterProp as InsightsToolFilter)
    : 'all';

  const load = (tool: InsightsToolFilter) => {
    setLoading(true);
    setError(null);
    getAnalytics(tool)
      .then(setData)
      .catch((err) => setError(err.message || 'Failed to load analytics'))
      .finally(() => setLoading(false)); // BUGFIX: loading was never cleared → stuck on "Loading analytics…"
    getSyncStatus().then(setSyncStatus).catch(() => { /* tolerate */ });
    getSecretsSummary().then(setSecuritySummary).catch(() => { /* tolerate */ });
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
        <button onClick={() => load(toolFilter)} style={{ padding: '8px 16px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-2)', borderRadius: 0, color: 'var(--cr-fg-1)', cursor: 'pointer' }}>
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
        <div className="cr-wrap-mobile" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h2>Insights</h2>
            <p className="cr-lead" style={{ marginTop: 4 }}>
              What's working, what's not — and how to improve your Claude setup.
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

        <ImproveYourClaude data={data} secrets={securitySummary} syncStatus={syncStatus} />

        {/* This-week digest card */}
        <div
          style={{
            background: 'var(--cr-ink-1)',
            border: '1px solid var(--cr-line-1)',
            borderRadius: 0,
            padding: 28,
            marginBottom: 24,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <h3>This week</h3>
              <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>calendar week, Sun–Sat</span>
              {costDelta !== 0 && (
                <Chip kind={costDelta > 0 ? 'warn' : 'ok'} icon={costDelta > 0 ? 'arrowUp' : 'arrowDown'}>
                  {Math.abs(costDelta)}% vs last week
                </Chip>
              )}
            </div>
            {/* The last stat-tile row in the app. Four 32px numbers over four
                12px labels, evenly weighted, answering nothing — one schedule
                instead, with the hue on the value. */}
            <Metrics
              style={{ marginBottom: 20 }}
              items={[
                { label: 'Sessions', value: String(data.periodComparison.thisWeek.sessions) },
                { label: 'Cost', value: fmtCost(data.periodComparison.thisWeek.cost), tone: 'cost' },
                { label: 'Cache hit', value: `${data.periodComparison.thisWeek.cacheRate}%`, sub: 'tokens served from cache', tone: 'savings' },
                { label: 'Tokens used', value: fmtTokens(data.periodComparison.thisWeek.tokens) },
              ]}
            />
            {insights.length > 0 && (
              <div
                style={{
                  padding: '12px 14px',
                  borderRadius: 0,
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

        {/* Lifetime totals, as one schedule. Seven unrelated measurements in a
            4-across tile grid gave each the same weight and answered nothing;
            one schedule ranks them, keeps every qualifier legible, and drops
            the coloured top edges that were the card idiom's signature. */}
        <Metrics
          style={{ marginBottom: 24 }}
          caption="Lifetime totals"
          items={[
            {
              label: 'Total sessions',
              value: String(summary.totalSessions),
              sub: fmtSignedDelta(data.periodComparison.thisWeek.sessions, 'this week'),
              icon: 'message',
            },
            {
              label: 'Total cost',
              value: fmtCost(summary.totalCostUsd),
              sub:
                summary.sessionsWithoutPricing > 0
                  ? `${summary.sessionsWithoutPricing} session${summary.sessionsWithoutPricing === 1 ? '' : 's'} without pricing`
                  : 'lifetime',
              tone: 'cost',
              icon: 'sparkle',
            },
            {
              label: 'Compute time',
              value: fmtDuration(summary.totalDurationMin),
              sub: `across ${data.projects.length} project${data.projects.length === 1 ? '' : 's'}`,
              icon: 'clock',
            },
            {
              label: 'Cache reads',
              value: `${fmtTokens(summary.totalCacheReadTokens)} tokens`,
              // Cache reads are billed at ~10% of base input on Anthropic; we don't
              // know the actual base price for non-Anthropic models, so keep this
              // a token count rather than a fabricated dollar amount.
              sub: 'saved against re-uploading',
              tone: 'savings',
              icon: 'zap',
            },
            {
              label: 'Hours this week',
              value: String(summary.hoursPerWeek),
              sub: 'active AI session time',
              icon: 'clock',
            },
            {
              label: 'Synced sessions',
              value: syncStatus ? String(syncStatus.sessions) : '—',
              sub:
                syncStatus?.newestSessionAgeMs != null
                  ? `newest ${Math.max(0, Math.round(syncStatus.newestSessionAgeMs / 60000))} min ago`
                  : 'server coverage',
              icon: 'cloud',
            },
            {
              label: 'Security findings',
              value: securitySummary ? String(securitySummary.actionRequired) : '—',
              sub: securitySummary
                ? `${securitySummary.verified} verified live, ${securitySummary.distinct} distinct`
                : 'no scan data yet',
              tone: securitySummary && securitySummary.actionRequired > 0 ? 'err' : 'ok',
              icon: 'shield',
            },
          ]}
        />

        {/* Cost chart */}
        {data.dailyCost.length > 0 && (
          <Card style={{ padding: 24, marginBottom: 24 }}>
            <div className="cr-wrap-mobile" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
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
                    borderRadius: 0,
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
                fontSize: 12,
                color: 'var(--cr-fg-3)',
              }}
            >
              <span>30 days ago</span>
              <span>Today</span>
            </div>
          </Card>
        )}

        {/* Two panels SHARING ONE FRAME, not two framed boxes with a gap
            between them. A gapped grid of ink frames is the card grid in
            heavier ink, which is worse than where this started. */}
        <div className="cr-plates" data-cols="2">
          <Card style={{ padding: 24, border: 0, background: 'transparent' }}>
            <div className="cr-wrap-mobile" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
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
                        borderRadius: 0,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${(b.sessions / max) * 100}%`,
                          background: 'var(--cr-brand-500)',
                          borderRadius: 0,
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

          <Card style={{ padding: 24, border: 0, background: 'transparent' }}>
            <div className="cr-wrap-mobile" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
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
                      <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginTop: 2 }}>
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
      <div className="cr-wrap-mobile" style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
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
          {/* Nine hand-rolled bordered boxes in a gapped grid — a card grid that
              did not even use the Card primitive. A schedule ranks the topics by
              how often they recur, which is the question the panel answers. */}
          <Schedule
            cols={[
              { key: 'topic', kind: 'pn', head: 'Topic' },
              { key: 'n', kind: 'val', head: 'Sessions' },
            ]}
            rows={patterns.topics.slice(0, 9).map((t) => ({
              id: t.topic,
              onSelect: onJumpToSearch ? () => onJumpToSearch(t.topic) : undefined,
              style: { textTransform: 'capitalize' as const },
              cells: {
                topic: (
                  <span data-testid="patterns-topic">
                    <span style={{ whiteSpace: 'normal' }}>{t.topic}</span>
                    {t.sampleSessions[0] && (
                      <span className="pn-sub" style={{ textTransform: 'none' }}>{t.sampleSessions[0].snippet}…</span>
                    )}
                  </span>
                ),
                n: t.sessionCount,
              },
            }))}
          />
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
                    gridTemplateColumns: 'minmax(0,1fr) auto auto',
                    gap: 12,
                    padding: '6px 8px',
                    borderBottom: '1px solid var(--cr-line-1)',
                    alignItems: 'baseline',
                    borderRadius: 0,
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
                  borderRadius: 0,
                  marginBottom: 8,
                  background: 'var(--cr-ink-0)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>{projShort}</span>
                  <Chip kind="warn">{Math.round(r.overlap * 100)}% overlap · {r.sharedFiles.length} shared file{r.sharedFiles.length === 1 ? '' : 's'}</Chip>
                </div>
                <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', fontFamily: 'var(--cr-mono, monospace)', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <SessionLink id={r.a.id} date={r.a.mtime.slice(0, 10)} onClick={onJumpToSession} />
                  <Icon name="arrowRight" size={13} style={{ color: 'var(--cr-fg-3)' }} />
                  <SessionLink id={r.b.id} date={r.b.mtime.slice(0, 10)} onClick={onJumpToSession} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginTop: 4, fontFamily: 'var(--cr-mono, monospace)', wordBreak: 'break-all' }}>
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
      <span style={{ width: 8, height: 8, borderRadius: 0, background: color }} />
      {label}
    </span>
  );
}

// ── Improve your Claude: derive workflow signals + concrete CLAUDE.md tips ────
function ImproveYourClaude({ data, secrets, syncStatus }: { data: AnalyticsData; secrets: SecretsSummary | null; syncStatus: SyncStatus | null }) {
  const lc = (s: string) => s.toLowerCase();
  // Match the real classifier statuses (shipped/abandoned/interrupted/
  // completed) first; the legacy free-text words stay as a fallback for any
  // pre-classifier rows. 'shipped' + 'completed' = clean; 'abandoned' +
  // 'interrupted' = unresolved. 'unknown'/'in_progress' are excluded from
  // the ratio (not yet a verdict), so completion reflects decided sessions.
  const CLEAN = ['shipped', 'completed', 'success', 'done', 'resolved'];
  const BAD = ['abandoned', 'interrupted', 'failed', 'error', 'incomplete'];
  const outcomes = data.outcomes || [];
  const clean = outcomes.filter((o) => CLEAN.some((r) => lc(o.reason).includes(r))).reduce((a, o) => a + o.count, 0);
  const bad = outcomes.filter((o) => BAD.some((r) => lc(o.reason).includes(r))).reduce((a, o) => a + o.count, 0);
  const classified = clean + bad;
  const completion = classified > 0 ? Math.round((clean / classified) * 100) : null;
  const ctxHit = data.contextExhausted?.length || 0;
  const leaked = secrets?.actionRequired ?? (secrets ? secrets.total : 0);
  const topModel = (data.costByModel || [])[0];

  const sugg: Array<{ t: string; d: string }> = [];
  if (classified >= 4 && completion != null && completion < 70) sugg.push({ t: 'Add a definition-of-done to CLAUDE.md', d: `${100 - completion}% of classified sessions ended interrupted/abandoned. A "not done until build + tests pass, verified" rule cuts re-work.` });
  if (ctxHit >= 3) sugg.push({ t: 'Tell the AI to split large tasks + use recall', d: `${ctxHit} sessions hit high context usage. Add "break big tasks into steps; recall prior context instead of re-reading the whole repo."` });
  if (leaked > 0) sugg.push({ t: 'Add a no-secrets rule + rotate', d: `${leaked} secret(s) flagged in your sessions. Add "never echo secrets; load from env/secret-manager" and rotate the exposed ones.` });
  if (data.summary.totalSessions > 0 && data.summary.sessionsWithoutPricing / data.summary.totalSessions > 0.3) sugg.push({ t: 'Pin model ids for accurate cost', d: `${data.summary.sessionsWithoutPricing} sessions ran on models without known pricing — your cost view undercounts.` });
  if (!sugg.length) sugg.push({ t: 'Looking healthy', d: 'No obvious workflow regressions in this window — clean outcomes, context under control, no leaked secrets.' });

  const shortM = (m: string) => m.replace(/^.*\//, '').replace(/-\d{6,}$/, '').slice(0, 18);
  const usd = (n: number) => (n >= 1 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

  return (
    <Plate
      style={{ marginBottom: 24 }}
      title={
        <>
          Improve your Claude
          <span style={{ color: 'var(--cr-fg-3)', fontWeight: 400, marginLeft: 8, fontSize: 12.5 }}>what your sessions reveal about your setup</span>
        </>
      }
      flush
    >
      {/* Five bordered tiles inside a bordered panel — a card grid nested in a
          card, which is always wrong. One schedule instead, and the eyebrow
          "SUGGESTED CLAUDE.MD ADDITIONS" becomes the second schedule's own
          caption. Two flush schedules, one drawn object. */}
      <Metrics
        items={[
          { label: 'Completion', value: completion != null ? `${completion}%` : '—', sub: classified ? `${clean} of ${classified} shipped, not abandoned` : 'no decided outcomes', tone: completion == null ? 'neutral' : completion >= 70 ? 'ok' : 'err' },
          { label: 'Context exhaustion', value: String(ctxHit), sub: 'sessions near the window limit', tone: ctxHit >= 3 ? 'warn' : 'ok' },
          { label: 'Leaked secrets', value: String(leaked), sub: secrets ? `across ${secrets.sessionsWithFindings} sessions` : '—', tone: leaked > 0 ? 'err' : 'ok' },
          { label: 'Top model', value: topModel ? shortM(topModel.model) : '—', sub: topModel ? `${usd(topModel.cost)} all-time` : undefined },
          { label: 'Synced', value: syncStatus ? String(syncStatus.sessions) : '—', sub: 'sessions on the server' },
        ]}
      />
      <Schedule
        caption="Suggested CLAUDE.md additions"
        cols={[{ key: 'tip', kind: 'no' }, { key: 'body', kind: 'pn' }]}
        rows={sugg.map((x, i) => ({
          id: String(i),
          cells: {
            tip: <Chip kind="brand" size="sm">tip</Chip>,
            body: (
              <>
                <span style={{ whiteSpace: 'normal' }}>{x.t}</span>
                <span className="pn-sub">{x.d}</span>
              </>
            ),
          },
        }))}
        empty="Nothing to suggest — your setup looks clean."
      />
    </Plate>
  );
}

