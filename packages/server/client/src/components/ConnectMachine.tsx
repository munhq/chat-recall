/**
 * Connect-your-machine onboarding — the missing bridge between "I subscribed"
 * and "I see my data". Mints a device sync token in the UI (previously
 * CLI-only, which was circular: the CLI needs the token you could only get
 * from the CLI), renders the exact commands to run, and watches sync status
 * live until the first data lands.
 *
 * Used in two places:
 *  - AccountPage → "Connected devices" (manage: list, mint, revoke)
 *  - CommandCenter first-run hero (cloud edition, zero sessions)
 */
import React, { useEffect, useRef, useState } from 'react';
import { Card, Button, Chip } from './primitives';
import {
  getMe, createTeam, mintDeviceToken, listDevices, revokeDevice, getSyncStatus,
  type DeviceInfo,
} from '../services/api';

/** Public server origin for the `chat-recall login` command. Cloud builds set
 *  VITE_API_BASE (…/api); local mode serves the API on the same origin. */
function serverOrigin(): string {
  const base = (import.meta.env.VITE_API_BASE as string | undefined) || '';
  if (base) return base.replace(/\/api\/?$/, '');
  return window.location.origin;
}

function CopyBlock({ text, masked }: { text: string; masked?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, marginTop: 8 }}>
      <pre style={{
        flex: 1, margin: 0, padding: '10px 12px', borderRadius: 'var(--cr-radius-md, 8px)',
        border: '1px solid var(--cr-line-1)', background: 'var(--cr-ink-0)', color: 'var(--cr-fg-1)',
        fontSize: 12.5, lineHeight: 1.6, overflowX: 'auto', whiteSpace: 'pre',
      }}>{masked ? text.replace(/ct_[a-f0-9]+/g, (m) => m.slice(0, 8) + '…') : text}</pre>
      <Button
        variant="secondary"
        onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        aria-label="Copy to clipboard"
      >{copied ? 'Copied ✓' : 'Copy'}</Button>
    </div>
  );
}

export default function ConnectMachine({ compact, onFirstData }: { compact?: boolean; onFirstData?: () => void }) {
  const [teamSlug, setTeamSlug] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [deviceName, setDeviceName] = useState('');
  const [minted, setMinted] = useState<{ deviceId: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [synced, setSynced] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function resolveTeam(): Promise<string> {
    const me = await getMe();
    if (me.teams.length > 0) return me.teams[0].team_slug;
    // First run before any workspace exists — mirror StartTrialButton's flow.
    const name = me.user.email?.split('@')[0]?.replace(/[^a-z0-9]/gi, '') || 'workspace';
    return (await createTeam(name)).slug;
  }

  useEffect(() => {
    let on = true;
    resolveTeam()
      .then(async (slug) => {
        if (!on) return;
        setTeamSlug(slug);
        setDevices(await listDevices(slug).catch(() => []));
      })
      .catch((e) => { if (on) setErr(String(e.message || e)); });
    return () => { on = false; };
  }, []);

  // After a mint, watch sync status until the first session arrives. That
  // moment — not the payment — is when the product starts existing for the
  // user, so celebrate it explicitly.
  useEffect(() => {
    if (!minted) return;
    pollRef.current = setInterval(async () => {
      try {
        const s = await getSyncStatus();
        setSynced(s.sessions);
        if (s.sessions > 0) {
          if (pollRef.current) clearInterval(pollRef.current);
          onFirstData?.();
        }
      } catch { /* server hiccup — keep polling */ }
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [minted]);

  async function mint() {
    if (!teamSlug) return;
    setBusy(true); setErr('');
    try {
      const name = (deviceName.trim() || 'my-machine').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      const r = await mintDeviceToken(teamSlug, name);
      setMinted({ deviceId: r.device_id, token: r.token });
      setDevices(await listDevices(teamSlug).catch(() => devices));
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(deviceId: string) {
    if (!teamSlug) return;
    if (!confirm(`Revoke "${deviceId}"? That machine will stop syncing until you mint it a new token.`)) return;
    try {
      await revokeDevice(teamSlug, deviceId);
      setDevices(await listDevices(teamSlug));
    } catch (e: any) { setErr(String(e.message || e)); }
  }

  const origin = serverOrigin();
  const activeDevices = devices.filter(d => !d.revoked);

  return (
    <Card style={{ padding: compact ? 16 : 22 }}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
        {compact ? 'Connect your machine' : 'Connected devices'}
      </div>
      <div style={{ color: 'var(--cr-fg-2)', fontSize: 13, lineHeight: 1.55, marginBottom: 4 }}>
        chat-recall indexes the AI-coding sessions already on your machine (Claude Code, Gemini CLI,
        OpenCode, Codex), redacts secrets locally, and syncs them here. Three commands and your
        history becomes searchable.
      </div>
      {err && <div style={{ color: 'var(--cr-err-500)', fontSize: 13, margin: '8px 0' }}>{err}</div>}

      {!minted ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="device name, e.g. work-laptop"
              aria-label="Device name"
              style={{
                flex: '1 1 220px', font: 'inherit', fontSize: 13, padding: '9px 12px',
                borderRadius: 'var(--cr-radius-md, 8px)', border: '1px solid var(--cr-line-2)',
                background: 'var(--cr-ink-0)', color: 'var(--cr-fg-1)',
              }}
            />
            <Button variant="primary" onClick={mint} disabled={busy || !teamSlug}>
              {busy ? 'Generating…' : 'Generate connect commands'}
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, color: 'var(--cr-fg-2)' }}>
            <strong style={{ color: 'var(--cr-fg-1)' }}>1.</strong> Install the CLI (Node 18+, no build tools needed) —
            served by this server, always version-matched:
          </div>
          <CopyBlock text={`curl -fsSL ${origin}/install.sh | sh`} />
          <div style={{ fontSize: 13, color: 'var(--cr-fg-2)', marginTop: 12 }}>
            <strong style={{ color: 'var(--cr-fg-1)' }}>2.</strong> Connect <Chip size="sm">{minted.deviceId}</Chip> —
            this token is shown <strong>once</strong>; copy the whole line:
          </div>
          <CopyBlock text={`chat-recall login ${origin} --token ${minted.token}`} masked />
          <div style={{ fontSize: 13, color: 'var(--cr-fg-2)', marginTop: 12 }}>
            <strong style={{ color: 'var(--cr-fg-1)' }}>3.</strong> Sync your history (then keep it live with the watch daemon):
          </div>
          <CopyBlock text="chat-recall sync" />
          <div style={{
            marginTop: 14, padding: '10px 12px', borderRadius: 'var(--cr-radius-md, 8px)', fontSize: 13,
            border: '1px solid var(--cr-line-1)',
            background: synced && synced > 0 ? 'var(--cr-ok-surf, #10241a)' : 'var(--cr-ink-1)',
            color: synced && synced > 0 ? 'var(--cr-ok-500, #4ade80)' : 'var(--cr-fg-2)',
          }}>
            {synced && synced > 0
              ? <>✓ First data arrived — {synced} session(s) synced. You're live.</>
              : <><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--cr-warn-500, #fbbf24)', marginRight: 8 }} />Waiting for the first sync from {minted.deviceId}…</>}
          </div>
          <div style={{ marginTop: 10 }}>
            <Button variant="secondary" onClick={() => { setMinted(null); setSynced(null); }}>Connect another machine</Button>
          </div>
        </div>
      )}

      {!compact && devices.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--cr-fg-2)', marginBottom: 6 }}>Devices</div>
          {devices.map((d) => (
            <div key={d.deviceId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--cr-line-1)', fontSize: 13 }}>
              <span style={{ flex: 1 }}>{d.deviceId}</span>
              <span style={{ color: 'var(--cr-fg-3)' }}>{new Date(d.createdAt).toLocaleDateString()}</span>
              {d.revoked
                ? <Chip size="sm">revoked</Chip>
                : <Button variant="secondary" onClick={() => revoke(d.deviceId)}>Revoke</Button>}
            </div>
          ))}
          {activeDevices.length === 0 && (
            <div style={{ color: 'var(--cr-fg-3)', fontSize: 12.5, marginTop: 6 }}>No active devices — nothing is syncing to this workspace.</div>
          )}
        </div>
      )}
    </Card>
  );
}
