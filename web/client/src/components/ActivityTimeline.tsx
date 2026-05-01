/**
 * Activity Timeline — chronological view of file edits across recent
 * Claude Code sessions. Sourced from a live transcript scan so the
 * currently-running session shows up immediately.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Card, Chip, Input, Button, SegmentedControl } from './primitives';
import { getEditsTimeline, type EditRow, type EditOp } from '../services/api';

interface Props {
  onSessionClick?: (sessionId: string) => void;
}

const PRESETS = [
  { label: '1h',  value: 1 },
  { label: '6h',  value: 6 },
  { label: '24h', value: 24 },
  { label: '7d',  value: 24 * 7 },
];

const OP_LABELS: Record<EditOp, string> = {
  edit: 'Edit',
  write: 'Write',
  multi_edit: 'MultiEdit',
  notebook_edit: 'NotebookEdit',
  read: 'Read',
};

const OP_TONE: Record<EditOp, 'ok' | 'info' | 'warn' | 'neutral'> = {
  write: 'ok',
  edit: 'info',
  multi_edit: 'info',
  notebook_edit: 'info',
  read: 'neutral',
};

function formatTs(iso: string | undefined, ms: number): string {
  const d = iso ? new Date(iso) : new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  // Local time, "MM-DD HH:MM:SS" — short and unambiguous.
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function shortFile(file: string): string {
  // Strip $HOME-ish prefixes for readability while keeping the structure.
  const home = '/home/';
  if (file.startsWith(home)) {
    const rest = file.slice(home.length);
    const slash = rest.indexOf('/');
    if (slash > 0) return '~' + rest.slice(slash);
  }
  return file;
}

export default function ActivityTimeline({ onSessionClick }: Props) {
  const [sinceHours, setSinceHours] = useState<number>(24);
  const [pattern, setPattern] = useState('');
  const [includeReads, setIncludeReads] = useState(false);
  const [edits, setEdits] = useState<EditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getEditsTimeline({
      sinceHours,
      pattern: pattern.trim() || undefined,
      includeReads,
      limit: 500,
    })
      .then((res) => {
        if (cancelled) return;
        setEdits(res.edits);
        setTotal(res.total);
        setTruncated(res.truncated);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setEdits([]);
        setTotal(0);
        setTruncated(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sinceHours, pattern, includeReads]);

  const grouped = useMemo(() => {
    const out: { sessionId: string; project: string; latest: number; rows: EditRow[] }[] = [];
    const idx = new Map<string, number>();
    for (const e of edits) {
      const key = e.sessionId;
      if (!idx.has(key)) {
        idx.set(key, out.length);
        out.push({ sessionId: e.sessionId, project: e.projectPath, latest: e.ts, rows: [] });
      }
      const slot = out[idx.get(key)!];
      slot.rows.push(e);
      if (e.ts > slot.latest) slot.latest = e.ts;
    }
    out.sort((a, b) => b.latest - a.latest);
    return out;
  }, [edits]);

  const distinctSessions = grouped.length;
  const distinctFiles = useMemo(() => new Set(edits.map(e => e.file)).size, [edits]);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--cr-fg-1)' }}>
          Activity Timeline
        </h2>
        <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
          live transcript scan — includes the active session
        </span>
      </div>

      <Card style={{ padding: 14, marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>Window</span>
            <SegmentedControl
              options={PRESETS.map(p => ({ value: String(p.value), label: p.label }))}
              value={String(sinceHours)}
              onChange={(v) => setSinceHours(Number(v))}
              size="sm"
            />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="Filter by file path substring (e.g. src/core)"
              onClear={pattern ? () => setPattern('') : undefined}
              inputSize="sm"
            />
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--cr-fg-2)' }}>
            <input
              type="checkbox"
              checked={includeReads}
              onChange={(e) => setIncludeReads(e.target.checked)}
            />
            Include reads
          </label>
          <Button size="sm" variant="ghost" onClick={() => { setPattern(''); setIncludeReads(false); setSinceHours(24); }}>
            Reset
          </Button>
        </div>
      </Card>

      <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <Chip kind="info">{total} edit{total === 1 ? '' : 's'}</Chip>
        <Chip kind="neutral">{distinctSessions} session{distinctSessions === 1 ? '' : 's'}</Chip>
        <Chip kind="neutral">{distinctFiles} file{distinctFiles === 1 ? '' : 's'}</Chip>
        {truncated && <Chip kind="warn">truncated — narrow filter to see more</Chip>}
      </div>

      {error && (
        <Card style={{ padding: 12, marginBottom: 12, borderColor: 'var(--cr-err-500)' }}>
          <span style={{ color: 'var(--cr-err-500)' }}>Error: {error}</span>
        </Card>
      )}

      {loading && (
        <div style={{ color: 'var(--cr-fg-3)', fontSize: 13, padding: 16 }}>Scanning transcripts…</div>
      )}

      {!loading && grouped.length === 0 && !error && (
        <div style={{ color: 'var(--cr-fg-3)', fontSize: 13, padding: 16 }}>
          No edits in the last {sinceHours}h{pattern ? ` matching "${pattern}"` : ''}.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {grouped.map((g) => (
          <Card key={g.sessionId} style={{ padding: 12 }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
              gap: 8,
              flexWrap: 'wrap',
            }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button
                  onClick={() => onSessionClick?.(g.sessionId)}
                  style={{
                    background: 'transparent',
                    border: 0,
                    padding: 0,
                    color: 'var(--cr-brand-500)',
                    fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)',
                    fontSize: 12,
                    cursor: onSessionClick ? 'pointer' : 'default',
                    textDecoration: onSessionClick ? 'underline' : 'none',
                  }}
                  title={g.sessionId}
                >
                  {g.sessionId.slice(0, 8)}
                </button>
                <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>{g.project}</span>
              </div>
              <Chip kind="neutral" size="sm">{g.rows.length} edit{g.rows.length === 1 ? '' : 's'}</Chip>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <tbody>
                {g.rows.map((e, i) => (
                  <tr key={`${e.sessionId}-${e.line}-${i}`} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--cr-line-1)' }}>
                    <td style={{ padding: '6px 8px 6px 0', color: 'var(--cr-fg-3)', whiteSpace: 'nowrap', fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)' }}>
                      {formatTs(e.tsIso, e.ts)}
                    </td>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                      <Chip kind={OP_TONE[e.op]} size="sm">{OP_LABELS[e.op]}</Chip>
                    </td>
                    <td style={{ padding: '6px 0', color: 'var(--cr-fg-1)', fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)', wordBreak: 'break-all' }}>
                      {shortFile(e.file)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))}
      </div>
    </div>
  );
}
