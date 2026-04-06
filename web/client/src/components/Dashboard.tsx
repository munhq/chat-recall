/**
 * Dashboard — weekly digest landing with cost trends, insights, and project overview.
 */

import React, { useState, useEffect } from 'react';
import { getAnalytics, type AnalyticsData } from '../services/api';
import './Dashboard.css';

interface DashboardProps {
  toolFilter: string;
}

/** Format minutes → human-readable */
function fmtDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const m = mins % 60;
  if (hours < 24) return m > 0 ? `${hours}h ${m}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `${days}d ${h}h` : `${days}d`;
}

/** Format cost with $ and commas */
function fmtCost(n: number): string {
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

/** Strip markdown / emoji from descriptions */
function cleanDesc(d: string): string {
  return d.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/\*\*/g, '').replace(/^\s*[-:]\s*/, '').trim();
}

export default function Dashboard({ toolFilter }: DashboardProps) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tab = toolFilter || 'overview';

  const load = () => {
    setLoading(true);
    setError(null);
    getAnalytics()
      .then(setData)
      .catch((err) => setError(err.message || 'Failed to load analytics'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  if (loading) return <div className="dashboard"><div className="dash-loading">Loading analytics...</div></div>;
  if (error || !data) return (
    <div className="dashboard">
      <div className="dash-error"><p>{error || 'No data'}</p><button onClick={load} className="dash-retry">Retry</button></div>
    </div>
  );

  const { summary } = data;
  const maxDailyCost = Math.max(...data.dailyCost.map(d => d.cost), 1);
  const toolLabel = (t: string) => t === 'claude' ? 'Claude' : t === 'gemini' ? 'Gemini' : t === 'opencode' ? 'OpenCode' : t;

  // Compute insights
  const costDelta = data.periodComparison.lastWeek.cost > 0
    ? Math.round((data.periodComparison.thisWeek.cost - data.periodComparison.lastWeek.cost) / data.periodComparison.lastWeek.cost * 100) : 0;

  const opusDetail = data.costByModel.find(m => m.model.includes('opus'));
  const sonnetDetail = data.costByModel.find(m => m.model.includes('sonnet'));

  const insights: string[] = [];
  if (costDelta > 100) {
    insights.push(`Cost is up ${costDelta}% vs last week — check expensive sessions below.`);
  } else if (costDelta < -20) {
    insights.push(`Cost is down ${Math.abs(costDelta)}% vs last week.`);
  }
  if (opusDetail && sonnetDetail && opusDetail.cost > sonnetDetail.cost * 2) {
    insights.push(`Opus accounts for ${fmtCost(opusDetail.cost)} (${opusDetail.sessions} sessions). Consider sonnet for exploration.`);
  }
  if (data.contextExhausted.length > 3) {
    insights.push(`${data.contextExhausted.length} sessions hit high context usage — consider splitting large tasks.`);
  }

  // Shared components
  const BarChart = ({ items, color = '' }: { items: Array<{label: string; value: number}>; color?: string }) => {
    const max = items[0]?.value || 1;
    return (
      <div className="dash-bars">
        {items.map(({ label, value }) => (
          <div key={label} className="bar-row">
            <span className="bar-label">{label}</span>
            <div className="bar-track">
              <div className={`bar-fill ${color}`} style={{ width: `${(value / max) * 100}%` }} />
            </div>
            <span className="bar-value">{value}</span>
          </div>
        ))}
      </div>
    );
  };

  const TopList = ({ items }: { items: Array<{id: string; project: string; slug: string; value: string}> }) => (
    <div className="dash-list">
      {items.map((s, i) => (
        <div key={s.id} className="dash-list-item">
          <span className="list-rank">#{i + 1}</span>
          <div className="list-info">
            <div className="list-title">{s.project}</div>
            <div className="list-meta">{s.slug}</div>
          </div>
          <span className="list-value value-cost">{s.value}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="dashboard">
      <div className="dash-header">
        <h2>Dashboard</h2>
        <button onClick={load} className="dash-refresh">Refresh</button>
      </div>

      {/* ═══ OVERVIEW ═══ */}
      {tab === 'overview' && (
        <>
          {/* ── Weekly Digest ── */}
          <div className="digest">
            <div className="digest-header">
              <h3>This Week</h3>
              {costDelta !== 0 && (
                <span className={`digest-delta ${costDelta > 0 ? 'delta-up' : 'delta-down'}`}>
                  {costDelta > 0 ? '+' : ''}{costDelta}% vs last week
                </span>
              )}
            </div>
            <div className="digest-stats">
              <div className="digest-stat">
                <span className="digest-stat-value">{data.periodComparison.thisWeek.sessions}</span>
                <span className="digest-stat-label">sessions</span>
              </div>
              <div className="digest-stat">
                <span className="digest-stat-value digest-cost">{fmtCost(data.periodComparison.thisWeek.cost)}</span>
                <span className="digest-stat-label">spent</span>
              </div>
              <div className="digest-stat">
                <span className="digest-stat-value digest-cache">{data.periodComparison.thisWeek.cacheRate}%</span>
                <span className="digest-stat-label">cache hit</span>
              </div>
            </div>

            {/* Top projects this week (sorted by sessions) */}
            <div className="digest-projects">
              {data.projects.filter(p => p.name.length > 1).slice(0, 6).map(p => (
                <div key={p.path} className="digest-proj">
                  <span className="digest-proj-name">{p.name}</span>
                  <span className="digest-proj-meta">{p.sessions} sessions · {fmtCost(p.totalCost)}</span>
                </div>
              ))}
            </div>

            {/* Insights */}
            {insights.length > 0 && (
              <div className="digest-insights">
                {insights.map((text, i) => (
                  <div key={i} className="digest-insight">{text}</div>
                ))}
              </div>
            )}
          </div>

          {/* ── All-time stats ── */}
          <div className="dash-cards">
            <div className="dash-card"><div className="card-value">{summary.totalSessions}</div><div className="card-label">Sessions</div></div>
            <div className="dash-card card-cost"><div className="card-value">{fmtCost(summary.totalCostUsd)}</div><div className="card-label">Total Cost</div></div>
            <div className="dash-card"><div className="card-value">{fmtDuration(summary.totalDurationMin)}</div><div className="card-label">Coding Time</div></div>
            <div className="dash-card"><div className="card-value">${summary.avgCostPerSession.toFixed(2)}</div><div className="card-label">Avg/Session</div></div>
          </div>

          {/* ── Tool breakdown ── */}
          {data.sessionsByTool.length > 1 && (
            <div className="tool-breakdown">
              {data.sessionsByTool.map(({ tool, count }) => (
                <div key={tool} className={`tool-card tool-card-${tool}`}>
                  <div className="tool-count">{count}</div>
                  <div className="tool-name">{toolLabel(tool)}</div>
                  {data.toolDetails?.[tool] && data.toolDetails[tool].cost > 0 && (
                    <div className="tool-cost">{fmtCost(data.toolDetails[tool].cost)}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Cost & Trends (visible by default, not hidden in Claude tab) ── */}
          {data.dailyCost.length > 0 && (
            <div className="dash-section">
              <h3>Daily Cost (Last 30 Days)</h3>
              <div className="cost-chart">
                {data.dailyCost.map(({ day, cost }) => (
                  <div key={day} className="cost-bar-container" data-tip={`${day}: $${cost.toFixed(2)}`}>
                    <div className="cost-bar" style={{ height: `${Math.max((cost / maxDailyCost) * 100, 2)}%` }} />
                    <div className="cost-day">{day.slice(8)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.weeklyTrends.length > 0 && (
            <div className="dash-section">
              <h3>Weekly Trends</h3>
              <div className="weekly-grid">
                <div className="weekly-chart">
                  <div className="weekly-label">Cost</div>
                  <div className="weekly-bars">
                    {data.weeklyTrends.map(({ week, cost, sessions }) => {
                      const maxW = Math.max(...data.weeklyTrends.map(w => w.cost), 1);
                      return (
                        <div key={week} className="weekly-bar-wrap" data-tip={`${week}: $${cost} (${sessions} sessions)`}>
                          <div className="weekly-bar-cost" style={{ height: `${(cost / maxW) * 100}%` }} />
                          <div className="weekly-bar-label">{week.slice(5)}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="weekly-chart">
                  <div className="weekly-label">Cache Hit Rate</div>
                  <div className="weekly-bars">
                    {data.weeklyTrends.map(({ week, cacheRate }) => (
                      <div key={week} className="weekly-bar-wrap" data-tip={`${week}: ${cacheRate}% cache hit`}>
                        <div className="weekly-bar-cache" style={{ height: `${cacheRate}%` }} />
                        <div className="weekly-bar-label">{week.slice(5)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Model cost breakdown + expensive sessions (side by side) ── */}
          <div className="dash-grid dash-grid-2">
            <div className="dash-section">
              <h3>Cost by Model</h3>
              <TopList items={data.costByModel.map(m => ({
                id: m.model, project: m.model.replace('claude-', ''),
                slug: `${m.sessions} sessions · ${m.tokensM}M tokens`, value: fmtCost(m.cost)
              }))} />
            </div>
            <div className="dash-section">
              <h3>Most Expensive Sessions</h3>
              <TopList items={data.topByCost.slice(0, 8).map(s => ({ ...s, value: fmtCost(s.cost) }))} />
            </div>
          </div>

          {/* ── Activity + Languages ── */}
          <div className="dash-grid dash-grid-2">
            <div className="dash-section">
              <h3>Activity (Hour x Day of Week)</h3>
              <div className="heatmap">
                <div className="heatmap-header">
                  <div className="heatmap-corner" />
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                    <div key={d} className="heatmap-day-label">{d}</div>
                  ))}
                </div>
                {[6,8,10,12,14,16,18,20,22].map(hour => {
                  const maxVal = Math.max(...data.activityHeatmap.flat(), 1);
                  return (
                    <div key={hour} className="heatmap-row">
                      <div className="heatmap-hour-label">{hour.toString().padStart(2,'0')}:00</div>
                      {data.activityHeatmap[hour].map((val, day) => (
                        <div key={day} className="heatmap-cell"
                          style={{ opacity: val > 0 ? 0.2 + (val / maxVal) * 0.8 : 0.05 }}
                          data-tip={`${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]} ${hour}:00 — ${val} sessions`}
                        >{val > 0 ? val : ''}</div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="dash-section">
              <h3>Languages</h3>
              <BarChart items={data.languages.slice(0, 10).map(l => ({ label: l.language, value: l.files }))} />
            </div>
          </div>

          {/* ── Context utilization + High context ── */}
          <div className="dash-grid dash-grid-2">
            {data.contextUtilization && (
              <div className="dash-section">
                <h3>Context Window Utilization</h3>
                <p className="chart-subtitle">How much of the context window each session used</p>
                <div className="util-chart">
                  {data.contextUtilization.map(({ range, count }) => {
                    const maxCount = Math.max(...data.contextUtilization.map(u => u.count), 1);
                    const pct = parseInt(range);
                    const color = pct >= 80 ? '#f85149' : pct >= 50 ? '#d29922' : '#3fb950';
                    return (
                      <div key={range} className="util-bar-wrap" data-tip={`${range}: ${count} sessions`}>
                        <div className="util-bar" style={{ height: `${Math.max((count / maxCount) * 100, 2)}%`, background: color }} />
                        <div className="util-label">{range.replace('%', '')}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {data.contextExhausted.length > 0 && (
              <div className="dash-section">
                <h3>High Context Usage</h3>
                <TopList items={data.contextExhausted.map(s => ({ ...s, value: `${s.peakK}k` }))} />
              </div>
            )}
          </div>

          {/* ── Projects ── */}
          <div className="dash-section dash-section-wide">
            <h3>Projects</h3>
            <div className="project-cards">
              {data.projects.map((p) => (
                <div key={p.path} className="project-card">
                  <div className="pcard-header">
                    <span className="pcard-name">{p.name}</span>
                    {p.totalCost > 0 && <span className="pcard-cost">{fmtCost(p.totalCost)}</span>}
                  </div>
                  {p.description && <div className="pcard-desc">{cleanDesc(p.description)}</div>}
                  <div className="pcard-stats">
                    <span>{p.sessions} sessions</span>
                    {p.totalDurationMin > 0 && <span>{fmtDuration(p.totalDurationMin)}</span>}
                    {p.models.length > 0 && <span>{p.models.map(m => m.replace('claude-', '').replace(/-\d+$/, '')).join(', ')}</span>}
                  </div>
                  {p.languages.length > 0 && (
                    <div className="pcard-langs">
                      {p.languages.slice(0, 5).map(l => (
                        <span key={l.language} className="pcard-lang-chip">{l.language} <small>({l.files})</small></span>
                      ))}
                    </div>
                  )}
                  {p.weeklyVelocity.length > 1 && (
                    <div className="pcard-sparkline" title="Weekly session count (last 8 weeks)">
                      {(() => {
                        const max = Math.max(...p.weeklyVelocity, 1);
                        return p.weeklyVelocity.map((v, i) => (
                          <div key={i} className="spark-bar" style={{ height: `${Math.max((v / max) * 100, 5)}%` }} data-tip={`${v} sessions`} />
                        ));
                      })()}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ═══ CLAUDE TAB ═══ */}
      {tab === 'claude' && (
        <>
          {data.toolDetails?.claude && (
            <div className="dash-cards">
              <div className="dash-card"><div className="card-value">{data.toolDetails.claude.sessions}</div><div className="card-label">Sessions</div></div>
              <div className="dash-card card-cost"><div className="card-value">{fmtCost(data.toolDetails.claude.cost)}</div><div className="card-label">Total Cost</div></div>
              <div className="dash-card"><div className="card-value">{(data.toolDetails.claude.inputTokens / 1e6).toFixed(0)}M</div><div className="card-label">Input Tokens</div></div>
              <div className="dash-card"><div className="card-value">{(data.toolDetails.claude.outputTokens / 1e6).toFixed(0)}M</div><div className="card-label">Output Tokens</div></div>
              <div className="dash-card card-savings"><div className="card-value">{(summary.totalCacheReadTokens / 1e6).toFixed(0)}M</div><div className="card-label">Cache Reads</div></div>
              <div className="dash-card"><div className="card-value">{fmtDuration(data.toolDetails.claude.durationMin)}</div><div className="card-label">Duration</div></div>
            </div>
          )}
          <div className="dash-grid">
            <div className="dash-section">
              <h3>Models</h3>
              <BarChart items={data.models.map(m => ({ label: m.model.replace('claude-', ''), value: m.sessions }))} color="bar-fill-model" />
            </div>
            <div className="dash-section">
              <h3>Tools Used</h3>
              <BarChart items={data.tools.slice(0, 10).map(t => ({ label: t.tool, value: t.sessions }))} color="bar-fill-tools" />
            </div>
            <div className="dash-section">
              <h3>Session Outcomes</h3>
              <BarChart items={data.outcomes.map(o => ({
                label: o.reason === 'end_turn' ? 'Clean finish' : o.reason === 'stop_sequence' ? 'Stop sequence'
                  : o.reason === 'max_tokens' ? 'Context exhausted' : o.reason === 'tool_use' ? 'Tool loop' : o.reason,
                value: o.count
              }))} />
            </div>
            <div className="dash-section">
              <h3>Longest Sessions</h3>
              <TopList items={data.topByDuration.map(s => ({ ...s, value: fmtDuration(s.durationMin) }))} />
            </div>
            <div className="dash-section">
              <h3>Most Modified Files</h3>
              <div className="dash-list">
                {data.fileHotspots.slice(0, 10).map(f => (
                  <div key={f.file} className="dash-list-item">
                    <div className="list-info">
                      <div className="list-title file-path">{f.file.split('/').pop()}</div>
                      <div className="list-meta">{f.projects.join(', ')}</div>
                    </div>
                    <span className="list-value">{f.count}x</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* ═══ GEMINI TAB ═══ */}
      {tab === 'gemini' && (
        <>
          <div className="dash-cards">
            <div className="dash-card"><div className="card-value">{data.toolDetails?.gemini?.sessions || 0}</div><div className="card-label">Sessions</div></div>
            {(data.toolDetails?.gemini?.inputTokens || 0) > 0 && (
              <div className="dash-card"><div className="card-value">{((data.toolDetails?.gemini?.inputTokens || 0) / 1e9).toFixed(1)}B</div><div className="card-label">Input Tokens</div></div>
            )}
            {(data.toolDetails?.gemini?.outputTokens || 0) > 0 && (
              <div className="dash-card"><div className="card-value">{((data.toolDetails?.gemini?.outputTokens || 0) / 1e6).toFixed(1)}M</div><div className="card-label">Output Tokens</div></div>
            )}
            {(data.toolDetails?.gemini?.durationMin || 0) > 0 && (
              <div className="dash-card"><div className="card-value">{fmtDuration(data.toolDetails!.gemini!.durationMin)}</div><div className="card-label">Duration</div></div>
            )}
          </div>
          {data.toolDetails?.gemini?.projects && data.toolDetails.gemini.projects.length > 0 && (
            <div className="dash-section">
              <h3>Sessions by Project</h3>
              <BarChart items={data.toolDetails.gemini.projects.map(p => ({ label: p.project || '(unresolved)', value: p.count }))} />
            </div>
          )}
          <div className="dash-grid">
            {data.toolDetails?.gemini?.models && data.toolDetails.gemini.models.length > 0 && (
              <div className="dash-section">
                <h3>Models</h3>
                <BarChart items={data.toolDetails.gemini.models.map(m => ({ label: m.model.replace('gemini-', ''), value: m.count }))} color="bar-fill-model" />
              </div>
            )}
            {data.toolDetails?.gemini?.tools && data.toolDetails.gemini.tools.length > 0 && (
              <div className="dash-section">
                <h3>Tools Used</h3>
                <BarChart items={data.toolDetails.gemini.tools.map(t => ({ label: t.tool, value: t.count }))} color="bar-fill-tools" />
              </div>
            )}
            {data.toolDetails?.gemini?.languages && data.toolDetails.gemini.languages.length > 0 && (
              <div className="dash-section">
                <h3>Languages</h3>
                <BarChart items={data.toolDetails.gemini.languages.map(l => ({ label: l.language, value: l.files }))} />
              </div>
            )}
          </div>
        </>
      )}

      {/* ═══ OPENCODE TAB ═══ */}
      {tab === 'opencode' && (
        <>
          <div className="dash-cards">
            <div className="dash-card"><div className="card-value">{data.toolDetails?.opencode?.sessions || 0}</div><div className="card-label">Sessions</div></div>
            {(data.toolDetails?.opencode?.cost || 0) > 0 && (
              <div className="dash-card card-cost"><div className="card-value">{fmtCost(data.toolDetails?.opencode?.cost || 0)}</div><div className="card-label">Total Cost</div></div>
            )}
            {(data.toolDetails?.opencode?.inputTokens || 0) > 0 && (
              <div className="dash-card"><div className="card-value">{((data.toolDetails?.opencode?.inputTokens || 0) / 1e6).toFixed(1)}M</div><div className="card-label">Input Tokens</div></div>
            )}
            {(data.toolDetails?.opencode?.outputTokens || 0) > 0 && (
              <div className="dash-card"><div className="card-value">{((data.toolDetails?.opencode?.outputTokens || 0) / 1e6).toFixed(1)}M</div><div className="card-label">Output Tokens</div></div>
            )}
          </div>
          {data.toolDetails?.opencode?.projects && data.toolDetails.opencode.projects.length > 0 && (
            <div className="dash-section">
              <h3>Sessions by Project</h3>
              <BarChart items={data.toolDetails.opencode.projects.map(p => ({ label: p.project, value: p.count }))} />
            </div>
          )}
          <div className="dash-grid">
            {data.toolDetails?.opencode?.tools && data.toolDetails.opencode.tools.length > 0 && (
              <div className="dash-section">
                <h3>Tools Used</h3>
                <BarChart items={data.toolDetails.opencode.tools.map(t => ({ label: t.tool, value: t.count }))} color="bar-fill-tools" />
              </div>
            )}
            {data.toolDetails?.opencode?.models && data.toolDetails.opencode.models.length > 0 && (
              <div className="dash-section">
                <h3>Models</h3>
                <BarChart items={data.toolDetails.opencode.models.map(m => ({ label: m.model, value: m.count }))} color="bar-fill-model" />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
