/**
 * What the collectors have been reporting — the log, in the dashboard.
 *
 * ── Why a table and not a chart ──────────────────────────────────────────
 * This is a stream of typed events across many kinds and devices. There is no
 * magnitude to compare and no trend to trace; the reader wants "what happened,
 * on which machine, when" and then to narrow it. That is a table with filters,
 * and dressing it as a chart would lose the one thing it is for — the detail.
 *
 * The fleet panel above it answers "is anything wrong". This answers "what
 * exactly", which is the question you have once the answer to the first is yes.
 *
 * ── What it will not show ────────────────────────────────────────────────
 * Nothing here can carry transcript content, file paths, project names or
 * session ids: the collector refuses to send those (see cli/telemetry-consent.ts)
 * and the ingest route drops long strings. So a message column is safe to render
 * verbatim — but only because of that, not because it is escaped.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Card, Chip } from './primitives';
import { getCollectorEvents, type CollectorEvent } from '../services/api';

/** Failure kinds get a warning chip; everything else is informational. */
const FAILURE_KINDS = new Set([
  'breaker_trip', 'target_failure', 'sync_error', 'auth_error',
  'mcp_crash', 'index_failed', 'tool_error', 'auto_update_failed',
]);

function when(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 90) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** The measurements on an event, as `key=value` pairs a human can scan. */
function summarise(e: CollectorEvent): string {
  const d = e.data || {};
  const parts = Object.entries(d)
    .filter(([, v]) => v !== null && v !== '' && v !== 0)
    .slice(0, 6)
    .map(([k, v]) => `${k}=${v}`);
  return parts.join(' ');
}

export default function CollectorEvents() {
  const [events, setEvents] = useState<CollectorEvent[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState('');
  // One filter row above the table, as the interaction spec requires.
  const [kind, setKind] = useState<string>('');
  const [device, setDevice] = useState<string>('');
  const [failuresOnly, setFailuresOnly] = useState(false);

  useEffect(() => {
    let on = true;
    getCollectorEvents({ limit: 200 })
      .then((r) => { if (on) { setEvents(r.events); setState('ready'); } })
      .catch((e) => { if (on) { setErr(String(e.message || e)); setState('error'); } });
    return () => { on = false; };
  }, []);

  const kinds = useMemo(
    () => [...new Set(events.map((e) => e.kind))].sort(),
    [events],
  );
  const devices = useMemo(
    () => [...new Set(events.map((e) => e.device_id).filter(Boolean))].sort(),
    [events],
  );

  const shown = useMemo(() => events.filter((e) => {
    if (kind && e.kind !== kind) return false;
    if (device && e.device_id !== device) return false;
    if (failuresOnly && !FAILURE_KINDS.has(e.kind)) return false;
    return true;
  }), [events, kind, device, failuresOnly]);

  if (state === 'loading') return <div style={{ color: 'var(--cr-fg-3)', fontSize: 13 }}>Loading collector events…</div>;
  if (state === 'error') {
    // "We could not load this" must never look like "there is nothing here".
    return <div style={{ color: 'var(--cr-err-500)', fontSize: 13 }}>Could not load collector events: {err}</div>;
  }
  if (events.length === 0) {
    return (
      <div style={{ fontSize: 13, color: 'var(--cr-fg-2)', lineHeight: 1.5 }}>
        No collector events yet. They arrive once a machine syncs — and only when the
        plan includes telemetry and the machine has not opted out.
      </div>
    );
  }

  const sel: React.CSSProperties = {
    fontSize: 11.5, padding: '3px 6px', color: 'var(--cr-fg-2)',
    background: 'transparent', border: '1px solid var(--cr-line-1)', borderRadius: 6,
  };

  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <select style={sel} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by event kind">
          <option value="">All kinds</option>
          {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        {devices.length > 1 && (
          <select style={sel} value={device} onChange={(e) => setDevice(e.target.value)} aria-label="Filter by device">
            <option value="">All machines</option>
            {devices.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        <label style={{ fontSize: 11.5, color: 'var(--cr-fg-2)', display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <input type="checkbox" checked={failuresOnly} onChange={(e) => setFailuresOnly(e.target.checked)} />
          Failures only
        </label>
        <span style={{ color: 'var(--cr-fg-3)', fontSize: 11.5, marginLeft: 'auto' }}>
          {shown.length === events.length
            ? `${events.length} event${events.length === 1 ? '' : 's'}`
            : `${shown.length} of ${events.length}`}
        </span>
      </div>

      {shown.length === 0 ? (
        <div style={{ color: 'var(--cr-fg-3)', fontSize: 12 }}>Nothing matches those filters.</div>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
              <thead>
                <tr style={{ color: 'var(--cr-fg-3)', textAlign: 'left' }}>
                  <th style={{ padding: '7px 10px', fontWeight: 500 }}>When</th>
                  <th style={{ padding: '7px 10px', fontWeight: 500 }}>Event</th>
                  <th style={{ padding: '7px 10px', fontWeight: 500 }}>Machine</th>
                  <th style={{ padding: '7px 10px', fontWeight: 500 }}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e, i) => (
                  <tr key={`${e.ts}-${e.kind}-${i}`} style={{ borderTop: '1px solid var(--cr-line-1)' }}>
                    {/* tabular-nums only in columns, where digits must line up. */}
                    <td style={{ padding: '7px 10px', color: 'var(--cr-fg-3)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                      {when(e.ts)}
                    </td>
                    <td style={{ padding: '7px 10px' }}>
                      {/* Status carries an icon-free label, never colour alone:
                          the chip's text says which kind it is. */}
                      <Chip kind={FAILURE_KINDS.has(e.kind) ? 'warn' : 'neutral'} size="sm">{e.kind}</Chip>
                    </td>
                    <td style={{ padding: '7px 10px', color: 'var(--cr-fg-2)', fontFamily: 'var(--cr-font-mono)' }}>
                      {e.device_id || '—'}
                      {e.cli_version ? <span style={{ color: 'var(--cr-fg-3)' }}> · {e.cli_version}</span> : null}
                    </td>
                    <td style={{ padding: '7px 10px', color: 'var(--cr-fg-2)', fontFamily: 'var(--cr-font-mono)' }}>
                      {summarise(e) || e.message || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
