/**
 * ProjectWorkspace — the project-centric spine.
 *
 * A project is ONE place: its health/recommendations (Pulse), its code
 * intelligence (Code), its sessions (Conversations), its knowledge-graph
 * facts (Knowledge), and its file activity (Activity) — all scoped to the
 * same repo. This is the fix for "Code is a parallel universe": how-you-build
 * (sessions/behaviour) and what-you-build (code health) finally meet per repo.
 *
 * Keyed by the conversation project_id (the sidebar tree's filter). CodeExplorer
 * and ActivityTimeline already accept that filter; KnowledgeGraph focuses on the
 * project's entity name; the conversation list jumps into the global viewer.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Card, Chip, SegmentedControl, MetricCard, Button, Icon } from './primitives';
import CodeExplorer from './CodeExplorer';
import ActivityTimeline from './ActivityTimeline';
import KnowledgeGraph from './KnowledgeGraph';
import {
  getCodeProjects, getCodeRecommendations, applyCodeRecommendation,
  getRecentSessionsPage,
  type CodeProject, type CodeRecommendation, type SessionInfo,
} from '../services/api';

type WsTab = 'pulse' | 'code' | 'conversations' | 'knowledge' | 'activity';

const REC_CHIP: Record<string, 'err' | 'warn' | 'neutral'> = { high: 'err', medium: 'warn', low: 'neutral' };

export default function ProjectWorkspace({
  projectId, projectName, toolFilter, onOpenSession, onBack,
}: {
  projectId: string;
  projectName: string;
  toolFilter: string;
  onOpenSession: (sessionId: string) => void;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<WsTab>('pulse');
  // Reset to Pulse when the selected project changes.
  useEffect(() => { setTab('pulse'); }, [projectId]);

  // The KG entity is the project's short name (matches entity-extractor's
  // project naming: the leaf path segment).
  const kgEntity = useMemo(() => projectName.split('/').pop() || projectName, [projectName]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Workspace header */}
      <div style={{ padding: '16px 24px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <button onClick={onBack} title="Back to overview" style={{ background: 'none', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-sm)', color: 'var(--cr-fg-2)', cursor: 'pointer', padding: '4px 8px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            <Icon name="chevronLeft" size={14} /> Overview
          </button>
          <Icon name="folder" size={18} />
          <h2 className="mono" style={{ margin: 0, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{projectName}</h2>
        </div>
        <SegmentedControl
          value={tab}
          onChange={(v) => setTab(v as WsTab)}
          options={[
            { value: 'pulse', label: 'Pulse' },
            { value: 'code', label: 'Code' },
            { value: 'conversations', label: 'Conversations' },
            { value: 'knowledge', label: 'Knowledge' },
            { value: 'activity', label: 'Activity' },
          ]}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'pulse' && <PulseTab projectId={projectId} toolFilter={toolFilter} onOpenTab={setTab} onOpenSession={onOpenSession} />}
        {tab === 'code' && <CodeExplorer projectFilter={projectId} embedded />}
        {tab === 'conversations' && <ProjectConversations projectId={projectId} toolFilter={toolFilter} onOpenSession={onOpenSession} />}
        {tab === 'knowledge' && <KnowledgeGraph entity={kgEntity} embedded />}
        {tab === 'activity' && (
          <ActivityTimeline onSessionClick={onOpenSession} toolFilter={toolFilter} projectFilter={projectId} onActiveProjects={() => {}} />
        )}
      </div>
    </div>
  );
}

// ── Pulse: the per-repo synthesis (health × behaviour → next move) ──────────
function PulseTab({ projectId, toolFilter, onOpenTab, onOpenSession }: { projectId: string; toolFilter: string; onOpenTab: (t: WsTab) => void; onOpenSession: (s: string) => void }) {
  const [project, setProject] = useState<CodeProject | null>(null);
  const [recs, setRecs] = useState<CodeRecommendation[]>([]);
  const [behavior, setBehavior] = useState<{ failedOrAbandoned: number; totalSessions: number } | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState<string | null>(null);
  const [applied, setApplied] = useState<Record<string, string>>({});

  useEffect(() => {
    let on = true;
    setLoading(true);
    getCodeProjects().then((ps) => {
      if (!on) return;
      const match = ps.find((p) => p.projectId === projectId || p.rootPath.includes(projectId)) ?? null;
      setProject(match);
      if (match) {
        getCodeRecommendations(match.projectId).then((r) => { if (on) { setRecs(r.recommendations); setBehavior(r.behavior); } });
      }
      setLoading(false);
    });
    getRecentSessionsPage({ limit: 5, offset: 0, projectFilter: projectId, toolFilter: toolFilter === 'all' ? undefined : toolFilter })
      .then((p) => { if (on) setSessions(p.sessions); });
    return () => { on = false; };
  }, [projectId, toolFilter]);

  const apply = async (r: CodeRecommendation) => {
    if (!project) return;
    setApplying(r.id);
    const res = await applyCodeRecommendation(project.projectId, r.id);
    setApplied((m) => ({ ...m, [r.id]: res.message || (res.ok ? 'done' : 'failed') }));
    setApplying(null);
  };

  if (loading) return <div style={{ padding: 30, color: 'var(--cr-fg-3)' }}>Loading project pulse…</div>;

  const h = project?.health;
  return (
    <div style={{ padding: '18px 24px 56px', display: 'grid', gap: 16 }}>
      {!project ? (
        <Card style={{ padding: 20 }}>
          <strong>No code intelligence for this project yet.</strong>
          <div style={{ color: 'var(--cr-fg-2)', fontSize: 13, marginTop: 6 }}>
            The watch daemon indexes repos as you work, or run <code>chat-recall code index</code> from the repo. Conversations and activity are still available in their tabs.
          </div>
        </Card>
      ) : (
        <>
          {/* Hero metrics — every number is a door */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
            <div onClick={() => onOpenTab('code')} style={{ cursor: 'pointer' }}>
              <MetricCard label="Health" value={`${h?.score ?? 0}/100`} tone={(h?.score ?? 0) >= 70 ? 'ok' : (h?.score ?? 0) >= 40 ? 'neutral' : 'err'} icon="chart" />
            </div>
            <div onClick={() => onOpenTab('code')} style={{ cursor: 'pointer' }}>
              <MetricCard label="Critical" value={String(h?.critical ?? 0)} sub={`${h?.high ?? 0} high · ${h?.findings ?? 0} total`} tone={(h?.critical ?? 0) > 0 ? 'err' : 'ok'} icon="check" />
            </div>
            <div onClick={() => onOpenTab('code')} style={{ cursor: 'pointer' }}>
              <MetricCard label="Hotspots" value={String(h?.hotspots ?? 0)} sub="churn × complexity" icon="zap" />
            </div>
            <div onClick={() => onOpenTab('conversations')} style={{ cursor: 'pointer' }}>
              <MetricCard label="Sessions" value={behavior ? String(behavior.totalSessions) : '—'} sub={behavior ? `${behavior.failedOrAbandoned} unresolved` : 'none synced'} tone={behavior && behavior.totalSessions > 0 && behavior.failedOrAbandoned / behavior.totalSessions >= 0.3 ? 'err' : 'neutral'} icon="message" />
            </div>
            <div onClick={() => onOpenTab('code')} style={{ cursor: 'pointer' }}>
              <MetricCard label="AI-authored" value={`${Math.round((h?.aiAuthoredPct ?? 0) * 100)}%`} sub="of files" icon="sparkle" />
            </div>
          </div>

          {/* Next moves — the one authoritative recommendations list for this repo */}
          <Card style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <strong style={{ fontSize: 13 }}>Next moves <span style={{ color: 'var(--cr-fg-3)', fontWeight: 400 }}>behaviour × code</span></strong>
              {recs.length > 3 && <button onClick={() => onOpenTab('code')} style={{ background: 'none', border: 'none', color: 'var(--cr-brand-500)', cursor: 'pointer', fontSize: 12 }}>all {recs.length} →</button>}
            </div>
            {recs.length === 0 ? (
              <div style={{ color: 'var(--cr-fg-3)', fontSize: 13 }}>No recommendations — clean signals, or not enough behavioural data yet.</div>
            ) : recs.slice(0, 3).map((r) => (
              <div key={r.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--cr-line-1)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Chip kind={REC_CHIP[r.severity] ?? 'neutral'} size="sm">{r.severity}</Chip>
                  <strong style={{ fontSize: 13 }}>{r.title}</strong>
                  <Chip kind="mono" size="sm">{r.kind}</Chip>
                </div>
                <div style={{ color: 'var(--cr-fg-2)', fontSize: 12, marginBottom: 8 }}>{r.rationale}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Button variant="primary" onClick={() => apply(r)} disabled={applying === r.id}>{applying === r.id ? 'applying…' : r.kind === 'label' ? 'Apply label' : r.kind === 'rule' ? 'Apply to CLAUDE.md' : 'Apply'}</Button>
                  {applied[r.id] && <span style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>{applied[r.id]}</span>}
                </div>
              </div>
            ))}
          </Card>

          {/* Recent sessions for this repo */}
          <Card style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <strong style={{ fontSize: 13 }}>Recent work here</strong>
              <button onClick={() => onOpenTab('conversations')} style={{ background: 'none', border: 'none', color: 'var(--cr-brand-500)', cursor: 'pointer', fontSize: 12 }}>all sessions →</button>
            </div>
            {sessions.length === 0 ? <div style={{ color: 'var(--cr-fg-3)', fontSize: 13 }}>No sessions for this project.</div>
              : sessions.map((s) => <SessionRow key={s.sessionId} s={s} onOpen={() => onOpenSession(s.sessionId)} />)}
          </Card>
        </>
      )}
    </div>
  );
}

function ProjectConversations({ projectId, toolFilter, onOpenSession }: { projectId: string; toolFilter: string; onOpenSession: (s: string) => void }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let on = true; setLoading(true);
    getRecentSessionsPage({ limit: 50, offset: 0, projectFilter: projectId, toolFilter: toolFilter === 'all' ? undefined : toolFilter })
      .then((p) => { if (on) { setSessions(p.sessions); setTotal(p.total); setLoading(false); } });
    return () => { on = false; };
  }, [projectId, toolFilter]);
  if (loading) return <div style={{ padding: 30, color: 'var(--cr-fg-3)' }}>Loading sessions…</div>;
  if (!sessions.length) return <div style={{ padding: 30, color: 'var(--cr-fg-3)', textAlign: 'center' }}>No sessions recorded for this project.</div>;
  return (
    <div style={{ padding: '16px 24px 48px' }}>
      <div style={{ color: 'var(--cr-fg-3)', fontSize: 12, marginBottom: 10 }}>{total} session(s) for this project</div>
      {sessions.map((s) => <SessionRow key={s.sessionId} s={s} onOpen={() => onOpenSession(s.sessionId)} />)}
    </div>
  );
}

function SessionRow({ s, onOpen }: { s: SessionInfo; onOpen: () => void }) {
  const title = (s as any).userTitle || (s as any).summary || (s as any).firstPrompt || s.sessionId;
  const when = (s as any).modified ? new Date((s as any).modified).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <Card interactive onClick={onOpen} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', marginBottom: 6, cursor: 'pointer' }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
      </div>
      {(s as any).gitBranch && <Chip kind="mono" size="sm">{(s as any).gitBranch}</Chip>}
      <span style={{ fontSize: 11, color: 'var(--cr-fg-3)', whiteSpace: 'nowrap' }}>{when}</span>
      <Icon name="chevronRight" size={15} style={{ opacity: 0.4 }} />
    </Card>
  );
}
