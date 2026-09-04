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
import { Schedule } from './primitives';
import Sparkline from './Sparkline';
import {
  getFleetHealth, getSecurityConfig, setCollectTelemetry,
  type FleetDeviceHealth, type FleetTelemetrySummary,
} from '../services/api';

/** ms as something a human reads without doing arithmetic. */
function dur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

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
  const [fleet, setFleet] = useState<FleetTelemetrySummary | null>(null);
  // The org-wide telemetry switch. Null while unknown — a toggle that renders
  // before its state is loaded invites a click that flips the wrong way.
  const [collect, setCollect] = useState<{ on: boolean; verifySecrets: boolean } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState('');

  useEffect(() => {
    let on = true;
    getFleetHealth()
      .then((r) => {
        if (!on) return;
        setDevices(r.devices); setSummary(r.summary); setFleet(r.fleetTelemetry ?? null); setState('ready');
      })
      .catch((e) => { if (!on) return; setErr(String(e.message || e)); setState('error'); });
    // Separate and non-blocking: the panel's job is health, and a security-config
    // failure must not stop it rendering.
    getSecurityConfig()
      .then((c) => { if (on) setCollect({ on: c.telemetry, verifySecrets: c.verifySecrets }); })
      .catch(() => { /* older server, or no permission — the toggle stays hidden */ });
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
      {/* ONE SCHEDULE, NOT ONE CARD PER MACHINE. A gapped stack of bordered
          boxes is the card grid this world replaced, and the warning state was
          coded by putting an amber BORDER on the box — a coloured bar on a box
          edge, which the Coded Leader Rule forbids. As rows, the machines line
          up so you can compare them down the column, and the hue rides the
          warning text itself, which is the thing that is actually amber. */}
      <Schedule
        caption={
          summary
            ? [
                attention.length === 0
                  ? `${summary.devices} machine${summary.devices === 1 ? '' : 's'} healthy`
                  : `${attention.length} of ${summary.devices} need attention`,
                summary.pendingFolders > 0
                  ? `${summary.pendingFolders} folder${summary.pendingFolders === 1 ? '' : 's'} awaiting a decision`
                  : null,
              ].filter(Boolean).join(' · ')
            : undefined
        }
        cols={[
          { key: 'machine', kind: 'pn', head: 'Machine' },
          { key: 'state', head: 'State' },
          { key: 'measured', kind: 'rt', head: 'Measured', optional: true },
        ]}
        rows={devices.map((d) => {
          const bad = d.warnings.length > 0;
          let measured: React.ReactNode = null;
          if (d.telemetry) {
            const t = d.telemetry;
            const parts: string[] = [];
            if (t.lastScanMs != null) parts.push(`scan ${dur(t.lastScanMs)}`);
            if (t.rssPeakMb != null) parts.push(`peak ${t.rssPeakMb}MB`);
            const failures = Object.entries(t.failuresByClass)
              .filter(([, n]) => n > 0)
              .sort((a, b) => b[1] - a[1]);
            // Named classes, not a total: "3 rate_limited" is actionable where
            // "3 failures" sends the reader to the logs.
            for (const [cls, n] of failures.slice(0, 3)) parts.push(`${n}× ${cls.replace(/_/g, ' ')}`);
            if (parts.length > 0) {
              measured = (
                <span style={{ display: 'inline-flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
                  {parts.map((x) => <span key={x}>{x}</span>)}
                  {/* The trend, beside the value it belongs to. It answers the
                      question the number alone cannot: is this machine getting
                      slower? */}
                  {t.recentScanMs && t.recentScanMs.length >= 2 && (
                    <Sparkline values={t.recentScanMs} format={dur} label="scan time, recent walks" />
                  )}
                </span>
              );
            }
          }
          return {
            id: d.deviceId,
            cells: {
              machine: (
                <>
                  {d.deviceId}
                  <span className="pn-sub">
                    {d.os || 'unknown OS'}
                    {d.cliVersion ? ` · CLI ${d.cliVersion}` : ''}
                    {` · last seen ${ago(d.lastSeenAt)}`}
                    {d.sessions > 0 ? ` · ${d.sessions.toLocaleString()} sessions` : ''}
                    {d.folders.syncing > 0 ? ` · ${d.folders.syncing} folder${d.folders.syncing === 1 ? '' : 's'} syncing` : ''}
                  </span>
                </>
              ),
              // Problems in plain language. A number the reader has to interpret
              // is a number that gets skipped, so the warning says what is wrong
              // and what it costs.
              state: bad
                ? (
                  <span style={{ color: 'var(--cr-warn-500)' }}>
                    {d.warnings.map((w) => (
                      <span key={w} style={{ display: 'block' }}>{w}</span>
                    ))}
                  </span>
                )
                : <span style={{ color: 'var(--cr-fg-3)' }}>nothing wrong</span>,
              measured,
            },
          };
        })}
      />

      {/* Fleet-wide shape, for the question a per-device card cannot answer:
          how long a sync takes for a real machine, and how much memory it costs.
          Omitted entirely when nothing has reported — zeros would read as
          measured values of zero. */}
      {fleet && fleet.walks > 0 && (
        <div style={{
          marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--cr-line-1)',
          color: 'var(--cr-fg-3)', fontSize: 12.5, display: 'flex', gap: 12, flexWrap: 'wrap',
          fontFamily: 'var(--cr-font-annot)',
        }}>
          <span>{fleet.walks.toLocaleString()} walks (7d)</span>
          {fleet.scanMsP50 != null && <span>scan p50 {dur(fleet.scanMsP50)}</span>}
          {fleet.scanMsP95 != null && <span>p95 {dur(fleet.scanMsP95)}</span>}
          {fleet.rssPeakMbMax != null && <span>peak {fleet.rssPeakMbMax}MB</span>}
          {fleet.versions.length > 1 && (
            <span>{fleet.versions.length} CLI versions in use</span>
          )}
        </div>
      )}

      {/* THE CONSENT CONTROL. Telemetry is collected by default from paying
          tenants, so refusing it must not require editing a file on every
          machine. This is the ORG's answer and a veto: a device's own
          privacy.telemetry=false still wins, and neither side can force a yes.
          Stated in full, because a switch whose effect is unclear is not
          consent. */}
      {collect && (
        <div style={{
          marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--cr-line-1)',
          display: 'flex', gap: 10, alignItems: 'flex-start',
        }}>
          <input
            id="collect-telemetry"
            type="checkbox"
            checked={collect.on}
            onChange={async (e) => {
              const next = e.target.checked;
              setCollect({ ...collect, on: next });          // optimistic
              try { await setCollectTelemetry(next, collect.verifySecrets); }
              catch { setCollect({ ...collect, on: !next }); } // put it back on failure
            }}
            style={{ marginTop: 2, flexShrink: 0 }}
          />
          <label htmlFor="collect-telemetry" style={{ fontSize: 12, color: 'var(--cr-fg-2)', lineHeight: 1.5 }}>
            Let collectors report their own health to this server
            <span style={{ display: 'block', color: 'var(--cr-fg-3)', fontSize: 12.5 }}>
              Walk timings, session counts, failure classes, CLI version and peak memory —
              never transcript content, file paths, project names or session ids.
              It is what makes the warnings above possible. Any machine can also
              refuse locally with <code>CHAT_RECALL_TELEMETRY=0</code>.
            </span>
          </label>
        </div>
      )}

      {summary && summary.unattributedSessions > 0 && (
        <div style={{ color: 'var(--cr-fg-3)', fontSize: 12.5, marginTop: 10 }}>
          {summary.unattributedSessions.toLocaleString()} older sessions predate per-device tracking,
          so they are not attributed above. They are stored and searchable.
        </div>
      )}
    </div>
  );
}
