/**
 * Command Center — the unified, dashboard-first home for chat-recall.
 *
 * The restructure: instead of landing on a list of disconnected tabs, you land
 * on one helicopter view that fuses HOW you build (sessions/behaviour) and WHAT
 * you build (code health/findings) with the actionable recommendations that sit
 * at their intersection. Every tile is a door — click through to the focused
 * view. Intelligence-console aesthetic: dark canvas, amber signal, Martian Mono
 * numerals.
 */

import React, { useEffect, useState } from 'react';
import { Card, Chip, Button, Icon, pressableProps } from './primitives';
import ConnectMachine from './ConnectMachine';
import SyncCoverage from './SyncCoverage';
import SyncRules from './SyncRules';
import {
  getCodeProjects, getAccountRecommendations, applyAccountRecommendation, getSecretsSummary, getStatus, getSyncStatus, getOutcomeSummary,
  getMe, listDevices,
  type CodeProject, type CodeRecommendation, type SecretsSummary, type OutcomeDayRow,
} from '../services/api';

type Nav = (v: string) => void;

export default function CommandCenter({ setView, onOpenProject, cloud }: { setView: Nav; onOpenProject: (id: string) => void; cloud?: boolean }) {
  const [projects, setProjects] = useState<CodeProject[]>([]);
  const [recs, setRecs] = useState<CodeRecommendation[]>([]);
  const [secrets, setSecrets] = useState<SecretsSummary | null>(null);
  const [status, setStatus] = useState<{ totalSessions?: number } | null>(null);
  const [loading, setLoading] = useState(true);

  // Dead-workspace detector (cloud): a workspace with synced data but ZERO
  // active device tokens can never receive another byte — say so at the top
  // of the home view, not buried in Account. (Live incident: a revoked token
  // left prod frozen at 7 conversations with no visible signal.) Secondary
  // signal: devices exist but nothing has arrived for 48h — the machine's
  // watch service is probably down.
  const [syncAlert, setSyncAlert] = useState<null | { kind: 'no-device' | 'stale'; ageH?: number }>(null);
  useEffect(() => {
    if (!cloud) return;
    let on = true;
    (async () => {
      try {
        const me = await getMe();
        const slug = me.teams[0]?.team_slug;
        if (!slug) return;
        const [devices, s] = await Promise.all([listDevices(slug), getSyncStatus()]);
        if (!on) return;
        const active = devices.filter((d) => !d.revoked);
        if (active.length === 0 && s.sessions > 0) setSyncAlert({ kind: 'no-device' });
        else if (active.length > 0 && s.newestSessionAgeMs != null && s.newestSessionAgeMs > 48 * 3600_000) {
          setSyncAlert({ kind: 'stale', ageH: Math.round(s.newestSessionAgeMs / 3600_000) });
        }
      } catch { /* control-plane hiccup — no banner beats a wrong banner */ }
    })();
    return () => { on = false; };
  }, [cloud]);

  // Live sync ticker: while sessions are still arriving (a fresh machine
  // backfilling its history), show the count climbing instead of a frozen
  // number. Polls every 10s and goes quiet once two polls agree.
  const [syncTick, setSyncTick] = useState<{ sessions: number; arriving: boolean } | null>(null);
  useEffect(() => {
    let on = true;
    let last = -1;
    let stable = 0;
    const poll = async () => {
      try {
        const s = await getSyncStatus();
        if (!on) return;
        const arriving = s.sessions !== last;
        stable = arriving ? 0 : stable + 1;
        last = s.sessions;
        setSyncTick({ sessions: s.sessions, arriving: stable < 2 });
      } catch { /* transient — keep the last reading */ }
    };
    void poll();
    const t = setInterval(poll, 10_000);
    return () => { on = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    let on = true;
    Promise.allSettled([getCodeProjects(), getAccountRecommendations(), getSecretsSummary(), getStatus()])
      .then(([p, r, s, st]) => {
        if (!on) return;
        if (p.status === 'fulfilled') setProjects(p.value);
        if (r.status === 'fulfilled') setRecs(r.value.recommendations);
        if (s.status === 'fulfilled') setSecrets(s.value);
        if (st.status === 'fulfilled') setStatus(st.value as any);
        setLoading(false);
      });
    return () => { on = false; };
  }, []);

  const criticals = projects.reduce((a, p) => a + (p.health?.critical ?? 0), 0);
  const hotspots = projects.reduce((a, p) => a + (p.health?.hotspots ?? 0), 0);
  const leaked = secrets ? (secrets.totals || []).reduce((a, t) => a + (t.findings || 0), 0) : 0;

  // First run on the SaaS: a paying user with zero synced sessions gets the
  // connect flow front-and-center, not a wall of `—` metrics that reads like
  // the product is broken. The moment data lands, the dashboard takes over.
  if (cloud && !loading && (status?.totalSessions ?? 0) === 0) {
    return (
      <div className="cr-cmd" style={{ flex: 1, overflow: 'auto', padding: '28px 32px 64px' }}>
        <div style={{ maxWidth: 680, margin: '40px auto 0' }}>
          <div style={{ fontFamily: 'var(--cr-font-display)', fontSize: 10, letterSpacing: '0.32em', textTransform: 'uppercase', color: 'var(--cr-brand-500)', marginBottom: 8 }}>
            welcome to chat-recall
          </div>
          <h1 style={{ fontFamily: 'var(--cr-font-display)', fontWeight: 700, fontSize: 26, margin: '0 0 6px', letterSpacing: '-0.01em' }}>
            Let’s get your first machine connected
          </h1>
          <div style={{ color: 'var(--cr-fg-2)', fontSize: 13, marginBottom: 20 }}>
            Nothing is synced yet — this dashboard lights up the moment your session history arrives.
          </div>
          <ConnectMachine compact onFirstData={() => getStatus().then((s) => setStatus(s as any)).catch(() => {})} />
        </div>
      </div>
    );
  }

  return (
    <div className="cr-cmd" style={{ flex: 1, overflow: 'auto', padding: '28px 32px 64px' }}>
      {syncAlert && (
        <div role="alert" style={{
          marginBottom: 18, padding: '12px 16px', borderRadius: 'var(--cr-radius-md, 8px)',
          border: '1px solid var(--cr-err-500)', background: 'var(--cr-err-surf, #2a1215)',
          color: 'var(--cr-fg-1)', fontSize: 13, lineHeight: 1.55,
        }}>
          {syncAlert.kind === 'no-device' ? (
            <>
              <strong style={{ color: 'var(--cr-err-500)' }}>Nothing can sync to this workspace</strong> — it has data
              but no active device token (all revoked?). Reconnect your machine:{' '}
              <code>chat-recall login {window.location.origin}</code>{' '}
              <span style={{ color: 'var(--cr-fg-2)' }}>(or Account → Connect your machine)</span>
            </>
          ) : (
            <>
              <strong style={{ color: 'var(--cr-err-500)' }}>No new data for {syncAlert.ageH}h</strong> — a device token
              is active but nothing is arriving. On your machine, check:{' '}
              <code>chat-recall service status</code> · <code>chat-recall sync</code>
            </>
          )}
        </div>
      )}
      {/* Eyebrow + title */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontFamily: 'var(--cr-font-display)', fontSize: 10, letterSpacing: '0.32em', textTransform: 'uppercase', color: 'var(--cr-brand-500)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--cr-ok-500)', boxShadow: '0 0 8px var(--cr-ok-500)' }} /> command center
        </div>
        <h1 style={{ fontFamily: 'var(--cr-font-display)', fontWeight: 700, fontSize: 26, margin: '8px 0 0', letterSpacing: '-0.01em' }}>Everything you’re building, at a glance</h1>
        <div style={{ color: 'var(--cr-fg-2)', fontSize: 13, marginTop: 4 }}>How you build × what you build — with the next move on every signal.</div>
      </div>

      {/* Hero metric strip. No "avg health": averaging N repos into one
          number hides the one that's on fire and moves for reasons you
          can't act on — the Code health panel below ranks per-project. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 22 }}>
        <Metric label="Projects" value={loading ? '—' : String(projects.length)} onClick={() => setView('projects')} />
        <Metric label="Critical findings" value={loading ? '—' : String(criticals)} tone={criticals > 0 ? 'err' : 'ok'} onClick={() => setView('projects')} />
        <Metric label="Hotspots" value={loading ? '—' : String(hotspots)} onClick={() => setView('projects')} />
        <Metric label="Leaked secrets" value={loading ? '—' : String(leaked)} tone={leaked > 0 ? 'err' : 'ok'} onClick={() => setView('security')} />
        <Metric
          label={syncTick?.arriving ? 'Sessions · syncing…' : 'Sessions'}
          value={syncTick ? String(syncTick.sessions) : status?.totalSessions != null ? String(status.totalSessions) : '—'}
          onClick={() => setView('search')}
        />
      </div>

      <div className="cr-stack-mobile" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
        {/* Left: this week's story + recommendations + code health */}
        <div style={{ display: 'grid', gap: 16 }}>
          <Panel title="Last 7 days" hint="what actually happened" action={() => setView('search')}>
            <WeekStrip />
          </Panel>
          <Panel title="Recommendations" hint="behaviour × code" action={recs.length ? undefined : null}>
            {recs.length === 0 ? <Empty>No recommendations right now — clean signals.</Empty> : recs.slice(0, 4).map((r) => (
              <RecRow key={r.id} rec={r} />
            ))}
          </Panel>
          <Panel title="Code health" hint={`${projects.length} project(s)`} action={() => setView('projects')}>
            {projects.length === 0 ? (
              <Empty>No repos indexed yet — the watch daemon picks them up as you work, or run <code>chat-recall code index</code>.</Empty>
            ) : projects.slice(0, 6).map((p) => <ProjectRow key={p.projectId} p={p} onOpen={() => onOpenProject(p.projectId)} />)}
          </Panel>
        </div>

        {/* Right: coverage + security + jump-offs */}
        <div style={{ display: 'grid', gap: 16 }}>
          <Panel title="What's synced" hint="coverage by tool · type · project" action={() => setView('search')}>
            <SyncCoverage />
          </Panel>
          <Panel title="Sync rules" hint="what never leaves your machines" action={null}>
            <SyncRules />
          </Panel>
          <Panel title="Security" hint="leaked secrets" action={() => setView('security')}>
            {leaked === 0 ? <Empty>No leaked secrets detected.</Empty> : (
              <div>
                <div style={{ fontFamily: 'var(--cr-font-display)', fontSize: 30, fontWeight: 700, color: 'var(--cr-err-500)', lineHeight: 1 }}>{leaked}</div>
                <div style={{ color: 'var(--cr-fg-2)', fontSize: 13, marginTop: 6 }}>secret(s) across {secrets?.sessionsWithFindings ?? 0} session(s)</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                  {(secrets?.topRules || []).slice(0, 5).map((r) => <Chip key={r.rule} kind="err" size="sm">{r.rule} · {r.n}</Chip>)}
                </div>
                <Button variant="secondary" onClick={() => setView('security')} style={{ marginTop: 12 }}>Review &amp; remediate</Button>
              </div>
            )}
          </Panel>
          <Panel title="Jump in" hint="">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[['projects', 'Projects', 'folder'], ['search', 'Conversations', 'message'], ['memory', 'Memory', 'brain'], ['security', 'Security', 'check'], ['toolkit', 'Toolkit', 'terminal'], ['dashboard', 'Insights', 'chart']].map(([v, label, icon]) => (
                <button key={v} onClick={() => setView(v)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 'var(--cr-radius-md)', border: '1px solid var(--cr-line-1)', background: 'var(--cr-ink-1)', color: 'var(--cr-fg-1)', cursor: 'pointer', fontSize: 13 }}>
                  <Icon name={icon} size={15} /> {label}
                </button>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, suffix, tone = 'neutral', onClick }: { label: string; value: string; suffix?: string; tone?: 'neutral' | 'ok' | 'warn' | 'err'; onClick?: () => void }) {
  const color = tone === 'ok' ? 'var(--cr-ok-500)' : tone === 'warn' ? 'var(--cr-warn-500)' : tone === 'err' ? 'var(--cr-err-500)' : 'var(--cr-fg-1)';
  return (
    <Card interactive={!!onClick} onClick={onClick} style={{ padding: '14px 16px', cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ fontFamily: 'var(--cr-font-display)', fontSize: 26, fontWeight: 700, color, lineHeight: 1, letterSpacing: '-0.02em' }}>{value}<span style={{ fontSize: 13, color: 'var(--cr-fg-3)' }}>{suffix}</span></div>
      <div style={{ fontFamily: 'var(--cr-font-display)', fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--cr-fg-3)', marginTop: 8 }}>{label}</div>
    </Card>
  );
}

function Panel({ title, hint, action, children }: { title: string; hint?: string; action?: (() => void) | null; children: React.ReactNode }) {
  return (
    <Card style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontFamily: 'var(--cr-font-display)', fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--cr-fg-2)' }}>{title}{hint ? <span style={{ color: 'var(--cr-fg-3)', marginLeft: 8 }}>{hint}</span> : null}</span>
        {action ? <button onClick={action} style={{ background: 'none', border: 'none', color: 'var(--cr-brand-500)', cursor: 'pointer', fontSize: 12 }}>view all →</button> : null}
      </div>
      {children}
    </Card>
  );
}

function ProjectRow({ p, onOpen }: { p: CodeProject; onOpen: () => void }) {
  const s = p.health?.score ?? 0;
  const tone = s >= 70 ? 'var(--cr-ok-500)' : s >= 40 ? 'var(--cr-warn-500)' : 'var(--cr-err-500)';
  return (
    <div {...pressableProps(onOpen)} aria-label={`Open project ${p.projectId.replace(/^git:/, '')}`} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', cursor: 'pointer', borderBottom: '1px solid var(--cr-line-1)' }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="mono" style={{ fontSize: 12, color: 'var(--cr-fg-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.projectId.replace(/^git:/, '')}</div>
        <div style={{ height: 4, background: 'var(--cr-line-1)', borderRadius: 2, marginTop: 5, width: '100%' }}>
          <div style={{ height: '100%', width: `${s}%`, background: tone, borderRadius: 2 }} />
        </div>
      </div>
      <span style={{ fontFamily: 'var(--cr-font-display)', fontSize: 14, fontWeight: 700, color: tone }}>{s}</span>
      {p.health?.critical ? <Chip kind="err" size="sm">{p.health.critical}C</Chip> : null}
    </div>
  );
}

function RecRow({ rec }: { rec: CodeRecommendation }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const apply = async () => { setBusy(true); const r = await applyAccountRecommendation(rec.id); setMsg(r.message || (r.ok ? 'queued' : 'failed')); setBusy(false); };
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--cr-line-1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Chip kind={rec.severity === 'high' ? 'err' : rec.severity === 'medium' ? 'warn' : 'neutral'} size="sm">{rec.severity}</Chip>
        <strong style={{ fontSize: 13 }}>{rec.title}</strong>
      </div>
      <div style={{ color: 'var(--cr-fg-2)', fontSize: 12, marginBottom: 8 }}>{rec.rationale}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button variant="primary" onClick={apply} disabled={busy}>{busy ? 'applying…' : rec.action.type === 'append_claude_md' ? 'Apply rule' : 'Apply'}</Button>
        {msg && <span style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>{msg}</span>}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ color: 'var(--cr-fg-3)', fontSize: 13, padding: '6px 0' }}>{children}</div>;
}

// ── This-week activity strip ─────────────────────────────────────────────
//
// Per-day stacked mini bars of session outcomes + labeled totals. Status
// colors sit in the CVD floor band (red↔green ΔE ~8), so identity is NEVER
// color-alone: every lane is direct-labeled with name+count in the totals
// row, stacked segments keep a 2px surface gap, and each day bar carries a
// full text breakdown tooltip.

type WeekLane = 'shipped' | 'interrupted' | 'in_progress' | 'abandoned' | 'discussion';

/** Fixed stack order (bottom → top) — color follows the lane, never rank. */
const WEEK_LANES: Array<{ lane: WeekLane; label: string; color: string }> = [
  { lane: 'shipped',     label: 'shipped',     color: 'var(--cr-ok-500)' },
  { lane: 'interrupted', label: 'interrupted', color: 'var(--cr-warn-500)' },
  { lane: 'in_progress', label: 'in progress', color: 'var(--cr-info-500)' },
  { lane: 'abandoned',   label: 'abandoned',   color: 'var(--cr-err-500)' },
  { lane: 'discussion',  label: 'discussions', color: 'var(--cr-fg-3)' },
];

function toLane(status: OutcomeDayRow['status']): WeekLane {
  if (status === 'shipped' || status === 'interrupted' || status === 'in_progress' || status === 'abandoned') return status;
  return 'discussion'; // 'unknown' (no edits, no commits) and rare 'completed'
}

function WeekStrip() {
  const [rows, setRows] = useState<OutcomeDayRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let on = true;
    getOutcomeSummary(7)
      .then((r) => { if (on) setRows(r.rows); })
      .catch(() => { if (on) { setRows([]); setFailed(true); } });
    return () => { on = false; };
  }, []);

  if (rows === null) return <Empty>Loading activity…</Empty>;
  if (failed) return <Empty>Activity unavailable right now.</Empty>;

  // Last 7 UTC days, oldest first — matches the server's UTC day buckets.
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  }

  const byDay = new Map<string, Map<WeekLane, number>>();
  const laneTotals = new Map<WeekLane, number>();
  let linesAdded = 0, linesRemoved = 0, commits = 0, total = 0;
  for (const r of rows) {
    const lane = toLane(r.status);
    const m = byDay.get(r.day) ?? new Map<WeekLane, number>();
    m.set(lane, (m.get(lane) ?? 0) + r.sessions);
    byDay.set(r.day, m);
    laneTotals.set(lane, (laneTotals.get(lane) ?? 0) + r.sessions);
    linesAdded += r.linesAdded; linesRemoved += r.linesRemoved; commits += r.commits;
    total += r.sessions;
  }

  if (total === 0) return <Empty>No sessions in the last 7 days.</Empty>;

  // Bars show CODE WORK only. Talk-only sessions outnumber code sessions
  // ~50:1 here, so putting the discussion lane in the stack turns every bar
  // into a gray monolith and crushes the shipped/abandoned story — the thing
  // this panel exists to show. Discussions stay in the legend and the
  // per-day tooltip as text.
  const barLanes = WEEK_LANES.filter(({ lane }) => lane !== 'discussion');
  const codeDayTotal = (d: string): number => {
    const m = byDay.get(d);
    return m ? barLanes.reduce((a, { lane }) => a + (m.get(lane) ?? 0), 0) : 0;
  };
  const maxDay = Math.max(1, ...days.map(codeDayTotal));
  const BAR_AREA = 64; // px height of the tallest day

  return (
    <div data-testid="week-strip">
      {/* Labeled totals — the legend. Name + count next to each colored dot
          so lane identity never rests on color alone. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginBottom: 12, fontSize: 12 }}>
        {WEEK_LANES.filter(({ lane }) => (laneTotals.get(lane) ?? 0) > 0).map(({ lane, label, color }) => (
          <span key={lane} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--cr-fg-2)' }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
            <strong style={{ color: 'var(--cr-fg-1)', fontVariantNumeric: 'tabular-nums' }}>{laneTotals.get(lane)}</strong> {label}
          </span>
        ))}
      </div>

      {/* Per-day stacked bars, oldest → newest. */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: BAR_AREA + 18 }}>
        {days.map((d) => {
          const m = byDay.get(d);
          const allDayTotal = m ? [...m.values()].reduce((a, b) => a + b, 0) : 0;
          const breakdown = WEEK_LANES
            .filter(({ lane }) => (m?.get(lane) ?? 0) > 0)
            .map(({ lane, label }) => `${m!.get(lane)} ${label}`)
            .join(' · ');
          const weekday = new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
          return (
            <div key={d} title={`${d} — ${allDayTotal ? breakdown : 'no sessions'}`}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', minWidth: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column-reverse' }}>
                {barLanes.map(({ lane, color }) => {
                  const n = m?.get(lane) ?? 0;
                  if (n === 0) return null;
                  return (
                    <div key={lane} style={{
                      height: Math.max(3, Math.round((n / maxDay) * BAR_AREA)),
                      background: color,
                      borderRadius: 2,
                      marginTop: 2, // the 2px surface gap between stacked segments
                    }} />
                  );
                })}
              </div>
              <div style={{ fontSize: 9, color: 'var(--cr-fg-3)', textAlign: 'center', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {weekday}
              </div>
            </div>
          );
        })}
      </div>

      {/* The week's output in one line. */}
      <div style={{ marginTop: 10, fontSize: 12, color: 'var(--cr-fg-2)', fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ color: 'var(--cr-ok-500)' }}>+{linesAdded.toLocaleString()}</span>
        {' / '}
        <span style={{ color: 'var(--cr-err-500)' }}>−{linesRemoved.toLocaleString()}</span>
        {' lines · '}
        <strong style={{ color: 'var(--cr-fg-1)' }}>{commits.toLocaleString()}</strong> commits landed
        {' · '}{total.toLocaleString()} sessions
      </div>
    </div>
  );
}
