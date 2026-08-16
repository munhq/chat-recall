/**
 * ForceGraph — shared, dependency-free force-directed SVG graph.
 *
 * Extracted from KnowledgeGraph (KgGraph) and CodeExplorer (CircleGraph),
 * which carried near-identical engines. One fixed-iteration force sim
 * (pairwise repulsion + edge springs + centering) followed by wheel-zoom /
 * drag-pan on a viewBox <g> transform. Callers describe nodes/edges
 * declaratively; click-to-pivot goes through onNode (suppressed while
 * dragging so a pan never triggers a pivot).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';

export interface ForceGraphNode {
  id: string;
  label: string;
  /** Circle radius in SVG units. */
  r: number;
  fill: string;
  /** Circle fill opacity (default 0.85). */
  opacity?: number;
  stroke?: string;
  /** Base stroke width — divided by the zoom factor like edge widths. */
  strokeWidth?: number;
  /** Base label font size (divided by zoom, floored at 7). Default 10. */
  labelSize?: number;
  labelColor?: string;
  /** Gap between circle edge and label baseline. Default 5. */
  labelGap?: number;
  /** When false the node ignores onNode (e.g. the already-focused center). */
  clickable?: boolean;
  /** Hover tooltip (<title>). Defaults to the id. */
  title?: string;
}

export interface ForceGraphEdge {
  from: string;
  to: string;
  /** Optional midpoint label (e.g. KG predicate). */
  label?: string;
  color?: string;
  dashed?: boolean;
  opacity?: number;
  /** Base stroke width — divided by the zoom factor. Default 1. */
  width?: number;
}

/** Tuning knobs for the layout sim — both former engines differed slightly. */
export interface ForceLayoutParams {
  /** Repulsion strength factor (× W·H / n). */
  kRepFactor: number;
  kSpring: number;
  /** Spring rest length factor (× min(W,H) / √n). */
  springLenFactor: number;
  /** Pull-to-center strength. */
  center: number;
  /** Initial ring radius factor (× min(W,H)). */
  initialRadius: number;
}

export const DEFAULT_LAYOUT: ForceLayoutParams = {
  kRepFactor: 0.9,
  kSpring: 0.025,
  springLenFactor: 1.25,
  center: 0.0025,
  initialRadius: 0.32,
};

export function forceLayout(
  nodes: Array<{ id: string }>,
  edges: Array<{ from: string; to: string }>,
  W: number,
  H: number,
  params: ForceLayoutParams = DEFAULT_LAYOUT,
): Array<{ x: number; y: number }> {
  const n = nodes.length;
  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
  const pos = nodes.map((_, i) => {
    const a = (i / Math.max(1, n)) * Math.PI * 2;
    return {
      x: W / 2 + Math.cos(a) * Math.min(W, H) * params.initialRadius,
      y: H / 2 + Math.sin(a) * Math.min(W, H) * params.initialRadius,
      vx: 0,
      vy: 0,
    };
  });
  const E = edges
    .map((e) => [idx.get(e.from), idx.get(e.to)] as [number | undefined, number | undefined])
    .filter(([a, b]) => a != null && b != null) as Array<[number, number]>;
  const ITER = 160;
  const kRep = ((W * H) / Math.max(1, n)) * params.kRepFactor;
  const springLen = (Math.min(W, H) / Math.sqrt(Math.max(2, n))) * params.springLenFactor;
  const damp = 0.85;
  for (let it = 0; it < ITER; it++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
        const d2 = dx * dx + dy * dy + 0.01;
        const d = Math.sqrt(d2);
        const f = kRep / d2;
        const fx = (f * dx) / d, fy = (f * dy) / d;
        pos[i].vx += fx; pos[i].vy += fy; pos[j].vx -= fx; pos[j].vy -= fy;
      }
    }
    for (const [a, b] of E) {
      const dx = pos[b].x - pos[a].x, dy = pos[b].y - pos[a].y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = params.kSpring * (d - springLen);
      const fx = (f * dx) / d, fy = (f * dy) / d;
      pos[a].vx += fx; pos[a].vy += fy; pos[b].vx -= fx; pos[b].vy -= fy;
    }
    for (let i = 0; i < n; i++) {
      pos[i].vx += (W / 2 - pos[i].x) * params.center;
      pos[i].vy += (H / 2 - pos[i].y) * params.center;
      pos[i].vx *= damp; pos[i].vy *= damp;
      pos[i].x += pos[i].vx; pos[i].y += pos[i].vy;
    }
  }
  return pos.map((p) => ({ x: p.x, y: p.y }));
}

export default function ForceGraph({
  nodes,
  edges,
  onNode,
  resetKey,
  layout = DEFAULT_LAYOUT,
  width = 760,
  height = 520,
}: {
  nodes: ForceGraphNode[];
  edges: ForceGraphEdge[];
  onNode?: (id: string) => void;
  /** View (zoom/pan) resets whenever this changes. */
  resetKey?: unknown;
  layout?: ForceLayoutParams;
  width?: number;
  height?: number;
}) {
  const W = width, H = height;
  const pos = useMemo(() => forceLayout(nodes, edges, W, H, layout), [nodes, edges, W, H, layout]);
  const idx = useMemo(() => new Map(nodes.map((n, i) => [n.id, i])), [nodes]);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ mx: number; my: number; vx: number; vy: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  useEffect(() => { setView({ k: 1, x: 0, y: 0 }); }, [resetKey]);

  const toSvg = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (cx - r.left) * (W / r.width), y: (cy - r.top) * (H / r.height) };
  };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const m = toSvg(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setView((v) => {
      const k = Math.min(9, Math.max(0.4, v.k * factor));
      return { k, x: m.x - (m.x - v.x) * (k / v.k), y: m.y - (m.y - v.y) * (k / v.k) };
    });
  };
  // Pointer, not mouse, events: the same handlers then drive finger drag on a
  // phone. Paired with `touch-action: pan-y` below, a horizontal drag pans the
  // graph while a vertical swipe still scrolls the page.
  const onDown = (e: React.PointerEvent) => {
    drag.current = { mx: e.clientX, my: e.clientY, vx: view.x, vy: view.y };
    setGrabbing(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const r = svgRef.current!.getBoundingClientRect();
    const dx = (e.clientX - drag.current.mx) * (W / r.width);
    const dy = (e.clientY - drag.current.my) * (H / r.height);
    setView((v) => ({ ...v, x: drag.current!.vx + dx, y: drag.current!.vy + dy }));
  };
  const onUp = () => { drag.current = null; setGrabbing(false); };

  const btn = {
    background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)', borderRadius: 6,
    color: 'var(--cr-fg-2)', cursor: 'pointer', width: 26, height: 24, fontSize: 13,
  } as React.CSSProperties;

  return (
    <div style={{ position: 'relative' }}>
      <div className="cr-graph-ctl" style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4, zIndex: 2 }}>
        <button style={btn} title="Zoom in" aria-label="Zoom in" onClick={() => setView((v) => ({ ...v, k: Math.min(9, v.k * 1.3) }))}>+</button>
        <button style={btn} title="Zoom out" aria-label="Zoom out" onClick={() => setView((v) => ({ ...v, k: Math.max(0.4, v.k / 1.3) }))}>−</button>
        <button style={{ ...btn, width: 'auto', padding: '0 8px' }} title="Reset view" onClick={() => setView({ k: 1, x: 0, y: 0 })}>reset</button>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        /* aspectRatio + height:auto, NOT a fixed height: with a fixed 520px box
         * the viewBox scales to the narrow width and letterboxes ~283px of dead
         * space on a phone. maxHeight keeps the desktop size unchanged. */
        style={{ maxWidth: '100%', width: '100%', height: 'auto', aspectRatio: `${W} / ${H}`, maxHeight: H, background: 'var(--cr-ink-1)', borderRadius: 8, cursor: grabbing ? 'grabbing' : 'grab', touchAction: 'pan-y', userSelect: 'none' }}
        onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={onUp}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {edges.map((e, i) => {
            const a = idx.get(e.from), b = idx.get(e.to);
            if (a == null || b == null) return null;
            const mx = (pos[a].x + pos[b].x) / 2, my = (pos[a].y + pos[b].y) / 2;
            return (
              <g key={i}>
                <line
                  x1={pos[a].x} y1={pos[a].y} x2={pos[b].x} y2={pos[b].y}
                  stroke={e.color || 'var(--cr-line-1)'}
                  strokeWidth={(e.width ?? 1) / view.k}
                  opacity={e.opacity ?? 0.4}
                  strokeDasharray={e.dashed ? '4 3' : undefined}
                />
                {e.label && (
                  <text x={mx} y={my} textAnchor="middle" fontSize={Math.max(6, 8 / view.k)} fill="var(--cr-fg-3)" style={{ pointerEvents: 'none' }}>
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}
          {nodes.map((n, i) => {
            const clickable = !!onNode && n.clickable !== false;
            return (
              <g key={n.id} style={{ cursor: clickable ? 'pointer' : 'default' }} onClick={() => { if (!drag.current && clickable) onNode!(n.id); }}>
                <circle
                  cx={pos[i].x} cy={pos[i].y} r={n.r}
                  fill={n.fill}
                  stroke={n.stroke}
                  strokeWidth={n.stroke ? (n.strokeWidth ?? 1.2) / view.k : undefined}
                  opacity={n.opacity ?? 0.85}
                >
                  <title>{n.title ?? n.id}</title>
                </circle>
                <text
                  x={pos[i].x}
                  y={pos[i].y - n.r - (n.labelGap ?? 5)}
                  textAnchor="middle"
                  fontSize={Math.max(7, (n.labelSize ?? 10) / view.k)}
                  fill={n.labelColor || 'var(--cr-fg-2)'}
                  style={{ fontFamily: 'var(--cr-font-mono)', pointerEvents: 'none' }}
                >
                  {n.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
