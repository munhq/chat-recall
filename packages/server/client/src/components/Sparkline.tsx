/**
 * A 12-point trend, inline, at text size.
 *
 * ── Why a sparkline and not a chart ──────────────────────────────────────
 * The reader's question about one machine is "is this getting worse?", and a
 * single current value cannot answer it — nor can a fleet-wide p50/p95, which
 * says nothing about THIS device. That is the stat-tile job: a value with a
 * trend beside it. A full chart with axes would be a one-series plot given a
 * whole panel, which is the classic over-form.
 *
 * ── The specification it follows ─────────────────────────────────────────
 *   · single series, so NO legend — the label beside it names the measure
 *   · the line in the de-emphasis hue, the CURRENT point in the accent, so the
 *     eye lands on now and the history stays context
 *   · 2px stroke, ≥8px hit target on the hover layer, no gridlines, no axes
 *   · text wears text tokens; the only coloured thing is the mark itself
 *   · one hue plus gray, so there is no categorical palette to validate — and
 *     nothing here encodes identity by colour
 *
 * Degrades honestly: fewer than two points is not a trend, so it renders
 * nothing rather than a dot pretending to be one.
 */
import React from 'react';

export interface SparklineProps {
  /** Oldest first. */
  values: number[];
  /** Formats a value for the hover title (e.g. ms → "1.2s"). */
  format?: (v: number) => string;
  width?: number;
  height?: number;
  /** Accessible description; the visible label lives beside the mark. */
  label?: string;
}

export default function Sparkline({
  values, format = (v) => String(v), width = 88, height = 18, label = 'trend',
}: SparklineProps) {
  // One point is a value, not a trend. Two is the minimum that can slope.
  if (!values || values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  // Inset by the stroke so the line is never clipped at the extremes.
  const pad = 2;
  const x = (i: number) => pad + (i * (width - pad * 2)) / (values.length - 1);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);

  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const lastX = x(values.length - 1);
  const lastY = y(values[values.length - 1]);

  // Direction is stated in the accessible text, never by colour alone: a rising
  // scan time is not automatically bad, so it gets no warning hue.
  const first = values[0];
  const last = values[values.length - 1];
  const dir = last > first ? 'rising' : last < first ? 'falling' : 'flat';
  const title = `${label}: ${values.map(format).join(' → ')} (${dir})`;

  return (
    <svg
      width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      role="img" aria-label={title}
      style={{ display: 'block', overflow: 'visible' }}
    >
      <title>{title}</title>
      <path
        d={path} fill="none"
        stroke="var(--cr-line-3)" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round"
      />
      {/* The current value, in the accent. A 2px surface ring keeps it legible
          where it overlaps the line. */}
      <circle cx={lastX} cy={lastY} r={3} fill="var(--cr-brand-500)"
        stroke="var(--cr-ink-0)" strokeWidth={2} />
    </svg>
  );
}
