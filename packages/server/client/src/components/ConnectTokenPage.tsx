/**
 * /?view=connect — the installer's landing spot. The terminal flow is:
 *
 *   curl …/install.sh | sh   →   opens this page   →   user pastes the token back
 *
 * So this page has ONE job: get the signed-in user a device token with zero
 * clicks. It resolves (or auto-creates) the workspace, mints a token for the
 * device name passed in ?device=, and shows it full-size with a Copy button.
 * No navigation, no forms — the user is mid-command in a terminal.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Button } from './primitives';
import { getMe, createTeam, mintDeviceToken, getSyncStatus } from '../services/api';

function deviceFromUrl(): string {
  try {
    const d = new URLSearchParams(window.location.search).get('device') || '';
    const clean = d.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return clean || 'my-machine';
  } catch {
    return 'my-machine';
  }
}

export default function ConnectTokenPage() {
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [token, setToken] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const [synced, setSynced] = useState(0);
  const ranRef = useRef(false); // dev StrictMode double-mount → mint exactly once

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    (async () => {
      try {
        const me = await getMe();
        const slug = me.teams.length > 0
          ? me.teams[0].team_slug
          : (await createTeam(me.user.email?.split('@')[0]?.replace(/[^a-z0-9]/gi, '') || 'workspace')).slug;
        const r = await mintDeviceToken(slug, deviceFromUrl());
        setToken(r.token);
        setDeviceId(r.device_id);
        setState('done');
      } catch (e: any) {
        setErr(String(e?.message || e));
        setState('error');
      }
    })();
  }, []);

  // Flip to "you're live" the moment the first data lands after the paste.
  useEffect(() => {
    if (state !== 'done') return;
    const t = setInterval(async () => {
      try {
        const s = await getSyncStatus();
        if (s.sessions > 0) { setSynced(s.sessions); clearInterval(t); }
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(t);
  }, [state]);

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--cr-ink-0)', color: 'var(--cr-fg-1)', padding: 24,
    }}>
      <div style={{ maxWidth: 640, width: '100%' }}>
        <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
          {state === 'done' ? 'Your device token' : state === 'error' ? 'Could not mint a token' : 'Minting your device token…'}
        </div>

        {state === 'working' && (
          <div style={{ color: 'var(--cr-fg-2)', fontSize: 14 }}>Setting up your workspace…</div>
        )}

        {state === 'error' && (
          <div style={{ fontSize: 14, lineHeight: 1.6 }}>
            <div style={{ color: 'var(--cr-err-500)', marginBottom: 10 }}>{err}</div>
            <div style={{ color: 'var(--cr-fg-2)' }}>
              If this is a self-hosted server without login, you don't need a token — run{' '}
              <code>chat-recall login {window.location.origin}</code> in your terminal instead.
            </div>
          </div>
        )}

        {state === 'done' && (
          <>
            <div style={{ color: 'var(--cr-fg-2)', fontSize: 14, marginBottom: 16 }}>
              For <strong style={{ color: 'var(--cr-fg-1)' }}>{deviceId}</strong> — shown once.
              Copy it and paste it back into your terminal.
            </div>
            <div style={{ display: 'flex', alignItems: 'stretch', gap: 10 }}>
              <pre style={{
                flex: 1, margin: 0, padding: '16px 18px', borderRadius: 10,
                border: '1px solid var(--cr-line-2)', background: 'var(--cr-ink-1)',
                fontSize: 16, lineHeight: 1.5, overflowX: 'auto', whiteSpace: 'pre',
                userSelect: 'all',
              }}>{token}</pre>
              <Button
                variant="primary"
                onClick={() => { navigator.clipboard.writeText(token); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                aria-label="Copy token to clipboard"
              >{copied ? 'Copied ✓' : 'Copy'}</Button>
            </div>
            <div style={{
              marginTop: 18, padding: '10px 12px', borderRadius: 10, fontSize: 13,
              border: '1px solid var(--cr-line-1)',
              background: synced > 0 ? 'var(--cr-ok-surf, #10241a)' : 'var(--cr-ink-1)',
              color: synced > 0 ? 'var(--cr-ok-500, #4ade80)' : 'var(--cr-fg-2)',
            }}>
              {synced > 0
                ? <>✓ First data arrived — {synced} session(s) synced. You can close this tab.</>
                : <>Waiting for your terminal to finish — paste the token there and this flips green.</>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
