/**
 * ProjectWorkspace — mission control for one repo.
 *
 * Opening a project lands on a single command surface (Overview): its state,
 * THE PLAN (ranked tasks with paste-ready agent prompts), NEXT MOVES
 * (behaviour×code recommendations), and the two graphs that explain it (code
 * dependency structure + the temporal knowledge graph). Lenses go deep —
 * Code (the full dashboard), Conversations (INLINE + scoped to this repo),
 * Activity, Security, Knowledge — all scoped to the same project. Everything
 * reuses the existing components; nothing is bolted on.
 */

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Card, Chip, SegmentedControl, Button, Icon } from './primitives';
import CodeExplorer, {
  DependencyMap, ActionList, RecommendationsView, Drawer, TasksDrawer,
  PRI_CHIP, PRI_LABEL, type DrawerContent,
} from './CodeExplorer';
import KnowledgeGraph from './KnowledgeGraph';
import ActivityTimeline from './ActivityTimeline';
import ConversationList from './ConversationList';
import ConversationViewer from './ConversationViewer';
import { useCodeProject, type UseCodeProject } from '../hooks/useCodeProject';
import { useConversation, type UseConversation } from '../hooks/useConversation';
import {
  getRecentSessionsPage, patchCodeAction,
  type CodeProject, type CodeAction, type SessionInfo,
} from '../services/api';

type Lens = 'overview' | 'code' | 'conversations' | 'activity' | 'knowledge';

const LENSES: Array<{ value: Lens; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'code', label: 'Code' },
  { value: 'conversations', label: 'Conversations' },
  { value: 'activity', label: 'Activity' },
  { value: 'knowledge', label: 'Knowledge' },
];

export default function ProjectWorkspace({
  projectId, projectName, toolFilter, onBack,
}: {
  projectId: string;
  projectName: string;
  toolFilter: string;
  /** Unused now — conversations open inline. Kept optional for the App call site. */
  onOpenSession?: (sessionId: string) => void;
  onBack: () => void;
}) {
  const [lens, setLens] = useState<Lens>('overview');
  useEffect(() => { setLens('overview'); }, [projectId]);
  const kgEntity = useMemo(() => projectName.split('/').pop() || projectName, [projectName]);

  const code = useCodeProject(projectId);
  // One conversation instance for the whole workspace — the Conversations lens
  // AND Activity both open sessions into it, INLINE, never leaving the project.
  const conv = useConversation();
  const openInline = useCallback((sid: string, info?: SessionInfo | null) => { conv.open(sid, info ?? null); setLens('conversations'); }, [conv]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ProjectHeader projectName={projectName} code={code} onBack={onBack} />
      <div style={{ padding: '0 24px', flexShrink: 0, borderBottom: '1px solid var(--cr-line-1)' }}>
        <SegmentedControl value={lens} onChange={(v) => setLens(v as Lens)} options={LENSES} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {lens === 'overview' && <MissionControl projectId={projectId} kgEntity={kgEntity} code={code} onJump={setLens} />}
        {lens === 'code' && <CodeExplorer projectFilter={projectId} embedded />}
        {lens === 'conversations' && <ConversationsLens projectId={projectId} toolFilter={toolFilter} conv={conv} />}
        {lens === 'activity' && (
          <ActivityTimeline onSessionClick={openInline} toolFilter={toolFilter} projectFilter={projectId} onActiveProjects={() => {}} />
        )}
        {lens === 'knowledge' && <KnowledgeGraph entity={kgEntity} embedded />}
      </div>
    </div>
  );
}

// ── Header: identity + state-at-a-glance ────────────────────────────────────
function ProjectHeader({ projectName, code, onBack }: { projectName: string; code: UseCodeProject; onBack: () => void }) {
  const h = code.project?.health;
  const b = code.behavior;
  const score = h?.score ?? null;
  const tone = score == null ? 'var(--cr-fg-3)' : score >= 70 ? 'var(--cr-ok-500)' : score >= 40 ? 'var(--cr-warn-500)' : 'var(--cr-err-500)';
  return (
    <div style={{ padding: '16px 24px 12px', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button onClick={onBack} title="Back to overview" style={{ background: 'none', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-sm)', color: 'var(--cr-fg-2)', cursor: 'pointer', padding: '4px 8px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
          <Icon name="chevronLeft" size={14} /> Overview
        </button>
        <Icon name="folder" size={18} />
        <h2 className="mono" style={{ margin: 0, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 }}>{projectName}</h2>
        {/* State-at-a-glance signal strip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
          {score != null && (
            <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
              <span style={{ fontFamily: 'var(--cr-font-display)', fontSize: 20, fontWeight: 700, color: tone, lineHeight: 1 }}>{score}</span>
              <span style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>/100 health</span>
            </span>
          )}
          {h && h.critical > 0 && <Chip kind="err" size="sm">{h.critical} critical</Chip>}
          {h && h.hotspots > 0 && <Chip kind="warn" size="sm">{h.hotspots} hotspots</Chip>}
          {b && b.totalSessions > 0 && <Chip kind={b.failedOrAbandoned / b.totalSessions >= 0.3 ? 'err' : 'neutral'} size="sm">{b.totalSessions} sessions · {b.failedOrAbandoned} unresolved</Chip>}
          {code.project && <span style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>indexed {fmtAgo(code.project.lastIndexedAt)}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Overview = the command surface ──────────────────────────────────────────
function MissionControl({ projectId, kgEntity, code, onJump }: { projectId: string; kgEntity: string; code: UseCodeProject; onJump: (l: Lens) => void }) {
  const { project, recs, actions, behavior, reload } = code;
  const [drawer, setDrawer] = useState<DrawerContent | null>(null);
  const [tasksOpen, setTasksOpen] = useState(false);
  const queuedIds = useMemo(() => new Set(actions.filter((a) => a.queued).map((a) => a.id)), [actions]);

  const openAction = (a: CodeAction) => setDrawer({
    kind: 'task', title: a.title, why: a.fix, prompt: a.agentPrompt, actionId: a.id,
    loc: a.loc?.map((l) => `${l.file}${l.line ? ':' + l.line : ''}`).join(' · '),
    chip: <Chip kind={PRI_CHIP[a.pri] ?? 'neutral'} size="sm">{PRI_LABEL[a.pri] ?? 'P?'}</Chip>,
  });
  const addToTasks = async () => { if (drawer?.actionId) { await patchCodeAction(drawer.actionId, { status: 'queued', queued: true }); reload(); } };
  const markDone = async () => { if (drawer?.actionId) { await patchCodeAction(drawer.actionId, { status: 'done', queued: false }); reload(); setDrawer(null); } };

  if (code.loading && !project) return <div style={{ padding: 30, color: 'var(--cr-fg-3)' }}>Loading project…</div>;

  return (
    <div style={{ padding: '18px 24px 60px', display: 'grid', gap: 16 }}>
      {!project ? (
        <Card style={{ padding: 20 }}>
          <strong>No code intelligence for this repo yet.</strong>
          <div style={{ color: 'var(--cr-fg-2)', fontSize: 13, marginTop: 6 }}>
            The watch daemon indexes repos as you work, or run <code>chat-recall code index</code> from the repo. Conversations, activity and knowledge are still available in their lenses.
          </div>
        </Card>
      ) : (
        <>
          {/* THE PLAN + NEXT MOVES */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
            <Card style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <strong style={{ fontSize: 13 }}>The plan <span style={{ color: 'var(--cr-fg-3)', fontWeight: 400 }}>ranked · paste-ready prompts</span></strong>
                <button onClick={() => setTasksOpen(true)} data-testid="tasks-pill" style={{ cursor: 'pointer', borderRadius: 999, padding: '4px 12px', border: '1px solid var(--cr-brand-500)', background: 'var(--cr-brand-surf, transparent)', color: 'var(--cr-brand-500)', fontWeight: 600, fontSize: 12 }}>▸ tasks · {queuedIds.size}</button>
              </div>
              <ActionList actions={actions} onOpen={openAction} queuedIds={queuedIds} />
            </Card>
            <Card style={{ padding: 16 }}>
              <strong style={{ fontSize: 13, display: 'block', marginBottom: 10 }}>Next moves <span style={{ color: 'var(--cr-fg-3)', fontWeight: 400 }}>behaviour × code</span></strong>
              <RecommendationsView recs={recs} projectId={project.projectId} onApplied={reload} />
            </Card>
          </div>

          {/* THE TWO GRAPHS */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))', gap: 16 }}>
            <Card style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <strong style={{ fontSize: 13 }}>Dependency graph <span style={{ color: 'var(--cr-fg-3)', fontWeight: 400 }}>code structure</span></strong>
                <button onClick={() => onJump('code')} style={{ background: 'none', border: 'none', color: 'var(--cr-brand-500)', cursor: 'pointer', fontSize: 12 }}>explore →</button>
              </div>
              <DependencyMap map={project.map} />
            </Card>
            <Card style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <strong style={{ fontSize: 13 }}>Knowledge graph <span style={{ color: 'var(--cr-fg-3)', fontWeight: 400 }}>decisions · tools</span></strong>
                <button onClick={() => onJump('knowledge')} style={{ background: 'none', border: 'none', color: 'var(--cr-brand-500)', cursor: 'pointer', fontSize: 12 }}>open →</button>
              </div>
              <KnowledgeGraph entity={kgEntity} embedded />
            </Card>
          </div>
        </>
      )}

      {drawer && <Drawer content={drawer} onClose={() => setDrawer(null)} onAddTask={addToTasks} onDone={markDone} />}
      {tasksOpen && project && (
        <TasksDrawer name={project.projectId} projectId={project.projectId} queuedActions={actions.filter((a) => a.queued)} queued={[]} onClose={() => setTasksOpen(false)} />
      )}
    </div>
  );
}

// ── Conversations lens: project-scoped master + INLINE viewer ────────────────
function ConversationsLens({ projectId, toolFilter, conv }: { projectId: string; toolFilter: string; conv: UseConversation }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sort, setSort] = useState('recent');

  useEffect(() => {
    let on = true; setLoading(true);
    getRecentSessionsPage({ limit: 30, offset: 0, projectFilter: projectId, toolFilter: toolFilter === 'all' ? undefined : toolFilter })
      .then((p) => { if (!on) return; setSessions(p.sessions); setTotal(p.total); setHasMore(p.hasMore); setLoading(false); });
    return () => { on = false; };
  }, [projectId, toolFilter]);

  const loadMore = useCallback(() => {
    setLoadingMore(true);
    getRecentSessionsPage({ limit: 30, offset: sessions.length, projectFilter: projectId, toolFilter: toolFilter === 'all' ? undefined : toolFilter })
      .then((p) => { setSessions((prev) => { const seen = new Set(prev.map((s) => s.sessionId)); return [...prev, ...p.sessions.filter((s) => !seen.has(s.sessionId))]; }); setHasMore(p.hasMore); setLoadingMore(false); });
  }, [sessions.length, projectId, toolFilter]);

  const onSelect = (sid: string) => conv.open(sid, sessions.find((s) => s.sessionId === sid) || null);

  return (
    <div className="cr-split" style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ width: 'var(--cr-convos-w, 360px)', flexShrink: 0, borderRight: '1px solid var(--cr-line-1)', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ConversationList
          results={sessions}
          selected={conv.sessionId}
          onSelect={onSelect}
          sort={sort}
          setSort={setSort}
          hasMore={hasMore}
          loadingMore={loadingMore}
          total={total}
          onLoadMore={loadMore}
          loading={loading}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        {conv.sessionId ? (
          <ConversationViewer
            selectionNonce={conv.selectionNonce}
            totalMessages={conv.total}
            hasMoreMessages={conv.hasMore}
            onLoadMoreMessages={conv.loadMore}
            sessionId={conv.sessionId}
            messages={conv.messages}
            subagents={conv.subagents}
            loading={conv.loading}
            onClose={conv.close}
            onLoadFull={conv.loadFull}
            searchResult={null}
            sessionInfo={conv.sessionInfo}
          />
        ) : (
          <div style={{ padding: 40, color: 'var(--cr-fg-3)', textAlign: 'center' }}>
            {sessions.length ? `${total} session(s) for this project — pick one to read it here.` : 'No sessions recorded for this project.'}
          </div>
        )}
      </div>
    </div>
  );
}

function fmtAgo(ms?: number): string {
  if (!ms) return '—';
  const d = Date.now() - ms;
  if (d < 3_600_000) return `${Math.max(1, Math.round(d / 60_000))}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}
