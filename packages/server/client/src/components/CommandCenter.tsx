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
import { Card, Chip, Button, Icon } from './primitives';
import ConnectMachine from './ConnectMachine';
import {
  getCodeProjects, getAccountRecommendations, applyAccountRecommendation, getSecretsSummary, getStatus,
  type CodeProject, type CodeRecommendation, type SecretsSummary,
} from '../services/api';

type Nav = (v: string) => void;

export default function CommandCenter({ setView, onOpenProject, cloud }: { setView: Nav; onOpenProject: (id: string) => void; cloud?: boolean }) {
  const [projects, setProjects] = useState<CodeProject[]>([]);
  const [recs, setRecs] = useState<CodeRecommendation[]>([]);
  const [secrets, setSecrets] = useState<SecretsSummary | null>(null);
  const [status, setStatus] = useState<{ totalSessions?: number } | null>(null);
  const [loading, setLoading] = useState(true);

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

  const avgHealth = projects.length ? Math.round(projects.reduce((a, p) => a + (p.health?.score ?? 0), 0) / projects.length) : null;
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
      {/* Eyebrow + title */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontFamily: 'var(--cr-font-display)', fontSize: 10, letterSpacing: '0.32em', textTransform: 'uppercase', color: 'var(--cr-brand-500)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--cr-ok-500)', boxShadow: '0 0 8px var(--cr-ok-500)' }} /> command center
        </div>
        <h1 style={{ fontFamily: 'var(--cr-font-display)', fontWeight: 700, fontSize: 26, margin: '8px 0 0', letterSpacing: '-0.01em' }}>Everything you’re building, at a glance</h1>
        <div style={{ color: 'var(--cr-fg-2)', fontSize: 13, marginTop: 4 }}>How you build × what you build — with the next move on every signal.</div>
      </div>

      {/* Hero metric strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 22 }}>
        <Metric label="Projects" value={loading ? '—' : String(projects.length)} onClick={() => setView('projects')} />
        <Metric label="Avg health" value={avgHealth == null ? '—' : `${avgHealth}`} suffix={avgHealth == null ? '' : '/100'} tone={avgHealth == null ? 'neutral' : avgHealth >= 70 ? 'ok' : avgHealth >= 40 ? 'warn' : 'err'} onClick={() => setView('projects')} />
        <Metric label="Critical findings" value={loading ? '—' : String(criticals)} tone={criticals > 0 ? 'err' : 'ok'} onClick={() => setView('projects')} />
        <Metric label="Hotspots" value={loading ? '—' : String(hotspots)} onClick={() => setView('projects')} />
        <Metric label="Leaked secrets" value={loading ? '—' : String(leaked)} tone={leaked > 0 ? 'err' : 'ok'} onClick={() => setView('security')} />
        <Metric label="Sessions" value={status?.totalSessions != null ? String(status.totalSessions) : '—'} onClick={() => setView('search')} />
      </div>

      <div className="cr-stack-mobile" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
        {/* Left: recommendations + code health */}
        <div style={{ display: 'grid', gap: 16 }}>
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

        {/* Right: security + jump-offs */}
        <div style={{ display: 'grid', gap: 16 }}>
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
    <div onClick={onOpen} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', cursor: 'pointer', borderBottom: '1px solid var(--cr-line-1)' }}>
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
