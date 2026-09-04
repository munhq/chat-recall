/**
 * Command Center — the unified, dashboard-first home for chat-recall.
 *
 * The restructure: instead of landing on a list of disconnected tabs, you land
 * on one helicopter view that fuses HOW you build (sessions/behaviour) and WHAT
 * you build (code health/findings) with the actionable recommendations that sit
 * at their intersection. Every row is a door — click through to the focused
 * view.
 *
 * This screen is drawn, not decorated. The signals are ONE SCHEDULE, not a row
 * of stat tiles: six equally-loud boxes with coloured top edges gave every
 * measurement the same weight and answered no question, and the coloured edge
 * is the card idiom this world exists to remove. Panels are PLATES that stack
 * flush, so a column of them reads as one drawn object. No eyebrows: the
 * heading carries itself.
 */

import React, { useEffect, useState } from 'react';
import { Chip, Button, Icon, Plate, Schedule, Note } from './primitives';
import ConnectMachine from './ConnectMachine';
import SyncCoverage from './SyncCoverage';
import SyncRules from './SyncRules';
import { staleSyncAlert } from '../services/sync-label';
import {
  getCodeProjects, getAccountRecommendations, applyAccountRecommendation, getSecretsSummary, getStatus, getSyncStatus, getOutcomeSummary,
  getMe, listDevices,
  type CodeProject, type CodeRecommendation, type SecretsSummary, type OutcomeDayRow,
} from '../services/api';

type Nav = (v: string) => void;

export default function CommandCenter({ setView, onOpenProject, onFocusProjects, cloud }: { setView: Nav; onOpenProject: (id: string) => void; onFocusProjects?: (emphasis: 'critical' | 'hotspots') => void; cloud?: boolean }) {
  const [projects, setProjects] = useState<CodeProject[]>([]);
  const [recs, setRecs] = useState<CodeRecommendation[]>([]);
  const [showAllRecs, setShowAllRecs] = useState(false);
  const [secrets, setSecrets] = useState<SecretsSummary | null>(null);
  const [status, setStatus] = useState<{ totalSessions?: number } | null>(null);
  const [loading, setLoading] = useState(true);

  // Dead-workspace detector (cloud): a workspace with synced data but ZERO
  // active device tokens can never receive another byte — say so at the top
  // of the home view, not buried in Account. (Live incident: a revoked token
  // left prod frozen at 7 conversations with no visible signal.) Secondary
  // signal: devices exist but the collector has not REPORTED for 48h — the
  // machine's watch service is probably down. Deliberately not "no new data
  // for 48h": that is what an idle fortnight looks like on a healthy install.
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
        else {
          // Gated on the SYNC age, not the session age. See services/sync-label:
          // the previous condition read newestSessionAgeMs, so an idle fortnight
          // produced a red "nothing is arriving" banner on a healthy install.
          const stale = staleSyncAlert(s, active.length);
          if (stale) setSyncAlert({ kind: 'stale', ageH: stale.ageH });
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
      <div className="cr-cmd cr-pad-mobile" style={{ flex: 1, overflow: 'auto', padding: '28px 32px 64px' }}>
        <div style={{ maxWidth: 680, margin: '40px auto 0' }}>
          <h1 style={{ margin: '0 0 8px' }}>Connect your first machine</h1>
          <div style={{ color: 'var(--cr-fg-2)', fontSize: 14, marginBottom: 20, lineHeight: 1.5 }}>
            Nothing is synced yet. This dashboard fills in the moment your session history arrives.
          </div>
          <ConnectMachine compact onFirstData={() => getStatus().then((s) => setStatus(s as any)).catch(() => {})} />
        </div>
      </div>
    );
  }

  return (
    <div className="cr-cmd cr-pad-mobile" style={{ flex: 1, overflow: 'auto', padding: '28px 32px 64px' }}>
      {syncAlert && (
        <Note
          style={{ marginBottom: 18, ['--cr-frame' as string]: 'var(--cr-err-500)' }}
          title={syncAlert.kind === 'no-device' ? 'Nothing can sync to this workspace' : `No sync for ${syncAlert.ageH} hours`}
          cmd={syncAlert.kind === 'no-device' ? `chat-recall login ${window.location.origin}` : 'chat-recall service status'}
          footer={
            syncAlert.kind === 'no-device'
              ? <>This workspace holds data but has no active device token. Run the command above on your machine, or open Account and connect it.</>
              : <>A device token is active but the collector has not reported. Check the service, then force a push with <code>chat-recall sync</code>.</>
          }
        />
      )}
      {/* No eyebrow. "COMMAND CENTER" above "Everything you're building" said
          nothing the heading did not, and the sidebar already names the view. */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, maxWidth: '24ch' }}>Everything you’re building</h1>
        <div style={{ color: 'var(--cr-fg-2)', fontSize: 14, marginTop: 10, maxWidth: '58ch', lineHeight: 1.5 }}>
          How you build and what you build, with the next move on every signal.
        </div>
      </div>

      {/* The signals, as one schedule. No "avg health": averaging N repos into
          one number hides the one that is on fire and moves for reasons you
          cannot act on — the Code health plate below ranks per-project.
          Every row is a door; the hue rides the VALUE, never a bar on an edge. */}
      <Schedule
        style={{ marginBottom: 24 }}
        caption="Signals"
        cols={[
          { key: 'name', kind: 'pn', head: 'Signal', width: '1%' },
          { key: 'what', head: 'What it counts' },
          { key: 'value', kind: 'val', head: 'Count' },
          { key: 'go', kind: 'cmd' },
        ]}
        rows={[
          { key: 'Projects', v: loading ? '—' : String(projects.length), tone: null, what: 'repositories chat-recall has indexed', go: () => setView('projects') },
          { key: 'Critical findings', v: loading ? '—' : String(criticals), tone: criticals > 0 ? 'var(--cr-err-500)' : 'var(--cr-ok-500)', what: 'across every indexed project', go: () => (onFocusProjects ? onFocusProjects('critical') : setView('projects')) },
          { key: 'Hotspots', v: loading ? '—' : String(hotspots), tone: null, what: 'files ranked by churn against complexity', go: () => (onFocusProjects ? onFocusProjects('hotspots') : setView('projects')) },
          { key: 'Leaked secrets', v: loading ? '—' : String(leaked), tone: leaked > 0 ? 'var(--cr-err-500)' : 'var(--cr-ok-500)', what: 'credentials found in transcripts, action required', go: () => setView('security') },
          { key: 'Sessions', v: syncTick ? String(syncTick.sessions) : status?.totalSessions != null ? String(status.totalSessions) : '—', tone: null, what: syncTick?.arriving ? 'synced to this workspace, more arriving now' : 'synced to this workspace', go: () => setView('search') },
        ].map((r) => ({
          id: r.key,
          onSelect: r.go,
          cells: {
            name: r.key,
            what: r.what,
            value: <span style={{ color: r.tone ?? 'var(--cr-fg-1)', fontSize: 15 }}>{r.v}</span>,
            go: <Icon name="arrowRight" size={14} />,
          },
        }))}
      />

      <div className="cr-stack-mobile" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr)', gap: 20, alignItems: 'start' }}>
        {/* Left: this week's story + recommendations + code health. Gap 0 —
            the plates share edges, which is what makes them a drawing rather
            than a stack of boxes. */}
        <div style={{ display: 'grid', gap: 0, minWidth: 0 }}>
          <Panel title="Last 7 days" hint="what actually happened" action={() => setView('search')}>
            <WeekStrip />
          </Panel>
          <Panel
            title="Recommendations"
            hint="behaviour and code"
            action={recs.length > 4 ? () => setShowAllRecs((v) => !v) : null}
            actionLabel={showAllRecs ? 'show less' : `view all ${recs.length}`}
          >
            {recs.length === 0 ? <Empty>No recommendations right now — clean signals.</Empty> : (showAllRecs ? recs : recs.slice(0, 4)).map((r) => (
              <RecRow key={r.id} rec={r} />
            ))}
          </Panel>
          <Panel title="Code health" hint={`${projects.length} project${projects.length === 1 ? '' : 's'}`} action={() => setView('projects')} flush>
            <Schedule
              cols={[
                { key: 'name', kind: 'pn' },
                { key: 'crit', kind: 'rt' },
                { key: 'score', kind: 'val' },
              ]}
              rows={projects.slice(0, 6).map((p) => {
                const score = p.health?.score ?? 0;
                // The hue rides the SCORE, which is the annotation. The old row
                // carried a coloured progress bar under the project name — a bar
                // on a box, and a chart standing in for one number.
                const tone = score >= 70 ? 'var(--cr-ok-500)' : score >= 40 ? 'var(--cr-warn-500)' : 'var(--cr-err-500)';
                return {
                  id: p.projectId,
                  onSelect: () => onOpenProject(p.projectId),
                  cells: {
                    name: <span className="mono" style={{ fontSize: 12.5, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.projectId.replace(/^git:/, '')}</span>,
                    crit: p.health?.critical ? <Chip kind="err" size="sm">{p.health.critical} critical</Chip> : null,
                    score: <span style={{ color: tone, fontSize: 15 }}>{score}</span>,
                  },
                };
              })}
              empty={<>No repositories indexed yet. The watch daemon picks them up as you work, or run <code>chat-recall code index</code>.</>}
            />
          </Panel>
        </div>

        {/* Right: coverage, sync rules, security */}
        <div style={{ display: 'grid', gap: 0, minWidth: 0 }}>
          <Panel title="What's synced" hint="by tool, type and project" action={() => setView('search')}>
            <SyncCoverage />
          </Panel>
          {/* Cloud puts Sync rules in Account (the settings surface); selfhost
              has no Account view, so home is its only place to live. */}
          {!cloud && (
            <Panel title="Sync rules" hint="what never leaves your machines" action={null}>
              <SyncRules />
            </Panel>
          )}
          <Panel title="Security" hint="leaked secrets" action={() => setView('security')}>
            {leaked === 0 ? <Empty>No leaked secrets detected.</Empty> : (
              <div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span className="cr-num" style={{ fontSize: 22, fontWeight: 700, color: 'var(--cr-err-500)', lineHeight: 1 }}>{leaked}</span>
                  <span style={{ color: 'var(--cr-fg-2)', fontSize: 13 }}>
                    {leaked === 1 ? 'secret' : 'secrets'} across {secrets?.sessionsWithFindings ?? 0} {secrets?.sessionsWithFindings === 1 ? 'session' : 'sessions'}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
                  {(secrets?.topRules || []).slice(0, 5).map((r) => <Chip key={r.rule} kind="err" size="sm">{r.rule} · {r.n}</Chip>)}
                </div>
                <Button variant="secondary" onClick={() => setView('security')} style={{ marginTop: 14 }}>Review and remediate</Button>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Panel({ title, hint, action, actionLabel = 'view all', flush, children }: { title: string; hint?: string; action?: (() => void) | null; actionLabel?: string; flush?: boolean; children: React.ReactNode }) {
  return (
    <Plate
      flush={flush}
      title={
        <>
          {title}
          {hint ? <span style={{ color: 'var(--cr-fg-3)', fontWeight: 400, marginLeft: 8, fontSize: 12.5 }}>{hint}</span> : null}
        </>
      }
      tools={
        action ? (
          <button
            onClick={action}
            className="cr-annot cr-annot-red"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            {actionLabel} <Icon name="arrowRight" size={12} />
          </button>
        ) : null
      }
    >
      {children}
    </Plate>
  );
}

function RecRow({ rec }: { rec: CodeRecommendation }) {
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    setBusy(true); setErr(false); setMsg('');
    try {
      const r = await applyAccountRecommendation(rec.id);
      setErr(!r.ok);
      setMsg(r.message || (r.ok ? 'queued' : 'failed'));
    } catch (e) {
      setErr(true);
      setMsg(e instanceof Error ? `failed: ${e.message}` : 'failed — try again');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--cr-line-1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Chip kind={rec.severity === 'high' ? 'err' : rec.severity === 'medium' ? 'warn' : 'neutral'} size="sm">{rec.severity}</Chip>
        <strong style={{ fontSize: 13 }}>{rec.title}</strong>
      </div>
      <div style={{ color: 'var(--cr-fg-2)', fontSize: 12, marginBottom: 8 }}>{rec.rationale}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button variant="primary" onClick={apply} disabled={busy}>{busy ? 'applying…' : rec.action.type === 'append_claude_md' ? 'Apply rule' : 'Apply'}</Button>
        {msg && <span style={{ fontSize: 12, color: err ? 'var(--cr-err-500)' : 'var(--cr-fg-2)' }}>{msg}</span>}
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
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 0, background: color, flexShrink: 0 }} />
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
                      borderRadius: 0,
                      marginTop: 2, // the 2px surface gap between stacked segments
                    }} />
                  );
                })}
              </div>
              {/* THE ANNOTATION FLOOR: this was 9px, which is not readable and
                  is not negotiable per-label. 12px is the minimum, everywhere. */}
              <div className="cr-annot" style={{ fontSize: 12, textAlign: 'center', marginTop: 6 }}>
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
