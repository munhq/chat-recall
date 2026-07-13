/**
 * CodeExplorer — the "Code" dashboard (codeindex merge).
 *
 * Every signal is a door: click any finding / hotspot / action → a right-side
 * drawer with the "why", a ready-to-paste agent prompt (referencing codeindex
 * tools), and Copy / Add-to-tasks. The tasks pill (top-right) opens the durable
 * action queue (server-backed code_actions) plus anything you queued this
 * session — copy-all or export .md. No dead report pages.
 *
 * Modelled on SecurityExplorer: hero metric cards + lens tabs + action cards.
 * Reuses the primitives design system; no new deps (the dependency map is a
 * dependency-free SVG).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Chip, SegmentedControl, MetricCard, Button, Icon } from './primitives';
import { summaryTitle } from '../utils/clean';
import ForceGraph from './ForceGraph';
import {
  getCodeProjects, getCodeProject, getCodeSummary, getCodeFindings, getCodeHotspots,
  getCodeActions, patchCodeAction, patchCodeProjectLabel,
  getCodeRecommendations, applyCodeRecommendation, writeTasksToProject, getFileSessions,
  type CodeProject, type CodeFinding, type CodeHotspot, type CodeAction, type CodeFindingsSummary, type CodeRecommendation, type CodeCouplingMetric, type SessionInfo,
} from '../services/api';

type Tab = 'recs' | 'overview' | 'plan' | 'security' | 'quality' | 'structure' | 'integrity' | 'hotspots' | 'map';
type ChipKind = 'neutral' | 'mono' | 'brand' | 'ok' | 'warn' | 'err' | 'info';

export const SEV_CHIP: Record<string, ChipKind> = { critical: 'err', high: 'warn', medium: 'info', low: 'neutral', info: 'mono' };
export const PRI_CHIP: ChipKind[] = ['err', 'warn', 'info', 'neutral'];
export const PRI_LABEL = ['P0', 'P1', 'P2', 'P3'];
const LABELS: Array<{ value: string; label: string }> = [
  { value: 'poc', label: 'POC' }, { value: 'production', label: 'Production' }, { value: 'engineering', label: 'Engineering-grade' },
];

export interface DrawerContent { kind: string; title: string; chip?: React.ReactNode; loc?: string; why: string; prompt: string; actionId?: string; }

export function hotspotPrompt(h: CodeHotspot): string {
  return `${h.file} is a hotspot — changed ${h.churn}× with complexity ${h.complexity}.${h.aiAuthored ? ' AI-authored & high-risk — review carefully.' : ''}\nRun codeindex get_change_impact on it first, add tests for its critical paths, then propose targeted refactors to reduce complexity. Show a plan + the first diff.`;
}

export default function CodeExplorer({ projectFilter, embedded, onSessionClick }: { projectFilter?: string | null; embedded?: boolean; onSessionClick?: (sessionId: string) => void }) {
  const [projects, setProjects] = useState<CodeProject[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<CodeProject | null>(null);
  const [summary, setSummary] = useState<CodeFindingsSummary | null>(null);
  const [findings, setFindings] = useState<CodeFinding[]>([]);
  const [hotspots, setHotspots] = useState<CodeHotspot[]>([]);
  const [actions, setActions] = useState<CodeAction[]>([]);
  const [recs, setRecs] = useState<CodeRecommendation[]>([]);
  const [behavior, setBehavior] = useState<{ failedOrAbandoned: number; totalSessions: number } | null>(null);
  const [tab, setTab] = useState<Tab>('recs');
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer] = useState<DrawerContent | null>(null);
  const [tasksOpen, setTasksOpen] = useState(false);
  /** session-queued finding/hotspot prompts (not backed by an action row). */
  const [queued, setQueued] = useState<Array<{ title: string; prompt: string }>>([]);

  // Pick the project: respect the sidebar project filter, else the newest.
  useEffect(() => {
    let alive = true;
    getCodeProjects().then((ps) => {
      if (!alive) return;
      setProjects(ps);
      const match = projectFilter ? ps.find((p) => p.projectId === projectFilter || p.rootPath.includes(projectFilter)) : null;
      setProjectId((cur) => cur ?? match?.projectId ?? ps[0]?.projectId ?? null);
      if (ps.length === 0) setLoading(false);
    });
    return () => { alive = false; };
  }, [projectFilter]);

  const reload = useCallback((id: string) => {
    setLoading(true);
    Promise.all([
      getCodeProject(id), getCodeSummary(id), getCodeFindings(id, { limit: 500 }),
      getCodeHotspots(id), getCodeActions(id, { limit: 200 }), getCodeRecommendations(id),
    ]).then(([p, s, f, h, a, r]) => {
      setProject(p); setSummary(s); setFindings(f); setHotspots(h); setActions(a);
      setRecs(r.recommendations); setBehavior(r.behavior); setLoading(false);
    });
  }, []);

  useEffect(() => { if (projectId) reload(projectId); }, [projectId, reload]);

  const queuedActionIds = useMemo(() => new Set(actions.filter((a) => a.queued).map((a) => a.id)), [actions]);
  const taskCount = queuedActionIds.size + queued.length;

  const openFinding = (f: CodeFinding) => setDrawer({
    kind: f.category, title: f.title, why: f.why, prompt: f.agentPrompt,
    loc: f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : undefined,
    chip: <Chip kind={SEV_CHIP[f.severity] ?? 'neutral'} size="sm">{f.severity}</Chip>,
  });
  const openHotspot = (h: CodeHotspot) => {
    const b = project?.map?.blast?.[h.file];
    setDrawer({
      kind: 'hotspot', title: h.file.split('/').pop() || h.file,
      why: 'Frequently-changed complex code is statistically where bugs land.'
        + (b ? ` Blast radius: editing this directly affects ${b.direct} file(s), ${b.transitive} transitively — role ${b.fileRole}, fan-in ${b.fanIn}, fan-out ${b.fanOut}.` : ''),
      prompt: hotspotPrompt(h), loc: h.file,
      chip: <Chip kind="warn" size="sm">score {h.score}</Chip>,
    });
  };
  const BUCKET: Record<string, { label: string; why: string; prompt: (f: string) => string }> = {
    god: { label: 'god module', why: 'Over-coupled module: hard to change safely and concentrates risk.', prompt: (f) => `${f} is a god module (high fan-in AND fan-out). Use codeindex get_imports / get_imported_by to map its dependencies, then propose how to split it into cohesive units and which dependencies to invert behind interfaces.` },
    stable: { label: 'stable core', why: 'Heavily depended-on — changes here ripple widely.', prompt: (f) => `${f} is a stable core — many modules depend on it. Run codeindex get_imported_by to see the blast radius, then ensure it has strong tests and a stable public interface before any change.` },
    driver: { label: 'unstable driver', why: 'High fan-out: depends on a lot, so it breaks as those change.', prompt: (f) => `${f} is an unstable driver (high fan-out). Run codeindex get_imports to list what it depends on, then propose which dependencies to invert behind interfaces to stabilise it.` },
    island: { label: 'island', why: 'Isolated module (no imports in or out) — possibly dead.', prompt: (f) => `${f} is an island — nothing imports it and it imports nothing. Verify it is actually reached (codeindex find_callers on its exported symbols, check reflection/FFI/entrypoints). If genuinely unused, remove it.` },
    cyc: { label: 'circular dependency', why: 'Circular dependency blocks modular build/test and signals tangled design.', prompt: (f) => `Break this circular dependency:\n  ${f}\nExtract the shared type/interface into a new module so the cycle is cut. Use codeindex get_imports to confirm the edges, then show the change.` },
  };
  const openBucket = (kind: string, file: string) => {
    const b = BUCKET[kind]; if (!b) return;
    setDrawer({ kind: b.label, title: file.split('/').pop() || file, why: b.why, prompt: b.prompt(file), loc: file });
  };
  const openAction = (a: CodeAction) => setDrawer({
    kind: 'action', title: a.title, why: a.fix, prompt: a.agentPrompt, actionId: a.id,
    loc: a.loc?.map((l) => `${l.file}${l.line ? ':' + l.line : ''}`).join(' · '),
    chip: <Chip kind={PRI_CHIP[a.pri] ?? 'neutral'} size="sm">{PRI_LABEL[a.pri] ?? 'P?'}</Chip>,
  });

  const addToTasks = async () => {
    if (!drawer) return;
    if (drawer.actionId) {
      const ok = await patchCodeAction(drawer.actionId, { status: 'queued', queued: true });
      if (ok && projectId) reload(projectId);
    } else {
      setQueued((q) => q.some((x) => x.prompt === drawer.prompt) ? q : [...q, { title: drawer.title, prompt: drawer.prompt }]);
    }
  };
  const markDone = async () => {
    if (drawer?.actionId) { await patchCodeAction(drawer.actionId, { status: 'done', queued: false }); if (projectId) reload(projectId); setDrawer(null); }
  };
  const setLabel = async (label: string) => {
    if (!projectId || !project) return;
    const next = project.label === label ? null : label;
    const ok = await patchCodeProjectLabel(projectId, next);
    if (ok) setProject({ ...project, label: next });
  };

  if (loading && !project) return <div style={{ padding: 40, color: 'var(--cr-fg-3)' }}>Loading code intelligence…</div>;

  if (projects.length === 0) {
    return (
      <div style={{ padding: 40, maxWidth: 620 }}>
        <h2 style={{ margin: '0 0 8px' }}>Code intelligence</h2>
        <p style={{ color: 'var(--cr-fg-2)', lineHeight: 1.6 }}>
          No repositories indexed yet. From a repo on your machine, run:
        </p>
        <pre style={{ background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-md)', padding: 14, fontFamily: 'var(--cr-font-mono)' }}>chat-recall code index</pre>
        <p style={{ color: 'var(--cr-fg-3)', fontSize: 13 }}>
          codeindex analyses structure, security, duplication, hotspots and dependency cycles; the results land here as an actionable plan.
        </p>
      </div>
    );
  }

  const h = project?.health;
  const planActions = actions;
  const securityFindings = findings.filter((f) => f.category === 'security' || f.category === 'literal' || f.category === 'unwrap' || (f.category === 'manifest' && f.rule === 'credential_in_manifest'));
  const qualityFindings = findings.filter((f) => f.category === 'clone' || f.category === 'duplication' || f.category === 'dead_code' || f.category === 'coverage');
  const structureFindings = findings.filter((f) => f.category === 'coupling' || f.category === 'cycle' || f.category === 'architecture');
  // Recovered analyzers (were count-only) — frontend/backend wiring, type drift,
  // schema/migration parity, manifest hygiene. Each is a real, clickable finding.
  const integrityFindings = findings.filter((f) => f.category === 'crossref' || f.category === 'type_drift' || f.category === 'schema' || f.category === 'migration' || (f.category === 'manifest' && f.rule !== 'credential_in_manifest'));

  return (
    // flex:1 + min-width:0 so the standalone Code page fills the app row like
    // every other view — without it the content sized to its own width and sat
    // in a half-screen column. (overflow:auto keeps it independently scrollable;
    // harmless when embedded in ProjectWorkspace, which already flexes.)
    <div className="cr-page-pad" style={{ position: 'relative', paddingBottom: 60, flex: 1, minWidth: 0, overflow: 'auto' }}>
      {/* Header: project picker + label + tasks pill */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        {!embedded && <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="code" size={20} /> Code</h2>}
        {!embedded && projects.length > 1 && (
          <select value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value)}
            style={{ background: 'var(--cr-ink-1)', color: 'var(--cr-fg-1)', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-sm)', padding: '6px 10px', fontFamily: 'var(--cr-font-mono)', fontSize: 12 }}>
            {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.projectId}</option>)}
          </select>
        )}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
          {/* Embedded in ProjectWorkspace the label switch lives in the project
              header — only show it here on the standalone Code page. */}
          {!embedded && <span style={{ color: 'var(--cr-fg-3)', fontSize: 12 }}>label:</span>}
          {!embedded && LABELS.map((l) => (
            <button key={l.value} onClick={() => setLabel(l.value)} title={`Mark project as ${l.label}`}
              style={{ cursor: 'pointer', borderRadius: 999, padding: '3px 10px', fontSize: 11, border: '1px solid var(--cr-line-1)',
                background: project?.label === l.value ? 'var(--cr-brand-500)' : 'transparent',
                color: project?.label === l.value ? '#fff' : 'var(--cr-fg-2)' }}>{l.label}</button>
          ))}
          <button onClick={() => setTasksOpen(true)} data-testid="tasks-pill"
            style={{ cursor: 'pointer', borderRadius: 999, padding: '6px 14px', marginLeft: 8, border: '1px solid var(--cr-brand-500)', background: 'var(--cr-brand-surf, transparent)', color: 'var(--cr-brand-500)', fontWeight: 600, fontSize: 13 }}>
            ▸ tasks · {taskCount}
          </button>
        </div>
      </div>

      {/* Hero metrics */}
      {h && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12, marginBottom: 18 }}>
          <MetricCard label="Health" value={`${h.score}/100`} tone={h.score >= 70 ? 'ok' : h.score >= 40 ? 'neutral' : 'err'} icon="chart" />
          <MetricCard label="Findings" value={String(summary?.total ?? h.findings)} sub={`${h.critical} critical · ${h.high} high`} tone={h.critical > 0 ? 'err' : 'neutral'} icon="check" />
          <MetricCard label="Hotspots" value={String(h.hotspots)} sub="churn × complexity" icon="zap" />
          <MetricCard label="AI-authored" value={`${Math.round((h.aiAuthoredPct || 0) * 100)}%`} sub="of files" icon="sparkle" />
          <MetricCard label="Files" value={String(project?.fileCount ?? 0)} sub={`${project?.symbolCount ?? 0} symbols`} icon="file" />
          <MetricCard
            label="Sessions"
            value={behavior ? String(behavior.totalSessions) : '—'}
            sub={behavior ? `${behavior.failedOrAbandoned} unresolved` : 'no synced sessions'}
            tone={behavior && behavior.totalSessions > 0 && behavior.failedOrAbandoned / behavior.totalSessions >= 0.3 ? 'err' : 'neutral'}
            icon="message"
          />
        </div>
      )}

      {/* Lens tabs */}
      <div style={{ marginBottom: 16 }}>
        <SegmentedControl
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          options={[
            { value: 'recs', label: `Recommendations (${recs.length})` },
            { value: 'overview', label: 'Overview' },
            { value: 'plan', label: `Plan (${planActions.length})` },
            { value: 'security', label: `Security (${securityFindings.length})` },
            { value: 'quality', label: `Quality (${qualityFindings.length})` },
            { value: 'structure', label: `Structure (${structureFindings.length})` },
            { value: 'integrity', label: `Integrity (${integrityFindings.length})` },
            { value: 'hotspots', label: `Hotspots (${hotspots.length})` },
            { value: 'map', label: 'Map' },
          ]}
        />
      </div>

      {tab === 'recs' && <RecommendationsView recs={recs} projectId={projectId} onApplied={() => projectId && reload(projectId)} />}
      {tab === 'overview' && project && <OverviewTab project={project} behavior={behavior} />}
      {tab === 'plan' && <ActionList actions={planActions} onOpen={openAction} queuedIds={queuedActionIds} />}
      {tab === 'security' && <FindingList findings={securityFindings} onOpen={openFinding} />}
      {tab === 'quality' && <FindingList findings={qualityFindings} onOpen={openFinding} />}
      {tab === 'structure' && <StructureView findings={structureFindings} buckets={project?.map.buckets} coupling={project?.map.coupling} onOpen={openFinding} onBucket={openBucket} />}
      {tab === 'integrity' && (integrityFindings.length ? <FindingList findings={integrityFindings} onOpen={openFinding} /> : <div style={{ padding: 30, textAlign: 'center', color: 'var(--cr-fg-3)' }}>No wiring / type / schema / migration / manifest issues. Frontend↔backend routes match, types agree across languages, and migrations are consistent.</div>)}
      {tab === 'hotspots' && <HotspotTable hotspots={hotspots} onOpen={openHotspot} />}
      {tab === 'map' && <DependencyMap map={project?.map} />}

      {drawer && (
        <Drawer content={drawer} onClose={() => setDrawer(null)} onAddTask={addToTasks} onDone={markDone}
          projectId={projectId} onSessionClick={onSessionClick} />
      )}
      {tasksOpen && (
        <TasksDrawer
          name={project?.projectId ?? ''}
          projectId={projectId}
          queuedActions={actions.filter((a) => a.queued)}
          queued={queued}
          onClose={() => setTasksOpen(false)}
        />
      )}
    </div>
  );
}

// ── Lists ───────────────────────────────────────────────────────────────────
function Row({ onClick, left, right }: { onClick: () => void; left: React.ReactNode; right?: React.ReactNode }) {
  return (
    <Card interactive onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', marginBottom: 6, cursor: 'pointer' }}>
      <div style={{ minWidth: 0, flex: 1 }}>{left}</div>
      {right}
      <Icon name="more" size={16} style={{ opacity: 0.4 }} />
    </Card>
  );
}

export function ActionList({ actions, onOpen, queuedIds }: { actions: CodeAction[]; onOpen: (a: CodeAction) => void; queuedIds: Set<string> }) {
  if (!actions.length) return <Empty>No action items — clean, or not indexed yet.</Empty>;
  return <>{actions.map((a) => (
    <Row key={a.id} onClick={() => onOpen(a)}
      left={<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Chip kind={PRI_CHIP[a.pri] ?? 'neutral'} size="sm">{PRI_LABEL[a.pri] ?? 'P?'}</Chip>
        <span style={{ fontWeight: 500 }}>{a.title}</span>
        <Chip kind="mono" size="sm">{a.category}</Chip>
      </div>}
      right={<>
        {a.status === 'done' && <Chip kind="ok" size="sm">done</Chip>}
        {a.status !== 'done' && queuedIds.has(a.id) && <Chip kind="brand" size="sm">queued</Chip>}
      </>}
    />
  ))}</>;
}

export function FindingList({ findings, onOpen }: { findings: CodeFinding[]; onOpen: (f: CodeFinding) => void }) {
  if (!findings.length) return <Empty>Nothing here — nice.</Empty>;
  return <>{findings.map((f) => (
    <Row key={f.id} onClick={() => onOpen(f)}
      left={<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Chip kind={SEV_CHIP[f.severity] ?? 'neutral'} size="sm">{f.severity}</Chip>
        <span style={{ fontWeight: 500 }}>{f.title}</span>
      </div>}
      right={<span className="mono" style={{ color: 'var(--cr-fg-3)', fontSize: 12 }}>{f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : ''}</span>}
    />
  ))}</>;
}

function CouplingTable({ title, kind, rows, tone, hint, onItem }: { title: string; kind: string; rows: CodeCouplingMetric[]; tone: ChipKind; hint: string; onItem: (kind: string, file: string) => void }) {
  return (
    <Card style={{ padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <strong style={{ fontSize: 13 }}>{title}</strong><Chip kind={tone} size="sm">{rows.length}</Chip>
      </div>
      <div style={{ color: 'var(--cr-fg-3)', fontSize: 11, marginBottom: 8 }}>{hint}</div>
      {rows.length === 0 ? <span style={{ color: 'var(--cr-fg-3)', fontSize: 12 }}>none</span> : (
        <div style={{ maxHeight: 200, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead><tr style={{ color: 'var(--cr-fg-3)', textAlign: 'left' }}>
              <th style={{ fontWeight: 500 }}>file</th>
              <th title="in — afferent coupling (fan-in): how many files import this one" style={{ cursor: 'help' }}>in</th>
              <th title="out — efferent coupling (fan-out): how many files this one imports" style={{ cursor: 'help' }}>out</th>
              <th title="I — instability = out / (in + out). 0 = stable (safe to depend on), 1 = unstable (changes often ripple out)" style={{ cursor: 'help' }}>I</th>
            </tr></thead>
            <tbody>
              {rows.slice(0, 15).map((m) => (
                <tr key={m.file} onClick={() => onItem(kind, m.file)} style={{ cursor: 'pointer' }} title="Click for an agent prompt">
                  <td className="mono" style={{ color: 'var(--cr-fg-2)', paddingRight: 8 }}>{m.file}</td>
                  <td style={{ color: 'var(--cr-fg-3)' }}>{m.fanIn}</td><td style={{ color: 'var(--cr-fg-3)' }}>{m.fanOut}</td><td style={{ color: 'var(--cr-fg-3)' }}>{m.instability}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
export function StructureView({ findings, buckets, coupling, onOpen, onBucket }: { findings: CodeFinding[]; buckets?: CodeProject['map']['buckets']; coupling?: CodeProject['map']['coupling']; onOpen: (f: CodeFinding) => void; onBucket: (kind: string, file: string) => void }) {
  return (
    <div>
      {coupling ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 12, marginBottom: 16 }}>
          <CouplingTable title="God modules" kind="god" rows={coupling.god_modules} tone="err" hint="high fan-in AND fan-out" onItem={onBucket} />
          <CouplingTable title="Stable cores" kind="stable" rows={coupling.stable_cores} tone="ok" hint="depended-on; keep stable" onItem={onBucket} />
          <CouplingTable title="Unstable drivers" kind="driver" rows={coupling.unstable_drivers} tone="warn" hint="high fan-out; breaks easily" onItem={onBucket} />
          <CouplingTable title="Islands" kind="island" rows={coupling.islands} tone="neutral" hint="no imports in/out; maybe dead" onItem={onBucket} />
          {buckets && <BucketCard title="Circular deps" kind="cyc" files={buckets.cycles.map((c) => c.join(' → '))} tone="err" hint="break the cycle" onItem={onBucket} />}
        </div>
      ) : buckets && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12, marginBottom: 16 }}>
          <BucketCard title="God modules" kind="god" files={buckets.god_modules} tone="err" hint="high fan-in AND fan-out" onItem={onBucket} />
          <BucketCard title="Stable cores" kind="stable" files={buckets.stable_cores} tone="ok" hint="depended-on; keep stable" onItem={onBucket} />
          <BucketCard title="Unstable drivers" kind="driver" files={buckets.unstable_drivers} tone="warn" hint="high fan-out; breaks easily" onItem={onBucket} />
          <BucketCard title="Islands" kind="island" files={buckets.islands} tone="neutral" hint="no imports in/out; maybe dead" onItem={onBucket} />
          <BucketCard title="Circular deps" kind="cyc" files={buckets.cycles.map((c) => c.join(' → '))} tone="err" hint="break the cycle" onItem={onBucket} />
        </div>
      )}
      <FindingList findings={findings} onOpen={onOpen} />
    </div>
  );
}

function BucketCard({ title, kind, files, tone, hint, onItem }: { title: string; kind: string; files: string[]; tone: ChipKind; hint: string; onItem: (kind: string, file: string) => void }) {
  return (
    <Card style={{ padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>{title}</strong><Chip kind={tone} size="sm">{files.length}</Chip>
      </div>
      <div style={{ color: 'var(--cr-fg-3)', fontSize: 11, marginBottom: 8 }}>{hint}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 140, overflow: 'auto' }}>
        {files.slice(0, 12).map((f, i) => (
          <button key={i} onClick={() => onItem(kind, f)} title="Click for an agent prompt"
            style={{ textAlign: 'left', cursor: 'pointer', background: 'none', border: 'none', padding: '2px 0', color: 'var(--cr-fg-2)', fontFamily: 'var(--cr-font-mono)', fontSize: 11 }}>{f}</button>
        ))}
        {files.length === 0 && <span style={{ color: 'var(--cr-fg-3)', fontSize: 12 }}>none</span>}
      </div>
    </Card>
  );
}

export function HotspotTable({ hotspots, onOpen }: { hotspots: CodeHotspot[]; onOpen: (h: CodeHotspot) => void }) {
  if (!hotspots.length) return <Empty>No hotspots (no churn × complexity signal).</Empty>;
  const max = hotspots[0]?.score || 1;
  return <>{hotspots.map((h) => (
    <Row key={h.id} onClick={() => onOpen(h)}
      left={<div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="mono" style={{ fontSize: 13 }}>{h.file}</span>
          {h.aiAuthored && <Chip kind="brand" size="sm">AI</Chip>}
        </div>
        <div style={{ height: 4, background: 'var(--cr-line-1)', borderRadius: 2, marginTop: 6, width: 220 }}>
          <div style={{ height: '100%', width: `${Math.round((h.score / max) * 100)}%`, background: 'var(--cr-warn-500)', borderRadius: 2 }} />
        </div>
        {h.suggestion && <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginTop: 4 }}>{h.suggestion}</div>}
      </div>}
      right={<span
        className="mono"
        style={{ color: 'var(--cr-fg-3)', fontSize: 12, cursor: 'help' }}
        title={`churn ${h.churn} — times this file changed · cx ${h.complexity} — cyclomatic complexity · ${h.score} — hotspot score (churn × complexity)`}
      >churn {h.churn} · cx {h.complexity} · {h.score}</span>}
    />
  ))}</>;
}

// ── Dependency map: files colored by coupling ROLE ───────────────────────────
// The old default drew packages as uniform dots — and for many repos there are
// ZERO cross-package edges (a disconnected blob with no takeaway). This instead
// draws the *coupled files* colored by role (god-module / cycle / unstable-
// driver / stable-core / island) with their import edges + a legend, so the
// graph reads as a risk map at a glance. Falls back to the package view only
// for older indexes that predate coupling data.
const ROLE_COLOR: Record<string, string> = {
  god: '#ef4444', cycle: '#a855f7', driver: '#f59e0b', stable: '#22c55e', island: '#6b7280',
};
const ROLE_LABEL: Record<string, string> = {
  god: 'god module', cycle: 'in a cycle', driver: 'unstable driver', stable: 'stable core', island: 'island (dead?)',
};
const ROLE_HINT: Record<string, string> = {
  god: 'high fan-in AND fan-out — big blast radius',
  cycle: 'imports form a cycle — tangled, blocks modular build/test',
  driver: 'high fan-out — depends on a lot, breaks as those change',
  stable: 'high fan-in — many modules depend on it',
  island: 'no imports in or out — possibly dead code',
};

function CircleGraph({ nodes, edges, onNode }: { nodes: Array<{ id: string; label: string; symbols: number; faded?: boolean; role?: string }>; edges: Array<{ from: string; to: string }>; onNode?: (id: string) => void; dim?: boolean }) {
  const maxSym = Math.max(1, ...nodes.map((n) => n.symbols));
  const fgNodes = useMemo(() => nodes.map((n) => ({
    id: n.id,
    label: n.label,
    r: 4 + Math.round((n.symbols / maxSym) * 16),
    fill: n.role ? (ROLE_COLOR[n.role] || 'var(--cr-brand-500)') : (n.faded ? 'var(--cr-line-1)' : 'var(--cr-brand-500)'),
    opacity: n.faded ? 0.45 : 0.9,
    labelGap: 6,
    title: `${n.id} · ${n.symbols} symbols${n.role ? ' · ' + (ROLE_LABEL[n.role] || n.role) : ''}${onNode ? ' (click to drill in)' : ''}`,
  })), [nodes, maxSym, onNode]);
  if (nodes.length === 0) return <Empty>Nothing to graph here.</Empty>;
  return <ForceGraph nodes={fgNodes} edges={edges} onNode={onNode} resetKey={nodes} />;
}

function RoleLegend({ counts }: { counts: Record<string, number> }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 8, fontSize: 11 }}>
      {['god', 'cycle', 'driver', 'stable', 'island'].filter((r) => counts[r]).map((r) => (
        <span key={r} title={ROLE_HINT[r]} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--cr-fg-2)', cursor: 'help' }}>
          <span style={{ width: 9, height: 9, borderRadius: 999, background: ROLE_COLOR[r], flexShrink: 0 }} />
          {ROLE_LABEL[r]} <span style={{ color: 'var(--cr-fg-3)' }}>({counts[r]})</span>
        </span>
      ))}
    </div>
  );
}

export function DependencyMap({ map }: { map?: CodeProject['map'] }) {
  if (!map || map.nodes.length === 0) return <Empty>No dependency graph (single-package or no cross-package imports).</Empty>;

  // Primary view: coupled files colored by role — the readable "risk map".
  const coupling = map.coupling; const buckets = map.buckets;
  if (coupling || buckets) {
    const roleOf = new Map<string, string>();
    const tag = (files: string[] | undefined, role: string) => (files || []).forEach((f) => roleOf.set(f, role));
    // Tag low→high priority so god/cycle win when a file is in multiple buckets.
    tag((coupling?.islands?.map((x) => x.file)) ?? buckets?.islands, 'island');
    tag((coupling?.stable_cores?.map((x) => x.file)) ?? buckets?.stable_cores, 'stable');
    tag((coupling?.unstable_drivers?.map((x) => x.file)) ?? buckets?.unstable_drivers, 'driver');
    (buckets?.cycles || []).forEach((cy) => cy.forEach((f) => roleOf.set(f, 'cycle')));
    tag((coupling?.god_modules?.map((x) => x.file)) ?? buckets?.god_modules, 'god');

    const metric = new Map<string, number>();
    for (const g of ['god_modules', 'stable_cores', 'unstable_drivers', 'islands'] as const) {
      for (const r of (coupling?.[g] || [])) metric.set(r.file, r.fanIn + r.fanOut);
    }
    // Count every role (incl. islands) for the legend before we trim the graph.
    const counts: Record<string, number> = {};
    for (const r of roleOf.values()) counts[r] = (counts[r] || 0) + 1;
    // Islands have no imports in or out — by definition zero edges — so the force
    // sim can't pull them in and they scatter as a ring of lonely dots that crowds
    // out the real structure. Drop them from the *graph*; the legend keeps the
    // count and the Structure tab's Islands list keeps the files.
    // Most-coupled first, capped so the graph stays legible.
    const files = [...roleOf.keys()]
      .filter((f) => roleOf.get(f) !== 'island')
      .sort((a, z) => (metric.get(z) ?? 0) - (metric.get(a) ?? 0))
      .slice(0, 60);
    if (files.length > 0) {
      const fset = new Set(files);
      const nodes = files.map((f) => ({
        id: f, label: f.split('/').pop() || f, role: roleOf.get(f),
        symbols: map.fileMeta?.[f]?.symbols ?? ((metric.get(f) ?? 0) + 1),
      }));
      const edges = (map.fileEdges || []).filter((e) => fset.has(e.from) && fset.has(e.to));
      return (
        <Card style={{ padding: 12, overflow: 'auto' }}>
          <RoleLegend counts={counts} />
          <div style={{ color: 'var(--cr-fg-3)', fontSize: 11, marginBottom: 8 }}>
            {files.length} coupled files · {edges.length} imports
            {counts.island ? ` · ${counts.island} islands hidden (see Structure)` : ''} · dot size = symbols · scroll to zoom, drag to pan
          </div>
          <CircleGraph nodes={nodes} edges={edges} />
        </Card>
      );
    }
  }

  // Fallback: package view (older indexes without coupling data).
  const nodes = map.nodes.slice(0, 40).map((n) => ({ id: n.file, label: n.file.split('/').pop() || n.file, symbols: n.symbols }));
  return (
    <Card style={{ padding: 12, overflow: 'auto' }}>
      <div style={{ color: 'var(--cr-fg-3)', fontSize: 12, marginBottom: 8 }}>{nodes.length} packages · {map.edges.length} dependency edges</div>
      <CircleGraph nodes={nodes} edges={map.edges} />
    </Card>
  );
}

// ── Drawers ───────────────────────────────────────────────────────────────
export function Drawer({ content, onClose, onAddTask, onDone, projectId, onSessionClick }: { content: DrawerContent; onClose: () => void; onAddTask: () => void; onDone: () => void; projectId?: string | null; onSessionClick?: (sessionId: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [added, setAdded] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const copy = () => { navigator.clipboard.writeText(content.prompt); setCopied(true); setTimeout(() => setCopied(false), 1300); };
  const add = () => { onAddTask(); setAdded(true); setTimeout(() => setAdded(false), 1300); };
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000 }} />
      <div data-testid="code-drawer" style={{ position: 'fixed', right: 0, top: 0, height: '100dvh', width: 'min(540px,96vw)', background: 'var(--cr-ink-1)', borderLeft: '1px solid var(--cr-line-1)', zIndex: 1001, padding: 22, overflow: 'auto', boxShadow: '-12px 0 40px rgba(0,0,0,0.4)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ color: 'var(--cr-fg-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>{content.kind}</span>
          <button onClick={onClose} style={{ cursor: 'pointer', background: 'none', border: 'none', color: 'var(--cr-fg-3)' }}><Icon name="x" size={18} /></button>
        </div>
        <h3 style={{ margin: '0 0 8px' }}>{content.title}</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          {content.chip}{content.loc && <span className="mono" style={{ color: 'var(--cr-fg-3)', fontSize: 12 }}>{content.loc}</span>}
        </div>
        <div style={{ background: 'var(--cr-info-surf, rgba(80,140,255,0.08))', borderLeft: '3px solid var(--cr-info-500, #5b8cff)', padding: '10px 12px', borderRadius: 6, color: 'var(--cr-fg-2)', fontSize: 13, marginBottom: 14 }}>{content.why}</div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--cr-fg-2)', marginBottom: 6 }}>Prompt for your agent</div>
        <pre data-testid="code-prompt" style={{ background: 'var(--cr-ink-2, #0d1117)', border: '1px solid var(--cr-line-1)', borderRadius: 8, padding: 12, fontSize: 12, whiteSpace: 'pre-wrap', fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-1)' }}>{content.prompt}</pre>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <Button variant="primary" onClick={copy}>{copied ? 'copied ✓' : 'Copy prompt'}</Button>
          <Button variant="secondary" onClick={add}>{added ? 'added ✓' : '+ Add to tasks'}</Button>
          {content.actionId && <Button variant="ghost" onClick={onDone}>Mark done</Button>}
        </div>
        <div style={{ color: 'var(--cr-fg-3)', fontSize: 11, marginTop: 10 }}>Paste into Claude Code / your agent. It references codeindex tools so the agent verifies before editing.</div>
        {content.loc && projectId && (
          <FileSessionHistory projectId={projectId} file={content.loc} onSessionClick={onSessionClick} />
        )}
      </div>
    </>
  );
}

/**
 * Behaviour×code correlation panel: the sessions that actually edited this
 * file, each with its outcome — the "why is this file like this" trail.
 * Clicking a session jumps to the conversation.
 */
const HIST_STATUS_COLOR: Record<string, string> = {
  shipped: 'var(--cr-ok-500)', abandoned: 'var(--cr-err-500)',
  interrupted: 'var(--cr-warn-500)', in_progress: 'var(--cr-info-500)',
};
function FileSessionHistory({ projectId, file, onSessionClick }: { projectId: string; file: string; onSessionClick?: (sessionId: string) => void }) {
  const [data, setData] = useState<{ total: number; sessions: SessionInfo[] } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let on = true;
    setData(null); setFailed(false);
    getFileSessions(projectId, file)
      .then((d) => { if (on) setData(d); })
      .catch(() => { if (on) { setData({ total: 0, sessions: [] }); setFailed(true); } });
    return () => { on = false; };
  }, [projectId, file]);

  const timeAgo = (iso: string): string => {
    const d = Date.now() - new Date(iso).getTime();
    const h = Math.floor(d / 3_600_000);
    if (h < 1) return 'now';
    if (h < 24) return `${h}h ago`;
    const days = Math.floor(h / 24);
    return days < 31 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`;
  };

  return (
    <div data-testid="file-session-history" style={{ marginTop: 18, borderTop: '1px solid var(--cr-line-1)', paddingTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--cr-fg-2)', marginBottom: 8 }}>
        Who touched this file
        {data && data.total > 0 && <span style={{ color: 'var(--cr-fg-3)', fontWeight: 400 }}> · {data.total} session{data.total === 1 ? '' : 's'}</span>}
      </div>
      {data === null && <div style={{ color: 'var(--cr-fg-3)', fontSize: 12 }}>Looking up sessions…</div>}
      {data !== null && failed && <div style={{ color: 'var(--cr-fg-3)', fontSize: 12 }}>Session history unavailable.</div>}
      {data !== null && !failed && data.sessions.length === 0 && (
        <div style={{ color: 'var(--cr-fg-3)', fontSize: 12 }}>No synced session edited this file — the change predates chat-recall or happened outside an AI session.</div>
      )}
      {data !== null && data.sessions.map((s) => {
        const oc = s.outcome;
        const color = oc ? (HIST_STATUS_COLOR[oc.status] || 'var(--cr-fg-3)') : 'var(--cr-fg-3)';
        const label = oc && oc.status !== 'unknown' ? (oc.status === 'in_progress' ? 'in progress' : oc.status) : '';
        const title = (s.userTitle || s.toolTitle || summaryTitle(s.summary, 90) || s.firstPrompt || '(untitled session)').replace(/\s+/g, ' ').slice(0, 90);
        return (
          <button
            key={s.sessionId}
            data-testid="file-session-row"
            onClick={() => onSessionClick?.(s.sessionId)}
            title={oc ? `${label || 'session'} · ${oc.files} file(s) +${oc.linesAdded} −${oc.linesRemoved}${oc.commits ? ` · ${oc.commits} commit(s)` : ''} — click to open the conversation` : 'Click to open the conversation'}
            style={{
              display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left',
              background: 'none', border: 'none', padding: '5px 0', cursor: onSessionClick ? 'pointer' : 'default',
              borderBottom: '1px solid var(--cr-line-1)', fontSize: 12, color: 'var(--cr-fg-2)',
            }}
          >
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0, alignSelf: 'center' }} />
            {label && <span style={{ color, flexShrink: 0, fontWeight: 600 }}>{label}</span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{title}</span>
            <span className="mono" style={{ color: 'var(--cr-fg-3)', flexShrink: 0, fontSize: 11 }}>{timeAgo(s.modified)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function TasksDrawer({ name, projectId, queuedActions, queued, onClose }: { name: string; projectId: string | null; queuedActions: CodeAction[]; queued: Array<{ title: string; prompt: string }>; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const [sendMsg, setSendMsg] = useState<string>('');
  const [sending, setSending] = useState(false);
  const all = [...queuedActions.map((a) => ({ title: a.title, prompt: a.agentPrompt })), ...queued];
  const md = `# ${name} — action plan\n\n` + all.map((t, i) => `${i + 1}. ${t.title}\n\n\`\`\`\n${t.prompt}\n\`\`\`\n`).join('\n');
  const copyAll = () => navigator.clipboard.writeText(md);
  const exportMd = () => { const b = new Blob([md], { type: 'text/markdown' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'code-tasks.md'; a.click(); };
  const sendToProject = async () => {
    if (!projectId) return;
    setSending(true);
    const res = await writeTasksToProject(projectId);
    setSendMsg(res.message || (res.ok ? 'queued' : 'failed'));
    setSending(false);
  };
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000 }} />
      <div data-testid="tasks-drawer" style={{ position: 'fixed', right: 0, top: 0, height: '100dvh', width: 'min(540px,96vw)', background: 'var(--cr-ink-1)', borderLeft: '1px solid var(--cr-line-1)', zIndex: 1001, padding: 22, overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Task queue · {all.length}</h3>
          <button onClick={onClose} style={{ cursor: 'pointer', background: 'none', border: 'none', color: 'var(--cr-fg-3)' }}><Icon name="x" size={18} /></button>
        </div>
        {all.length === 0 ? <Empty>No tasks queued. Click a finding or action → "Add to tasks".</Empty> : (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <Button variant="primary" onClick={sendToProject} disabled={sending || !projectId}>{sending ? 'sending…' : '→ Send to project (CODE_TASKS.md)'}</Button>
              <Button variant="secondary" onClick={copyAll}>Copy all</Button>
              <Button variant="ghost" onClick={exportMd}>Export .md</Button>
            </div>
            {sendMsg && <div style={{ fontSize: 12, color: 'var(--cr-fg-2)', marginBottom: 12, background: 'var(--cr-ok-surf,rgba(40,180,120,0.1))', padding: '6px 10px', borderRadius: 6 }}>{sendMsg}</div>}
            {all.map((t, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>{String(i + 1).padStart(2, '0')}. {t.title}</div>
                <pre style={{ background: 'var(--cr-ink-2, #0d1117)', border: '1px solid var(--cr-line-1)', borderRadius: 6, padding: 10, fontSize: 11, whiteSpace: 'pre-wrap', fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-2)' }}>{t.prompt}</pre>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}

// ── Recommendations (the moat: behavior × code → apply) ─────────────────────
const REC_CHIP: Record<string, ChipKind> = { high: 'err', medium: 'warn', low: 'neutral' };
export function RecommendationsView({ recs, projectId, onApplied }: { recs: CodeRecommendation[]; projectId: string | null; onApplied: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  if (!recs.length) return <Empty>No recommendations yet — index a project with findings, or wait for behavioral signal. The engine turns code × behavior into rules, labels and skills to apply.</Empty>;
  const apply = async (r: CodeRecommendation) => {
    if (!projectId) return;
    setBusy(r.id);
    const res = await applyCodeRecommendation(projectId, r.id);
    setMsg((m) => ({ ...m, [r.id]: res.message || (res.ok ? 'done' : 'failed') }));
    setBusy(null);
    if (res.applied) onApplied();
  };
  const copyRule = (r: CodeRecommendation) => { const t = (r.action.payload as any)?.text; if (t) navigator.clipboard.writeText(String(t)); };
  return (
    <div data-testid="recs-list">
      {recs.map((r) => (
        <Card key={r.id} style={{ padding: 16, marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Chip kind={REC_CHIP[r.severity] ?? 'neutral'} size="sm">{r.severity}</Chip>
            <strong>{r.title}</strong>
            <Chip kind="mono" size="sm">{r.kind}</Chip>
          </div>
          <div style={{ color: 'var(--cr-fg-2)', fontSize: 13, marginBottom: 8 }}>{r.rationale}</div>
          {r.evidence?.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {r.evidence.map((e, i) => <span key={i} className="mono" style={{ fontSize: 11, color: 'var(--cr-fg-3)', background: 'var(--cr-ink-2,#0d1117)', padding: '2px 6px', borderRadius: 4 }}>{e}</span>)}
            </div>
          )}
          {r.action.type === 'append_claude_md' && (r.action.payload as any)?.text && (
            <pre style={{ background: 'var(--cr-ink-2,#0d1117)', border: '1px solid var(--cr-line-1)', borderRadius: 6, padding: 10, fontSize: 12, whiteSpace: 'pre-wrap', fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-1)', marginBottom: 8 }}>{String((r.action.payload as any).text)}</pre>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button variant="primary" onClick={() => apply(r)} disabled={busy === r.id}>
              {busy === r.id ? 'applying…' : r.kind === 'label' ? 'Apply label' : r.kind === 'rule' ? 'Apply to CLAUDE.md' : 'Apply'}
            </Button>
            {r.action.type === 'append_claude_md' && <Button variant="secondary" onClick={() => copyRule(r)}>Copy rule</Button>}
            {msg[r.id] && <span style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>{msg[r.id]}</span>}
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── Overview: languages + AI-authorship + savings + count-only stats ────────
const STAT_LABELS: Record<string, string> = {
  crossref_frontend_only: 'Frontend-only (unwired)', crossref_backend_only: 'Backend-only (unwired)',
  type_mismatches: 'Type mismatches', type_missing_fields: 'Missing type fields',
  db_schema_issues: 'DB schema issues', migration_issues: 'Migration parity issues', manifest_violations: 'Manifest violations',
};
function OverviewTab({ project, behavior }: { project: CodeProject; behavior: { failedOrAbandoned: number; totalSessions: number } | null }) {
  const h = project.health;
  const sym = project.map?.langSymbols || {};
  // POC sizes the language bars by SYMBOLS (fall back to file count).
  const langs = Object.entries(project.langs || {}).map(([l, files]) => ({ l, files, symbols: sym[l] ?? 0 }))
    .sort((a, b) => (b.symbols || b.files) - (a.symbols || a.files));
  const maxLang = Math.max(1, ...langs.map((x) => x.symbols || x.files));
  const palette = ['#6ea8fe', '#f4b740', '#7ee787', '#ff7b72', '#d2a8ff', '#79c0ff', '#ffa657', '#56d4bc'];
  const st = h.stats || {};
  // POC "health snapshot" set.
  const SNAP: Array<[string, number]> = [
    ['god modules', st.god_modules ?? 0], ['circular deps', st.circular_deps ?? 0], ['panic sites', st.panic_sites ?? 0],
    ['dead symbols', st.dead_symbols ?? 0], ['duplicate names', st.duplicate_names ?? 0], ['clone groups', st.clone_groups ?? 0],
    ['hardcoded IPs', st.literal_ips ?? 0], ['hardcoded URLs', st.literal_urls ?? 0], ['secrets', st.literal_secrets ?? 0], ['TODOs', st.literal_todos ?? 0],
  ];
  const DEEPER: Array<[string, number]> = (['crossref_frontend_only', 'crossref_backend_only', 'type_mismatches', 'type_missing_fields', 'db_schema_issues', 'migration_issues', 'manifest_violations'] as const)
    .map((k) => [k, st[k] ?? 0]).filter(([, v]) => (v as number) > 0) as Array<[string, number]>;
  return (
    <div data-testid="code-overview" style={{ display: 'grid', gap: 14 }}>
      {/* AI authorship + savings + verdict */}
      <Card style={{ padding: 16 }}>
        <strong style={{ fontSize: 13 }}>How this code was built</strong>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 10 }}>
          <Stat label="AI-authored commits" value={h.totalCommits != null ? `${h.aiCommits ?? 0} / ${h.totalCommits}` : '—'} sub={h.totalCommits ? `${Math.round(((h.aiCommits ?? 0) / Math.max(h.totalCommits, 1)) * 100)}% of commits` : ''} />
          <Stat label="AI-touched files" value={`${Math.round((h.aiAuthoredPct || 0) * 100)}%`} />
          <Stat label="codeindex token savings" value={h.savingsPct != null ? `${Math.round(h.savingsPct)}%` : '—'} sub="vs reading the whole tree" />
          <Stat label="Sessions here" value={behavior ? String(behavior.totalSessions) : '—'} sub={behavior ? `${behavior.failedOrAbandoned} unresolved` : 'no synced sessions'} />
          <Stat label="Health" value={`${h.score}/100`} sub={h.score >= 70 ? 'healthy' : h.score >= 40 ? 'needs work' : 'at risk'} />
        </div>
      </Card>

      {/* Health snapshot (POC) */}
      <Card style={{ padding: 16 }} data-testid="health-snapshot">
        <strong style={{ fontSize: 13 }}>Health snapshot</strong>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          {SNAP.map(([k, v]) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--cr-ink-2,#0d1117)', border: '1px solid var(--cr-line-1)', borderRadius: 8, padding: '4px 10px', fontSize: 12, color: 'var(--cr-fg-2)' }}>
              {k} <b style={{ color: v > 0 ? 'var(--cr-fg-1)' : 'var(--cr-fg-3)' }}>{v}</b>
            </span>
          ))}
        </div>
      </Card>

      {/* Languages breakdown (sized by symbols, POC-style) */}
      <Card style={{ padding: 16 }}>
        <strong style={{ fontSize: 13 }}>Languages</strong>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
          {langs.slice(0, 13).map((x, i) => (
            <div key={x.l} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="mono" style={{ width: 110, fontSize: 12, color: 'var(--cr-fg-2)' }}>{x.l}</span>
              <span style={{ flex: 1, height: 8, background: 'var(--cr-ink-2,#0d1117)', borderRadius: 4, overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${Math.max(2, Math.round(((x.symbols || x.files) / maxLang) * 100))}%`, background: palette[i % palette.length] }} />
              </span>
              <span style={{ width: 120, textAlign: 'right', fontSize: 11, color: 'var(--cr-fg-3)' }}>{x.symbols} sym · {x.files}f</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Count-only analyzer stats */}
      {DEEPER.length > 0 && (
        <Card style={{ padding: 16 }}>
          <strong style={{ fontSize: 13 }}>Deeper analysis</strong>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 10 }}>
            {DEEPER.map(([k, v]) => <Stat key={k} label={STAT_LABELS[k] || k} value={String(v)} />)}
          </div>
        </Card>
      )}
    </div>
  );
}
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ minWidth: 110 }}>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>{sub}</div>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 30, textAlign: 'center', color: 'var(--cr-fg-3)' }}>{children}</div>;
}
