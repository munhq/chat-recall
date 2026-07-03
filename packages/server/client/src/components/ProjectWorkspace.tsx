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

import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Card, Chip, SegmentedControl, Button, Icon } from './primitives';
import { useUrlState } from '../services/url-state';
import CodeExplorer, { DependencyMap, PRI_CHIP, PRI_LABEL } from './CodeExplorer';
import KnowledgeGraph from './KnowledgeGraph';
import ConversationList from './ConversationList';
import ConversationViewer from './ConversationViewer';
import { useCodeProject, type UseCodeProject } from '../hooks/useCodeProject';
import { useConversation, type UseConversation } from '../hooks/useConversation';
import {
  getRecentSessionsPage, patchCodeAction, applyCodeRecommendation, getEditsTimeline,
  patchCodeProjectLabel,
  type CodeProject, type CodeAction, type CodeRecommendation, type SessionInfo, type EditRow,
} from '../services/api';

type Lens = 'overview' | 'code' | 'conversations' | 'activity' | 'knowledge';

const LENSES: Array<{ value: Lens; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'code', label: 'Code' },
  { value: 'conversations', label: 'Conversations' },
  { value: 'activity', label: 'Activity' },
  { value: 'knowledge', label: 'Knowledge' },
];

// Project labels drive the safety guidance the recommendations engine emits:
// POC → "OK to reset the db, move fast"; Production → "never drop/remove data";
// Engineering → "raise the bar on tests + review". This switch is the trigger,
// so it lives in the always-visible header — not buried in the Code lens.
const PROJECT_LABELS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'poc', label: 'POC', hint: 'Throwaway prototype — OK to reset the db and move fast' },
  { value: 'production', label: 'Production', hint: 'Live data — never drop/reset/remove without backup' },
  { value: 'engineering', label: 'Engineering', hint: 'Raise the bar: tests + review on every change' },
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
  // Lens is URL-backed (?lens=) so a project view is shareable/refresh-safe
  // ("munbot → Code"). replaceState (default) keeps lens flips out of history.
  const [lens, setLensRaw] = useUrlState('lens', 'overview', {
    valid: (v) => LENSES.some((l) => l.value === v),
    clearOnUnmount: true,
  });
  const setLens = setLensRaw as (l: Lens) => void;
  // Switching to a *different* project resets to Overview — but skip the first
  // render so a deep-linked ?lens= isn't clobbered on load.
  const firstLensRender = useRef(true);
  useEffect(() => {
    if (firstLensRender.current) { firstLensRender.current = false; return; }
    setLens('overview');
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const kgEntity = useMemo(() => projectName.split('/').pop() || projectName, [projectName]);

  const code = useCodeProject(projectId);
  // Canonical id: once code intel resolves, its projectId is the authoritative
  // resolveProjectId key — use it for sessions/activity so the count and the
  // list never disagree (was the "281 vs 2" bug). Falls back to the raw id.
  const canonicalId = code.project?.projectId ?? projectId;
  // One conversation instance for the whole workspace — the Conversations lens
  // AND Activity both open sessions into it, INLINE, never leaving the project.
  const conv = useConversation();
  const openInline = useCallback((sid: string, info?: SessionInfo | null) => { conv.open(sid, info ?? null); setLens('conversations'); }, [conv]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ProjectHeader projectName={projectName} code={code} onBack={onBack} />
      <div className="cr-lens-bar" style={{ padding: '8px 24px', flexShrink: 0, borderBottom: '1px solid var(--cr-line-1)', overflowX: 'auto' }}>
        <SegmentedControl value={lens} onChange={(v) => setLens(v as Lens)} options={LENSES} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {lens === 'overview' && <MissionControl canonicalId={canonicalId} kgEntity={kgEntity} toolFilter={toolFilter} code={code} onJump={setLens} onOpenSession={openInline} />}
        {lens === 'code' && <CodeExplorer projectFilter={canonicalId} embedded onSessionClick={openInline} />}
        {lens === 'conversations' && <ConversationsLens projectId={canonicalId} toolFilter={toolFilter} conv={conv} />}
        {lens === 'activity' && <ProjectActivity projectId={canonicalId} toolFilter={toolFilter} onOpenSession={openInline} />}
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
  const [labelBusy, setLabelBusy] = useState(false);
  const current = code.project?.label ?? null;
  // Toggle the label (clicking the active one clears it). Reload after so the
  // recommendations re-derive against the new label — POC/Production guidance
  // appears in "Do next" immediately.
  const setLabel = async (value: string) => {
    if (!code.project || labelBusy) return;
    const next = current === value ? null : value;
    setLabelBusy(true);
    const ok = await patchCodeProjectLabel(code.project.projectId, next);
    setLabelBusy(false);
    if (ok) code.reload();
  };
  return (
    <div style={{ padding: '16px 24px 12px', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button onClick={onBack} title="Back to overview" style={{ background: 'none', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-sm)', color: 'var(--cr-fg-2)', cursor: 'pointer', padding: '4px 8px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
          <Icon name="chevronLeft" size={14} /> Overview
        </button>
        <Icon name="folder" size={18} />
        <h2 className="mono" style={{ margin: 0, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 }}>{projectName}</h2>
        {/* Project label switch — drives the safety suggestions in "Do next" */}
        {code.project && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title="Classify this project so the AI gets the right guardrails">
            <span style={{ color: 'var(--cr-fg-3)', fontSize: 11 }}>label:</span>
            {PROJECT_LABELS.map((l) => (
              <button key={l.value} onClick={() => setLabel(l.value)} disabled={labelBusy} title={l.hint}
                style={{ cursor: labelBusy ? 'wait' : 'pointer', borderRadius: 999, padding: '3px 10px', fontSize: 11, border: '1px solid var(--cr-line-1)',
                  background: current === l.value ? 'var(--cr-brand-500)' : 'transparent',
                  color: current === l.value ? '#fff' : 'var(--cr-fg-2)' }}>{l.label}</button>
            ))}
          </div>
        )}
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

type ChipKind = 'neutral' | 'mono' | 'brand' | 'ok' | 'warn' | 'err' | 'info';

function SectionTitle({ title, hint, action, actionLabel }: { title: string; hint?: string; action?: () => void; actionLabel?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
      <span style={{ fontFamily: 'var(--cr-font-display)', fontSize: 11, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--cr-fg-2)' }}>
        {title}{hint ? <span style={{ color: 'var(--cr-fg-3)', marginLeft: 8, textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>{hint}</span> : null}
      </span>
      {action ? <button onClick={action} style={{ background: 'none', border: 'none', color: 'var(--cr-brand-500)', cursor: 'pointer', fontSize: 12 }}>{actionLabel || 'view all →'}</button> : null}
    </div>
  );
}

// ── Overview = the command surface: Do next → Understand → History ───────────
function MissionControl({ canonicalId, kgEntity, toolFilter, code, onJump, onOpenSession }: {
  canonicalId: string; kgEntity: string; toolFilter: string; code: UseCodeProject;
  onJump: (l: Lens) => void; onOpenSession: (sid: string, info?: SessionInfo | null) => void;
}) {
  const { project, recs, actions, loading, reload } = code;
  if (loading && !project) return <div style={{ padding: 30, color: 'var(--cr-fg-3)' }}>Loading project…</div>;
  const hasGraph = !!project?.map?.nodes?.length;
  return (
    <div style={{ padding: '18px 24px 60px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 22 }}>
      {/* 1 — DO NEXT: one ranked stream (fixes + rules + tasks) */}
      <section><DoNext recs={recs} actions={actions} projectId={project?.projectId ?? canonicalId} hasCode={!!project} onReload={reload} /></section>

      {/* 2 — UNDERSTAND: the two graphs, in place */}
      <section>
        <SectionTitle title="Understand" hint="how this repo is wired · what was decided" />
        <div style={{ display: 'grid', gridTemplateColumns: hasGraph ? 'repeat(auto-fit,minmax(380px,1fr))' : '1fr', gap: 16 }}>
          {hasGraph && (
            <Card style={{ padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <strong style={{ fontSize: 12 }}>Dependency graph <span style={{ color: 'var(--cr-fg-3)', fontWeight: 400 }}>scroll to zoom · drag to pan</span></strong>
                <button onClick={() => onJump('code')} style={{ background: 'none', border: 'none', color: 'var(--cr-brand-500)', cursor: 'pointer', fontSize: 12 }}>full →</button>
              </div>
              <DependencyMap map={project!.map} />
            </Card>
          )}
          <Card style={{ padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ fontSize: 12 }}>Knowledge graph <span style={{ color: 'var(--cr-fg-3)', fontWeight: 400 }}>decisions · tools</span></strong>
              <button onClick={() => onJump('knowledge')} style={{ background: 'none', border: 'none', color: 'var(--cr-brand-500)', cursor: 'pointer', fontSize: 12 }}>open →</button>
            </div>
            <KnowledgeGraph entity={kgEntity} embedded />
          </Card>
        </div>
      </section>

      {/* 3 — HISTORY: what happened here */}
      <section>
        <SectionTitle title="History" hint="recent work in this repo" action={() => onJump('activity')} actionLabel="full timeline →" />
        <ProjectHistory projectId={canonicalId} toolFilter={toolFilter} onOpenSession={onOpenSession} />
      </section>
    </div>
  );
}

// ── DO NEXT: recommendations (apply) + tasks (copy prompt / done), ranked ─────
interface DoItem { id: string; rank: number; badge: { label: string; kind: ChipKind }; tag: string; title: string; detail: string; rec?: CodeRecommendation; action?: CodeAction; }
function buildDoNext(recs: CodeRecommendation[], actions: CodeAction[]): DoItem[] {
  const out: DoItem[] = [];
  for (const r of recs) {
    out.push({ id: 'r_' + r.id, rank: r.severity === 'high' ? 0 : r.severity === 'medium' ? 2 : 4,
      badge: { label: r.severity, kind: r.severity === 'high' ? 'err' : r.severity === 'medium' ? 'warn' : 'neutral' },
      tag: r.kind, title: r.title, detail: r.rationale, rec: r });
  }
  for (const a of actions) {
    if (a.status === 'done' || a.status === 'dismissed') continue;
    out.push({ id: 'a_' + a.id, rank: a.pri === 0 ? 1 : a.pri === 1 ? 2 : a.pri === 2 ? 3 : 5,
      badge: { label: PRI_LABEL[a.pri] ?? 'P?', kind: PRI_CHIP[a.pri] ?? 'neutral' },
      tag: a.category, title: a.title, detail: a.fix, action: a });
  }
  return out.sort((x, y) => x.rank - y.rank);
}
function DoNext({ recs, actions, projectId, hasCode, onReload }: { recs: CodeRecommendation[]; actions: CodeAction[]; projectId: string; hasCode: boolean; onReload: () => void }) {
  const items = useMemo(() => buildDoNext(recs, actions), [recs, actions]);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, 7);
  return (
    <>
      <SectionTitle title="Do next" hint="fixes, rules & tasks — ranked, one action each" />
      <Card style={{ padding: 6 }}>
        {items.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--cr-fg-3)', fontSize: 13 }}>
            {hasCode ? 'Nothing queued — clean signals.' : <>This repo isn’t code-indexed yet. The watch daemon picks it up as you work, or run <code>chat-recall code index</code>.</>}
          </div>
        ) : (
          <>
            {shown.map((it) => <DoNextRow key={it.id} item={it} projectId={projectId} onReload={onReload} />)}
            {items.length > 7 && <button onClick={() => setShowAll(!showAll)} style={{ background: 'none', border: 'none', color: 'var(--cr-brand-500)', cursor: 'pointer', fontSize: 12, padding: '8px 10px' }}>{showAll ? 'show less' : `show all ${items.length} →`}</button>}
          </>
        )}
      </Card>
    </>
  );
}
function DoNextRow({ item, projectId, onReload }: { item: DoItem; projectId: string; onReload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const isRec = !!item.rec;
  const expandText = item.rec ? String((item.rec.action.payload as any)?.text || '') : (item.action?.agentPrompt || '');
  const apply = async () => { if (!item.rec) return; setBusy(true); const res = await applyCodeRecommendation(projectId, item.rec.id); setMsg(res.message || (res.ok ? 'done' : 'failed')); setBusy(false); if (res.applied) onReload(); };
  const copy = () => { if (item.action) { navigator.clipboard.writeText(item.action.agentPrompt); setCopied(true); setTimeout(() => setCopied(false), 1300); } };
  const done = async () => { if (item.action) { await patchCodeAction(item.action.id, { status: 'done', queued: false }); onReload(); } };
  return (
    <div style={{ padding: '9px 10px', borderBottom: '1px solid var(--cr-line-1)' }}>
      <div className="cr-wrap-mobile" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Chip kind={item.badge.kind} size="sm">{item.badge.label}</Chip>
        <Chip kind="mono" size="sm">{item.tag}</Chip>
        <span className="cr-donext-title" style={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
        {isRec
          ? <Button variant="primary" onClick={apply} disabled={busy}>{busy ? 'applying…' : item.rec!.kind === 'rule' ? 'Apply to CLAUDE.md' : item.rec!.kind === 'label' ? 'Apply label' : item.rec!.kind === 'skill' ? 'Install skill' : 'Apply'}</Button>
          : <Button variant="primary" onClick={copy}>{copied ? 'copied ✓' : 'Copy prompt'}</Button>}
        {!isRec && <Button variant="ghost" onClick={done}>Done</Button>}
        {expandText && <button onClick={() => setOpen(!open)} title="Show detail" style={{ background: 'none', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-sm)', color: 'var(--cr-fg-2)', cursor: 'pointer', padding: '2px 7px', fontSize: 12 }}>{open ? '−' : '⌄'}</button>}
      </div>
      {item.detail && <div style={{ color: 'var(--cr-fg-2)', fontSize: 12, marginTop: 4 }}>{item.detail}</div>}
      {open && expandText && <pre style={{ background: 'var(--cr-ink-2, #0d1117)', border: '1px solid var(--cr-line-1)', borderRadius: 6, padding: 10, fontSize: 11, whiteSpace: 'pre-wrap', fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-1)', marginTop: 6 }}>{expandText}</pre>}
      {msg && <span style={{ fontSize: 12, color: 'var(--cr-fg-2)', marginLeft: 4 }}>{msg}</span>}
    </div>
  );
}

// ── Project history (compact) — recent sessions; full timeline = Activity lens
function ProjectHistory({ projectId, toolFilter, onOpenSession }: { projectId: string; toolFilter: string; onOpenSession: (sid: string, info?: SessionInfo | null) => void }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let on = true; setLoading(true);
    getRecentSessionsPage({ limit: 8, offset: 0, projectFilter: projectId, toolFilter: toolFilter === 'all' ? undefined : toolFilter })
      .then((p) => { if (on) { setSessions(p.sessions); setTotal(p.total); setLoading(false); } });
    return () => { on = false; };
  }, [projectId, toolFilter]);
  if (loading) return <Card style={{ padding: 16, color: 'var(--cr-fg-3)' }}>Loading history…</Card>;
  if (!sessions.length) return <Card style={{ padding: 16, color: 'var(--cr-fg-3)', fontSize: 13 }}>No recorded sessions for this project.</Card>;
  return (
    <Card style={{ padding: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', padding: '4px 10px' }}>{total} session(s) · newest first</div>
      {sessions.map((s) => <SessionRow key={s.sessionId} s={s} onOpen={() => onOpenSession(s.sessionId, s)} />)}
    </Card>
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
    // .cr-split + data-has-selection drive the mobile master/detail slide: the
    // list is full-width until a session is picked, then the reader slides in
    // over it (with a Back button). Without these classes the reader sat
    // off-canvas on phones and tapping a session showed nothing.
    <div className="cr-split" data-has-selection={conv.sessionId ? 'true' : undefined} style={{ display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <div className="cr-split-list" style={{ width: 'var(--cr-convos-w, 360px)', flexShrink: 0, borderRight: '1px solid var(--cr-line-1)', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
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
      <div className="cr-split-detail" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {conv.sessionId ? (
          // ConversationViewer has its own back/close (onClose → conv.close),
          // which clears the selection and slides this pane back to the list on
          // mobile — so no extra cr-split-back here (it would double up).
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

// ── Project Activity: a real "what happened" feed — sessions + file changes ──
type ActEvent = { ts: number; type: 'session' | 'edit'; title: string; sub?: string; sessionId: string; op?: string };
function ProjectActivity({ projectId, toolFilter, onOpenSession }: { projectId: string; toolFilter: string; onOpenSession: (sid: string, info?: SessionInfo | null) => void }) {
  const [events, setEvents] = useState<ActEvent[]>([]);
  const [counts, setCounts] = useState<{ sessions: number; edits: number }>({ sessions: 0, edits: 0 });
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let on = true; setLoading(true);
    const tf = toolFilter === 'all' ? undefined : toolFilter;
    Promise.all([
      getRecentSessionsPage({ limit: 40, offset: 0, projectFilter: projectId, toolFilter: tf }),
      getEditsTimeline({ sinceHours: 24 * 120, project: projectId, limit: 200 }).catch(() => ({ edits: [] as EditRow[], total: 0 } as any)),
    ]).then(([sp, et]) => {
      if (!on) return;
      const evs: ActEvent[] = [];
      for (const s of sp.sessions) evs.push({ ts: Date.parse((s as any).modified || '') || 0, type: 'session', title: (s as any).userTitle || (s as any).summary || (s as any).firstPrompt || s.sessionId, sub: (s as any).gitBranch, sessionId: s.sessionId });
      for (const e of ((et.edits || []) as EditRow[]).slice(0, 120)) evs.push({ ts: e.ts, type: 'edit', title: `${e.op} ${e.file.split('/').pop()}`, sub: e.file, sessionId: e.sessionId, op: e.op });
      evs.sort((a, b) => b.ts - a.ts);
      setEvents(evs);
      setCounts({ sessions: sp.total, edits: (et.total ?? (et.edits || []).length) });
      setLoading(false);
    });
    return () => { on = false; };
  }, [projectId, toolFilter]);
  if (loading) return <div style={{ padding: 30, color: 'var(--cr-fg-3)' }}>Loading activity…</div>;
  if (!events.length) return <div style={{ padding: 40, color: 'var(--cr-fg-3)', textAlign: 'center' }}>No recorded activity for this project.</div>;
  const groups: Array<{ day: string; items: ActEvent[] }> = [];
  let cur: { day: string; items: ActEvent[] } | null = null;
  for (const e of events) { const day = e.ts ? new Date(e.ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : 'earlier'; if (!cur || cur.day !== day) { cur = { day, items: [] }; groups.push(cur); } cur.items.push(e); }
  return (
    <div style={{ padding: '16px 24px 48px' }}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 14, color: 'var(--cr-fg-2)', fontSize: 12 }}>
        <span><b style={{ color: 'var(--cr-fg-1)' }}>{counts.sessions}</b> sessions</span>
        <span><b style={{ color: 'var(--cr-fg-1)' }}>{counts.edits}</b> file changes</span>
      </div>
      {groups.map((g) => (
        <div key={g.day} style={{ marginBottom: 14 }}>
          <div style={{ fontFamily: 'var(--cr-font-display)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--cr-fg-3)', marginBottom: 6 }}>{g.day}</div>
          <Card style={{ padding: 4 }}>
            {g.items.map((e, i) => (
              <div key={i} onClick={() => onOpenSession(e.sessionId)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', cursor: 'pointer', borderBottom: i < g.items.length - 1 ? '1px solid var(--cr-line-1)' : 'none' }}>
                <Icon name={e.type === 'session' ? 'message' : 'file'} size={14} style={{ opacity: 0.55, flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: e.type === 'edit' ? 'var(--cr-font-mono)' : undefined }}>{e.title}</span>
                {e.type === 'edit' && <Chip kind="mono" size="sm">{e.op}</Chip>}
                <span style={{ fontSize: 11, color: 'var(--cr-fg-3)', whiteSpace: 'nowrap' }}>{e.ts ? new Date(e.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''}</span>
              </div>
            ))}
          </Card>
        </div>
      ))}
    </div>
  );
}

function SessionRow({ s, onOpen }: { s: SessionInfo; onOpen: () => void }) {
  const title = (s as any).userTitle || (s as any).summary || (s as any).firstPrompt || s.sessionId;
  const when = (s as any).modified ? new Date((s as any).modified).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <div onClick={onOpen} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid var(--cr-line-1)' }}>
      <div style={{ minWidth: 0, flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
      {(s as any).gitBranch && <Chip kind="mono" size="sm">{(s as any).gitBranch}</Chip>}
      <span style={{ fontSize: 11, color: 'var(--cr-fg-3)', whiteSpace: 'nowrap' }}>{when}</span>
      <Icon name="chevronRight" size={15} style={{ opacity: 0.4 }} />
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
