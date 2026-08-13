import { useState } from 'react';
import { deviceDecision } from '../services/auth';

/**
 * CLI device-login approval (/device?user_code=…). The terminal running
 * `chat-recall login` printed this URL; the signed-in user confirms the code
 * matches what the terminal shows, then the CLI's token poll succeeds and it
 * finishes the login by itself — this page is done after one click.
 */
export default function DeviceApprovePage() {
  const userCode = new URLSearchParams(window.location.search).get('user_code') || '';
  const [state, setState] = useState<'idle' | 'busy' | 'approved' | 'denied' | 'error'>(userCode ? 'idle' : 'error');
  const [error, setError] = useState<string | null>(userCode ? null : 'Missing user_code in the URL — copy the full link from the terminal.');

  const decide = async (approve: boolean) => {
    setState('busy');
    const r = await deviceDecision(userCode, approve);
    if (r.ok) setState(approve ? 'approved' : 'denied');
    else { setState('error'); setError(r.error); }
  };

  return (
    <div className="dv-wrap">
      <style>{DEVICE_CSS}</style>
      <div className="dv-card">
        <div className="dv-brand"><span className="dv-logo">◆</span> chat-recall</div>
        {state === 'approved' ? (
          <>
            <h1>Device connected ✓</h1>
            <p>Go back to your terminal — it finishes the login by itself. You can close this tab.</p>
          </>
        ) : state === 'denied' ? (
          <>
            <h1>Request denied</h1>
            <p>The terminal login was rejected. You can close this tab.</p>
          </>
        ) : (
          <>
            <h1>Approve device login?</h1>
            <p>A terminal is asking to connect to your account with this code:</p>
            <div className="dv-code">{userCode || '—'}</div>
            <p className="dv-warn">Only approve if this code matches the one shown in YOUR terminal.</p>
            {error && <div className="dv-error">{error}</div>}
            <div className="dv-actions">
              <button className="dv-approve" disabled={state === 'busy' || !userCode} onClick={() => decide(true)}>
                {state === 'busy' ? '…' : 'Approve'}
              </button>
              <button className="dv-deny" disabled={state === 'busy' || !userCode} onClick={() => decide(false)}>
                Deny
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const DEVICE_CSS = `
.dv-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: #0b0e14; color: #e6e9ef; font-family: system-ui, -apple-system, sans-serif; }
.dv-card { width: 380px; padding: 32px; background: #11151f; border: 1px solid #1e2534;
  border-radius: 12px; text-align: center; }
.dv-brand { font-weight: 600; margin-bottom: 20px; color: #9aa4b8; text-align: left; }
.dv-logo { color: #5b8cff; margin-right: 6px; }
.dv-card h1 { font-size: 20px; margin: 0 0 12px; }
.dv-card p { font-size: 14px; color: #9aa4b8; line-height: 1.5; }
.dv-code { font-family: ui-monospace, monospace; font-size: 28px; letter-spacing: 0.2em;
  background: #0b0e14; border: 1px solid #2a3346; border-radius: 8px; padding: 14px;
  margin: 16px 0; }
.dv-warn { font-size: 12px; }
.dv-error { background: #2a1215; border: 1px solid #6b2a31; color: #ff8f98;
  padding: 8px 12px; border-radius: 8px; font-size: 13px; margin: 12px 0; }
.dv-actions { display: flex; gap: 12px; margin-top: 16px; }
.dv-approve { flex: 1; padding: 10px; background: #5b8cff; color: #fff; border: none;
  border-radius: 8px; font-weight: 600; cursor: pointer; }
.dv-deny { flex: 1; padding: 10px; background: none; color: #9aa4b8;
  border: 1px solid #2a3346; border-radius: 8px; cursor: pointer; }
.dv-approve:disabled, .dv-deny:disabled { opacity: 0.6; cursor: default; }
`;
