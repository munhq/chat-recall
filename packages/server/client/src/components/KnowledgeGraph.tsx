/**
 * KnowledgeGraph — the web surface for the temporal knowledge graph.
 *
 * This was a headline backend feature (entities + time-validity triples,
 * auto-extracted during indexing) with ZERO UI until now. Goal: UNDERSTAND —
 * see how facts connect across sessions. Action: pivot — click any entity to
 * re-center the graph on it. When `entity` is passed (project workspace), it
 * opens focused on that entity instead of the global timeline.
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Card, Chip, Input, Icon, SegmentedControl, Metrics, Plates } from './primitives';
import ForceGraph from './ForceGraph';
import { getKgStats, getKgTimeline, queryKgEntity, type KgFact, type KgStats } from '../services/api';

// (The junk-word display filter that used to live here is gone: the entity
// extractor no longer emits fragments — context-gated ambiguous names,
// evidence-based confidence — and migration 0005_kg_junk_cleanup deleted the
// rows the old extractor had already written. The UI renders the KG as-is;
// if garbage ever reappears, fix the extractor, don't re-add a filter.)
const cleanFact = (_f: KgFact) => true;

function fmtWhen(v: number | string | null | undefined): string {
  if (v == null) return '';
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(n)) return String(v);
  const d = new Date(n);
  return d.toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' });
}

export default function KnowledgeGraph({ entity, embedded }: { entity?: string | null; embedded?: boolean }) {
  const [stats, setStats] = useState<KgStats | null>(null);
  const [focus, setFocus] = useState<string | null>(entity ?? null);
  const [input, setInput] = useState('');
  const [facts, setFacts] = useState<KgFact[]>([]);
  const [timeline, setTimeline] = useState<KgFact[]>([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'graph' | 'list'>('graph');

  useEffect(() => { void getKgStats().then(setStats); }, []);
  useEffect(() => { setFocus(entity ?? null); }, [entity]);

  // Global recent timeline (when nothing is focused).
  useEffect(() => {
    if (focus) return;
    let on = true;
    getKgTimeline(undefined, 120).then((r) => { if (on) setTimeline((r.entries || []).filter(cleanFact)); });
    return () => { on = false; };
  }, [focus]);

  // Focused entity → its incoming + outgoing facts.
  const loadFocus = useCallback((name: string) => {
    setLoading(true);
    queryKgEntity(name, { direction: 'both' }).then((r) => { setFacts((r.facts || []).filter(cleanFact)); setLoading(false); });
  }, []);
  useEffect(() => { if (focus) loadFocus(focus); }, [focus, loadFocus]);

  const pivot = (name: string) => { if (name) { setFocus(name); setInput(''); } };

  return (
    <div className={embedded ? undefined : 'cr-pad-mobile'} style={{ flex: 1, overflow: 'auto', padding: embedded ? '4px 0 40px' : '24px 28px 56px' }}>
      {!embedded && (
        <div style={{ marginBottom: 18 }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="brain" size={20} /> Knowledge graph</h2>
          <div style={{ color: 'var(--cr-fg-2)', fontSize: 13, marginTop: 4 }}>Temporal facts auto-extracted from your work — what you use, what you chose, who works on what.</div>
        </div>
      )}

      {/* The stat strip becomes one schedule. Five tiles, each a big number
          over an uppercase eyebrow, gave "expired: 0" the same weight as
          "facts: 3" and answered nothing. */}
      {stats && (
        <Metrics
          style={{ marginBottom: 16 }}
          caption={embedded ? undefined : 'Graph size'}
          items={[
            { label: 'Entities', value: stats.entities.toLocaleString(), sub: 'projects, tools and people' },
            { label: 'Facts', value: stats.current_facts.toLocaleString(), sub: 'true right now', tone: 'ok' },
            { label: 'Facts, all time', value: stats.triples.toLocaleString(), sub: `${stats.expired_facts.toLocaleString()} since expired` },
            { label: 'Relationship types', value: String(Array.isArray(stats.relationship_types) ? stats.relationship_types.length : stats.relationship_types) },
          ]}
        />
      )}

      {/* Entity search / pivot */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, maxWidth: 520 }}>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter' && input.trim()) pivot(input.trim()); }}
          icon="search"
          placeholder="Focus an entity (project, tool, person)…"
          onClear={input ? () => setInput('') : undefined}
          inputSize="md"
          style={{ flex: 1 }}
        />
        {focus && <Chip kind="brand" size="md">focused: {focus} <span onClick={() => setFocus(null)} style={{ cursor: 'pointer', marginLeft: 6, display: 'inline-flex' }}><Icon name="x" size={11} /></span></Chip>}
      </div>

      {focus ? (
        <>
          <div style={{ marginBottom: 12, maxWidth: 240 }}>
            <SegmentedControl value={view} onChange={(v) => setView(v as 'graph' | 'list')} options={[{ value: 'graph', label: 'Graph' }, { value: 'list', label: 'List' }]} />
          </div>
          {loading ? <Empty>Loading facts about {focus}…</Empty>
            : facts.length === 0 ? <Empty>No facts recorded about <b>{focus}</b> yet. As you work, the indexer extracts decisions and tools into the graph.</Empty>
            : view === 'graph' ? <KgGraph center={focus} facts={facts} onPivot={pivot} />
            : <FocusedView name={focus} facts={facts} loading={loading} onPivot={pivot} />}
        </>
      ) : (
        <TimelineView entries={timeline} onPivot={pivot} />
      )}
    </div>
  );
}

function FocusedView({ name, facts, loading, onPivot }: { name: string; facts: KgFact[]; loading: boolean; onPivot: (n: string) => void }) {
  if (loading) return <Empty>Loading facts about {name}…</Empty>;
  if (!facts.length) return <Empty>No facts recorded about <b>{name}</b> yet. As you work, the indexer extracts decisions and tools into the graph.</Empty>;
  const out = facts.filter((f) => f.direction !== 'incoming');
  const inc = facts.filter((f) => f.direction === 'incoming');
  return (
    /* Two panels SHARING ONE FRAME. Outgoing and incoming facts are two halves
       of one statement about this entity, so they are divided by a rule rather
       than separated by a gap into two boxes. */
    <Plates cols={2}>
      <div>
        <span className="cr-plate-t">{name} points to</span>
        <div style={{ color: 'var(--cr-fg-3)', fontSize: 12.5, margin: '3px 0 10px' }}>outgoing facts</div>
        {out.length === 0 ? <Empty small>none</Empty> : out.map((f, i) => <FactRow key={i} f={f} side="object" onPivot={onPivot} />)}
      </div>
      <div>
        <span className="cr-plate-t">points to {name}</span>
        <div style={{ color: 'var(--cr-fg-3)', fontSize: 12.5, margin: '3px 0 10px' }}>incoming facts</div>
        {inc.length === 0 ? <Empty small>none</Empty> : inc.map((f, i) => <FactRow key={i} f={f} side="subject" onPivot={onPivot} />)}
      </div>
    </Plates>
  );
}

function TimelineView({ entries, onPivot }: { entries: KgFact[]; onPivot: (n: string) => void }) {
  if (!entries.length) return <Empty>The knowledge graph is empty. It populates automatically as you index sessions (decisions, tools, projects, people).</Empty>;
  return (
    <Card style={{ padding: 14 }}>
      <strong style={{ fontSize: 13 }}>Recent facts</strong>
      <div style={{ color: 'var(--cr-fg-3)', fontSize: 12, marginBottom: 10 }}>click any entity to focus the graph on it</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {entries.map((f, i) => <FactRow key={i} f={f} side="both" onPivot={onPivot} />)}
      </div>
    </Card>
  );
}

function FactRow({ f, side, onPivot }: { f: KgFact; side: 'subject' | 'object' | 'both'; onPivot: (n: string) => void }) {
  const ent = (txt: string, active: boolean) => (
    <button onClick={() => onPivot(txt)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--cr-font-mono)', fontSize: 12, color: active ? 'var(--cr-brand-500)' : 'var(--cr-fg-2)', fontWeight: active ? 600 : 400 }}>{txt}</button>
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--cr-line-1)', flexWrap: 'wrap' }}>
      {ent(f.subject, side === 'subject')}
      <Chip kind={f.current === false ? 'neutral' : 'info'} size="sm">{f.predicate}</Chip>
      {ent(f.object, side === 'object')}
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
        {f.current === false && <Chip kind="neutral" size="sm">expired</Chip>}
        {(f.valid_from || f.valid_to) ? <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>{fmtWhen(f.valid_from)}{f.valid_to ? `–${fmtWhen(f.valid_to)}` : ''}</span> : null}
      </span>
    </div>
  );
}

// ── Visual graph: center entity + its facts as nodes / labeled edges ─────────
// Thin adapter over the shared ForceGraph (components/ForceGraph.tsx): maps
// facts to nodes/labeled edges (dashed = expired), keeps the KG-specific
// layout tuning, and pivots on node click (the center node is inert).
const KG_LAYOUT = { kRepFactor: 0.95, kSpring: 0.02, springLenFactor: 1.4, center: 0.003, initialRadius: 0.34 };
function KgGraph({ center, facts, onPivot }: { center: string; facts: KgFact[]; onPivot: (n: string) => void }) {
  const { nodes, edges } = useMemo(() => {
    const set = new Map<string, { id: string }>([[center, { id: center }]]);
    const eds: Array<{ from: string; to: string; label: string; expired: boolean }> = [];
    for (const f of facts.slice(0, 60)) {
      const other = f.direction === 'incoming' ? f.subject : f.object;
      if (!other || other === center) continue;
      if (!set.has(other)) set.set(other, { id: other });
      eds.push(f.direction === 'incoming'
        ? { from: f.subject, to: center, label: f.predicate, expired: f.current === false }
        : { from: center, to: other, label: f.predicate, expired: f.current === false });
    }
    return { nodes: [...set.values()], edges: eds };
  }, [center, facts]);
  const fgNodes = useMemo(() => nodes.map((n) => {
    const isC = n.id === center;
    return {
      id: n.id,
      label: n.id,
      r: isC ? 12 : 7,
      fill: isC ? 'var(--cr-brand-500)' : 'var(--cr-ink-2)',
      stroke: 'var(--cr-brand-500)',
      strokeWidth: 1.2,
      opacity: 0.95,
      labelSize: isC ? 11 : 9,
      labelColor: isC ? 'var(--cr-fg-1)' : 'var(--cr-fg-2)',
      labelGap: 4,
      clickable: !isC,
    };
  }), [nodes, center]);
  const fgEdges = useMemo(() => edges.map((e) => ({
    from: e.from,
    to: e.to,
    label: e.label,
    color: 'var(--cr-line-2)',
    width: 1.2,
    opacity: e.expired ? 0.25 : 0.55,
    dashed: e.expired,
  })), [edges]);
  return <ForceGraph nodes={fgNodes} edges={fgEdges} onNode={onPivot} resetKey={center} layout={KG_LAYOUT} />;
}

function Empty({ children, small }: { children: React.ReactNode; small?: boolean }) {
  return <div style={{ padding: small ? '8px 0' : 24, color: 'var(--cr-fg-3)', fontSize: 13, textAlign: small ? 'left' : 'center' }}>{children}</div>;
}
