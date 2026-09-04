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
  getCapabilities, deviceHealth,
  type DeviceInfo, type DeviceHealth, type SyncLimitPayload,
} from '../services/api';
import { formatMB } from '../utils/bytes';

/** Relative "last seen", short enough to sit in a row. */
function ago(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 120_000) return 'just now';
  if (d < 3600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 48 * 3600_000) return `${Math.round(d / 3600_000)}h ago`;
  return `${Math.round(d / (24 * 3600_000))}d ago`;
}

/** How each health state reads in the row. `unknown` is deliberately neutral:
 *  a device that predates heartbeats hasn't done anything wrong. */
const HEALTH_LABEL: Record<DeviceHealth, { text: string; tone: string } | null> = {
  ok: null,
  outdated: { text: 'outdated CLI', tone: 'var(--cr-warn-500)' },
  offline: { text: 'not syncing', tone: 'var(--cr-err-500)' },
  unknown: { text: 'never checked in', tone: 'var(--cr-fg-3)' },
  revoked: null,
};

/** Public server origin for the `chat-recall login` command. Cloud builds set
 *  VITE_API_BASE (…/api); local mode serves the API on the same origin. */
function serverOrigin(): string {
  const base = (import.meta.env.VITE_API_BASE as string | undefined) || '';
  if (base) return base.replace(/\/api\/?$/, '');
  return window.location.origin;
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, marginTop: 8 }}>
      <pre style={{
        flex: 1, margin: 0, padding: '10px 12px', borderRadius: 'var(--cr-radius-md)',
        border: '1px solid var(--cr-line-1)', background: 'var(--cr-ink-0)', color: 'var(--cr-fg-1)',
        fontSize: 12.5, lineHeight: 1.6, overflowX: 'auto', whiteSpace: 'pre',
        WebkitOverflowScrolling: 'touch', overscrollBehaviorX: 'contain',
      }}>{text}</pre>
      <Button
        variant="secondary"
        onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        aria-label="Copy to clipboard"
      >{copied ? 'Copied' : 'Copy'}</Button>
    </div>
  );
}

export default function ConnectMachine({ compact, onFirstData }: { compact?: boolean; onFirstData?: () => void }) {
  const [teamSlug, setTeamSlug] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [deviceName, setDeviceName] = useState('');
  const [minted, setMinted] = useState<{ deviceId: string; token: string } | null>(null);
  const [showTokenFlow, setShowTokenFlow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [synced, setSynced] = useState<number | null>(null);
  // The CLI release this server serves — the yardstick for "outdated".
  const [serverCli, setServerCli] = useState<string | null>(null);
  // The free plan's sync meters. api.ts recognises a 402 whose body carries
  // `kind: sync_quota|sync_storage` (the server's limitReached payload) and
  // broadcasts it as cr:sync-limit; this card is the sync surface, so it is
  // where the numbers render — used/limit in MB, the reset date when the meter
  // is monthly, and the upgrade as the action. An offer, not an error: the
  // data is kept, only the meter is full (same pattern as the feature gates).
  const [syncLimit, setSyncLimit] = useState<SyncLimitPayload | null>(null);
  useEffect(() => {
    const onLimit = (e: Event) => {
      const detail = (e as CustomEvent<SyncLimitPayload>).detail;
      if (detail) setSyncLimit(detail);
    };
    window.addEventListener('cr:sync-limit', onLimit);
    return () => window.removeEventListener('cr:sync-limit', onLimit);
  }, []);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let on = true;
    getCapabilities().then((c) => { if (on) setServerCli(c.cli?.version ?? null); }).catch(() => {});
    return () => { on = false; };
  }, []);

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

  // Watch sync status until the first session arrives. That moment — not the
  // payment — is when the product starts existing for the user, so celebrate
  // it explicitly. Armed immediately: the install one-liner needs no UI step
  // here (login mints its own token after the browser approval).
  useEffect(() => {
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
  }, []);

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
        OpenCode, Codex), redacts secrets locally, and syncs them here. One command and your
        history becomes searchable.
      </div>
      {err && <div style={{ color: 'var(--cr-err-500)', fontSize: 13, margin: '8px 0' }}>{err}</div>}

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--cr-fg-2)' }}>
          Run this on the machine with your sessions. It installs the CLI from npm (Node 18+),
          detects which AI tools you have, registers the MCP server, installs the recall skills,
          and syncs once you approve the login in your browser:
        </div>
        <CopyBlock text={`npx chat-recall init --server ${origin}`} />
        <div style={{ fontSize: 13, color: 'var(--cr-fg-2)', marginTop: 10 }}>
          Already have the CLI installed? <code>chat-recall login {origin}</code> connects without reinstalling.
        </div>
        <div style={{
          marginTop: 14, padding: '10px 12px', borderRadius: 'var(--cr-radius-md)', fontSize: 13,
          border: '1px solid var(--cr-line-1)',
          background: synced && synced > 0 ? 'var(--cr-ok-surf)' : 'var(--cr-ink-1)',
          color: synced && synced > 0 ? 'var(--cr-ok-500)' : 'var(--cr-fg-2)',
        }}>
          {synced && synced > 0
            ? <>First data arrived — {synced} session(s) synced. You're live.</>
            : <><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--cr-warn-500)', marginRight: 8 }} />Waiting for the first sync…</>}
        </div>

        {syncLimit && (
          <div
            data-testid="sync-limit-notice"
            style={{
              marginTop: 10, padding: '10px 12px', borderRadius: 'var(--cr-radius-md)',
              fontSize: 13, lineHeight: 1.55,
              border: '1px solid var(--cr-brand-line)',
              background: 'var(--cr-brand-surf)',
              color: 'var(--cr-fg-1)',
              display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
            }}
          >
            <span style={{ flex: '1 1 260px', minWidth: 0 }}>
              {syncLimit.kind === 'sync_quota' ? (
                <>
                  <strong>Monthly sync quota reached</strong> — {formatMB(syncLimit.used)} of{' '}
                  {formatMB(syncLimit.limit)} used this month.
                  {syncLimit.resetsAt
                    ? <> Sync resumes on {new Date(syncLimit.resetsAt).toLocaleDateString()}, or upgrade for unmetered sync.</>
                    : <> Upgrade for unmetered sync.</>}
                </>
              ) : (
                <>
                  <strong>Storage cap reached</strong> — {formatMB(syncLimit.used)} of{' '}
                  {formatMB(syncLimit.limit)} stored. Sync is paused and your data is kept.
                  Upgrade for unmetered sync, or delete data you no longer need.
                </>
              )}
            </span>
            {/* Always an action (same rule as the toolkit gate): the server
                normally sends upgradeUrl, but a payload without one must not
                leave an offer with nothing to click. */}
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                if (syncLimit.upgradeUrl) window.location.href = syncLimit.upgradeUrl;
                else window.location.assign('/?view=account');
              }}
            >
              See plans
            </Button>
          </div>
        )}

        {/* Raw device tokens are only for machines where nobody can approve a
            browser prompt (CI, bots). Everyone else never needs to see this. */}
        {!minted ? (
          <div style={{ marginTop: 12 }}>
            <button
              onClick={() => setShowTokenFlow(!showTokenFlow)}
              style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontSize: 12.5, color: 'var(--cr-fg-3)', cursor: 'pointer' }}
            >{showTokenFlow ? '−' : '+'} Need a raw device token instead? (CI, bots — no browser)</button>
            {showTokenFlow && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                <input
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="device name, e.g. ci-runner"
                  aria-label="Device name"
                  style={{
                    flex: '1 1 220px', font: 'inherit', fontSize: 13, padding: '9px 12px',
                    borderRadius: 'var(--cr-radius-md)', border: '1px solid var(--cr-line-2)',
                    background: 'var(--cr-ink-0)', color: 'var(--cr-fg-1)',
                  }}
                />
                <Button variant="secondary" onClick={mint} disabled={busy || !teamSlug}>
                  {busy ? 'Minting…' : 'Mint token'}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, color: 'var(--cr-fg-2)' }}>
              Token for <Chip size="sm">{minted.deviceId}</Chip> — shown <strong>once</strong>; copy the whole line, then run <code>chat-recall sync</code>:
            </div>
            <CopyBlock text={`chat-recall login ${origin} --token ${minted.token}`} />
            <div style={{ marginTop: 10 }}>
              <Button variant="secondary" onClick={() => { setMinted(null); }}>Mint another token</Button>
            </div>
          </div>
        )}
      </div>

      {!compact && devices.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--cr-fg-2)', marginBottom: 6 }}>Devices</div>
          {devices.map((d) => {
            const health = deviceHealth(d, serverCli);
            const flag = HEALTH_LABEL[health];
            return (
              <div key={d.deviceId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--cr-line-1)', fontSize: 13 }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.deviceId}</span>
                  {!d.revoked && (
                    <span style={{ color: 'var(--cr-fg-3)', fontSize: 12 }}>
                      {d.cliVersion ? `CLI ${d.cliVersion}` : 'CLI unknown'}
                      {d.os ? ` · ${d.os}` : ''}
                      {` · seen ${ago(d.lastSeenAt)}`}
                    </span>
                  )}
                </span>
                {flag && <span style={{ color: flag.tone, fontSize: 12, whiteSpace: 'nowrap' }}>{flag.text}</span>}
                <span style={{ color: 'var(--cr-fg-3)' }}>{new Date(d.createdAt).toLocaleDateString()}</span>
                {d.revoked
                  ? <Chip size="sm">revoked</Chip>
                  : <Button variant="secondary" onClick={() => revoke(d.deviceId)}>Revoke</Button>}
              </div>
            );
          })}
          {devices.some((d) => deviceHealth(d, serverCli) === 'outdated') && (
            <div style={{ color: 'var(--cr-fg-3)', fontSize: 12.5, marginTop: 8 }}>
              A device on an old CLI keeps syncing but misses fixes, and one old enough
              predates self-update entirely. On that machine run <code>chat-recall update</code>.
            </div>
          )}
          {activeDevices.length === 0 && (
            <div style={{ color: 'var(--cr-fg-3)', fontSize: 12.5, marginTop: 6 }}>No active devices — nothing is syncing to this workspace.</div>
          )}
        </div>
      )}
    </Card>
  );
}
