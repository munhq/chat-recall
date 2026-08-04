/**
 * "Is chat-recall actually working on my machines?" — the panel.
 *
 * Every silent failure in this product was found by someone asking about one
 * specific session, then digging. That is because healthy and broken look
 * identical from outside: a sync prints `15604 skipped` either way, a daemon on
 * two-day-old code logs nothing unusual, and a transcript folder nobody approved
 * is simply absent from every view.
 *
 * So this leads with the PROBLEMS, in words, and only then shows the numbers.
 * A device with nothing wrong collapses to a single quiet line — if everything
 * shouted, nobody would read it.
 */
import React, { useEffect, useState } from 'react';
import { Card, Chip } from './primitives';
import { getFleetHealth, type FleetDeviceHealth } from '../services/api';

function ago(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 90) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function FleetHealth() {
  const [devices, setDevices] = useState<FleetDeviceHealth[]>([]);
  const [summary, setSummary] = useState<{ devices: number; healthy: number; needsAttention: number; pendingFolders: number; unattributedSessions: number } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState('');

  useEffect(() => {
    let on = true;
    getFleetHealth()
      .then((r) => { if (!on) return; setDevices(r.devices); setSummary(r.summary); setState('ready'); })
      .catch((e) => { if (!on) return; setErr(String(e.message || e)); setState('error'); });
    return () => { on = false; };
  }, []);

  if (state === 'loading') return <div style={{ color: 'var(--cr-fg-3)', fontSize: 13 }}>Checking your machines…</div>;
  if (state === 'error') {
    // Never render a reassuring empty state on failure — "we could not check" and
    // "everything is fine" must not look the same.
    return <div style={{ color: 'var(--cr-err-500)', fontSize: 13 }}>Could not check device health: {err}</div>;
  }
  if (devices.length === 0) {
    return (
      <div style={{ fontSize: 13, color: 'var(--cr-fg-2)', lineHeight: 1.5 }}>
        No machines connected yet. Install the collector and run <code>chat-recall login</code>,
        then <code>chat-recall init</code>.
      </div>
    );
  }

  const attention = devices.filter((d) => d.warnings.length > 0);

  return (
    <div style={{ fontSize: 13 }}>
      {summary && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
          <Chip kind={attention.length === 0 ? 'ok' : 'warn'} size="sm">
            {attention.length === 0
              ? `${summary.devices} machine${summary.devices === 1 ? '' : 's'} healthy`
              : `${attention.length} of ${summary.devices} need attention`}
          </Chip>
          {summary.pendingFolders > 0 && (
            <Chip kind="warn" size="sm">{summary.pendingFolders} folder(s) awaiting a decision</Chip>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {devices.map((d) => {
          const bad = d.warnings.length > 0;
          return (
            <Card key={d.deviceId} style={{
              padding: '10px 12px',
              border: bad ? '1px solid var(--cr-warn-500, #c98a00)' : '1px solid var(--cr-line-1)',
            }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, color: 'var(--cr-fg-1)' }}>{d.deviceId}</span>
                <span style={{ color: 'var(--cr-fg-3)', fontSize: 11.5 }}>
                  {d.os || 'unknown OS'}
                  {d.cliVersion ? ` · CLI ${d.cliVersion}` : ''}
                  {` · last seen ${ago(d.lastSeenAt)}`}
                  {d.sessions > 0 ? ` · ${d.sessions.toLocaleString()} sessions` : ''}
                  {d.folders.syncing > 0 ? ` · ${d.folders.syncing} folder${d.folders.syncing === 1 ? '' : 's'} syncing` : ''}
                </span>
              </div>
              {/* Problems in plain language. A number the reader has to interpret
                  is a number that gets skipped, so the warning says what is wrong
                  and what it costs. */}
              {bad && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: 'var(--cr-fg-1)', lineHeight: 1.5 }}>
                  {d.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              )}
            </Card>
          );
        })}
      </div>

      {summary && summary.unattributedSessions > 0 && (
        <div style={{ color: 'var(--cr-fg-3)', fontSize: 11.5, marginTop: 10 }}>
          {summary.unattributedSessions.toLocaleString()} older sessions predate per-device tracking,
          so they are not attributed above. They are stored and searchable.
        </div>
      )}
    </div>
  );
}
