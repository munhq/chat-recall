import React, { useState, useEffect } from 'react';
import { Icon, Chip, MetricCard, Card, Avatar, IconButton, SegmentedControl } from './primitives';
import { getAnalytics, type AnalyticsData } from '../services/api';

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

export default function Dashboard() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    getAnalytics()
      .then(setData)
      .catch((err) => setError(err.message || 'Failed to load analytics'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

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
        <button onClick={load} style={{ padding: '8px 16px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-2)', borderRadius: 'var(--cr-radius-sm)', color: 'var(--cr-fg-1)', cursor: 'pointer' }}>
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
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--cr-ink-0)' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 40px 64px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 32 }}>
          <div>
            <h2>Insights</h2>
            <p className="cr-lead" style={{ marginTop: 4 }}>
              Where your tokens go — and what you can cut.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <SegmentedControl
              options={[{ value: '7d', label: '7d' }, { value: '30d', label: '30d' }, { value: 'all', label: 'All time' }]}
              value="30d"
              onChange={() => {}}
            />
            <IconButton icon="refresh" onClick={load} />
          </div>
        </div>

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
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 32, marginBottom: 20 }}
            >
              {[
                { v: String(data.periodComparison.thisWeek.sessions), l: 'Sessions', tone: 'neutral' as const },
                { v: fmtCost(data.periodComparison.thisWeek.cost), l: 'Cost', tone: 'cost' as const },
                { v: `${data.periodComparison.thisWeek.cacheRate}%`, l: 'Cache hit', tone: 'savings' as const },
                { v: '412K', l: 'Tokens used', tone: 'neutral' as const },
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
          <MetricCard label="Total sessions" value={String(summary.totalSessions)} sub="+ 53 this week" icon="message" />
          <MetricCard label="Total cost" value={fmtCost(summary.totalCostUsd)} sub="Lifetime" tone="cost" icon="sparkle" />
          <MetricCard label="Compute time" value={fmtDuration(summary.totalDurationMin)} sub="Across 12 projects" icon="clock" />
          <MetricCard
            label="Cache savings"
            value={`${(summary.totalCacheReadTokens / 1e9).toFixed(1)}B tokens`}
            sub={`At list: ≈ $${(summary.totalCacheReadTokens / 1e9 * 3).toFixed(0)}`}
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Card style={{ padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
              <h3>Top tools</h3>
              <a href="#">See all</a>
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
              <a href="#">See all</a>
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
      </div>
    </div>
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
