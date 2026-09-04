import { useState } from 'react';
import { useDocumentScroll } from '../hooks/useDocumentScroll';
import { deviceDecision } from '../services/auth';

/**
 * Device-login approval (/device?user_code=…) — RFC 8628's human step.
 *
 * Something asked to connect to the user's account: "chat-recall login" in a
 * terminal, "init", or the MCP server signing itself in on the user's behalf.
 * They confirm the code matches, and the poller on the other side finishes by
 * itself.
 *
 * TWO THINGS THIS PAGE USED TO GET WRONG.
 *
 * It painted its own palette — fifteen hardcoded hex values, a blue accent, and
 * no light mode — while every other page in the app uses the design tokens. Our
 * brand is warm, not blue, so on the one screen a brand-new user sees before
 * anything else, the product looked like a different product. AuthPage next door
 * uses 44 tokens and 0 stray hex; this now matches it.
 *
 * And it dead-ended: "You can close this tab." Consider who reads that — someone
 * who signed in seconds ago, whose trial just started, seeing our web app for the
 * first time. That is the best moment in the funnel and it was spent on a full
 * stop, with no dashboard link and no mention of what they now have. It also said
 * "go back to your terminal", which is simply false when the caller is an MCP
 * server inside an editor: there is no terminal, and the thing finishing the
 * login is a background process.
 */
export default function DeviceApprovePage() {
  useDocumentScroll();
  const params = new URLSearchParams(window.location.search);
  const userCode = params.get('user_code') || '';
  /** Who asked. The MCP passes this so the copy can stop saying "terminal" to
   *  someone who is looking at an editor. Absent for a plain CLI login. */
  const via = params.get('via') || '';
  const [state, setState] = useState<'idle' | 'busy' | 'approved' | 'denied' | 'error'>(userCode ? 'idle' : 'error');
  const [error, setError] = useState<string | null>(userCode ? null : 'Missing user_code in the URL — copy the full link from wherever it was shown.');

  const decide = async (approve: boolean) => {
    setState('busy');
    const r = await deviceDecision(userCode, approve);
    if (r.ok) setState(approve ? 'approved' : 'denied');
    else { setState('error'); setError(r.error); }
  };

  /** Where the login is being completed, named correctly for the caller. */
  const caller = via === 'mcp' ? 'your editor' : 'your terminal';

  return (
    <div className="dv-wrap">
      <style>{DEVICE_CSS}</style>
      <div className="dv-card">
        <div className="dv-brand"><span className="dv-logo" /> chat-recall</div>
        {state === 'approved' ? (
          <>
            <h1>You're connected</h1>
            <p className="dv-sub">
              Your 7-day trial is live — no card needed. {caller === 'your editor' ? 'Your editor' : 'The terminal'} finishes
              the setup by itself: the chat-recall skills go into your AI tools and your past
              sessions start syncing.
            </p>
            {/* The one thing this page owed a new user and never gave them: somewhere
              * to go. A first sync takes a while, so the dashboard is where they watch
              * it arrive rather than a screen they are told to close. */}
            <a className="dv-cta" href="/app">Open the dashboard</a>
            <p className="dv-fine">
              Nothing was uploaded before you approved this. You can stop syncing any path
              later from the dashboard, or with <code>chat-recall exclude project &lt;path&gt;</code>.
            </p>
          </>
        ) : state === 'denied' ? (
          <>
            <h1>Request denied</h1>
            <p className="dv-sub">
              Nothing was connected and nothing was uploaded. You can close this tab.
            </p>
          </>
        ) : (
          <>
            <h1>Approve this device?</h1>
            <p className="dv-sub">Something is asking to connect to your account with this code:</p>
            <div className="dv-code">{userCode || '—'}</div>
            <p className="dv-warn">Only approve if this code matches the one shown in {caller}.</p>
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

/* Tokens only — no hex. This page renders in whatever theme the visitor's system
 * asks for, like the rest of the app, instead of staying dark on a light desktop. */
const DEVICE_CSS = `
.dv-wrap { min-height: 100vh; min-height: 100dvh; display: flex; align-items: center;
  justify-content: center; padding: 24px 20px;
  background: var(--cr-ink-0); color: var(--cr-fg-1);
  font-family: var(--cr-font-sans); }
/* max-width, not width: a fixed 380px card overflows a 375px handset. */
/* A plate. The border was "1px solid var(--cr-ink-2)" — a GROUND token doing
   line duty, so the card's edge dissolved into the page once the shadow went. */
.dv-card { width: 100%; max-width: 380px; padding: clamp(24px, 6vw, 36px);
  background: var(--cr-ink-0); border: var(--cr-frame-w) solid var(--cr-frame);
  border-radius: 0; box-sizing: border-box;
  }
.dv-brand { display: flex; align-items: center; gap: 7px;
  font-family: var(--cr-font-display); font-size: 13px; font-weight: 600;
  letter-spacing: 0.04em; text-transform: lowercase;
  margin-bottom: 26px; color: var(--cr-fg-2); }
.dv-logo { display: inline-block; width: 12px; height: 12px; background: var(--cr-brand-500); flex: none; }
.dv-card h1 { font-family: var(--cr-font-display); font-size: 21px; line-height: 1.25;
  margin: 0 0 7px; color: var(--cr-fg-1); letter-spacing: -0.01em; }
.dv-sub { margin: 0 0 20px; font-size: 13px; line-height: 1.55; color: var(--cr-fg-2); }
.dv-code { font-family: var(--cr-font-annot); font-size: clamp(21px, 6.5vw, 28px);
  letter-spacing: 0.2em; text-align: center;
  background: var(--cr-ink-0); border: 1px solid var(--cr-ink-3);
  border-radius: var(--cr-radius-md); padding: 14px;
  margin: 16px 0; overflow-wrap: break-word; color: var(--cr-fg-1); }
.dv-warn { font-size: 12px; color: var(--cr-fg-2); margin: 0; }
.dv-error { background: var(--cr-err-surf); border: 1px solid var(--cr-err-line);
  color: var(--cr-err-500);
  padding: 8px 12px; border-radius: var(--cr-radius-md); font-size: 13px; margin: 12px 0; }
.dv-actions { display: flex; gap: 12px; margin-top: 18px; }
/* 44px minimum so these are real touch targets on a phone, matching AuthPage. */
.dv-approve { flex: 1; min-height: 44px; padding: 11px;
  background: var(--cr-brand-500); color: var(--cr-on-brand); border: none;
  border-radius: var(--cr-radius-md); font-weight: 600; font-family: inherit;
  font-size: 14px; cursor: pointer; transition: background 120ms ease, transform 120ms ease; }
.dv-approve:hover:not(:disabled) { background: var(--cr-brand-600); }
.dv-approve:active:not(:disabled) { transform: translateY(1px); }
.dv-deny { flex: 1; min-height: 44px; padding: 11px; background: none; color: var(--cr-fg-2);
  border: 1px solid var(--cr-ink-3); border-radius: var(--cr-radius-md);
  font-family: inherit; font-size: 14px; cursor: pointer; }
.dv-deny:hover:not(:disabled) { border-color: var(--cr-brand-line); background: var(--cr-ink-2); }
.dv-approve:focus-visible, .dv-deny:focus-visible, .dv-cta:focus-visible {
  outline: none; box-shadow: var(--cr-focus-ring); }
.dv-approve:disabled, .dv-deny:disabled { opacity: 0.55; cursor: default; }
.dv-cta { display: flex; align-items: center; justify-content: center;
  min-height: 44px; padding: 11px 14px; margin-top: 4px;
  background: var(--cr-brand-500); color: var(--cr-on-brand);
  border-radius: var(--cr-radius-md); font-size: 14px; font-weight: 600;
  text-decoration: none; transition: background 120ms ease; }
.dv-cta:hover { background: var(--cr-brand-600); }
.dv-fine { margin: 16px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--cr-fg-3); }
.dv-fine code { font-family: var(--cr-font-mono); font-size: 12px; }
`;
