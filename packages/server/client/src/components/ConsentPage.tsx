import { useEffect, useState } from 'react';
import { useDocumentScroll } from '../hooks/useDocumentScroll';
import { consentDecision, oauthClientName } from '../services/auth';
import { DEVICE_CSS } from './DeviceApprovePage';

/**
 * The OAuth consent step of an MCP connector (/consent?client_id=…&sig=…).
 *
 * better-auth sends the browser here, with a signed copy of the authorize
 * request, after the person signed in and before it issues a code. The page
 * sends that query back unchanged with the answer; the server checks the
 * signature and answers with the client's callback, which the browser follows.
 *
 * It shares the device page's styles: both are the one screen between an
 * outside tool and the account.
 */
export default function ConsentPage() {
  useDocumentScroll();
  const query = window.location.search.replace(/^\?/, '');
  const params = new URLSearchParams(query);
  const clientId = params.get('client_id') || '';
  const pending = !!clientId && params.has('sig');
  const [name, setName] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pending) void oauthClientName(clientId).then(setName);
  }, [clientId, pending]);

  const decide = async (accept: boolean) => {
    setState('busy');
    setError(null);
    const r = await consentDecision(query, accept);
    if (r.ok) {
      window.location.replace(r.redirect);
      return;
    }
    setState('error');
    setError(r.error);
  };

  const who = name || 'An assistant';

  return (
    <div className="dv-wrap">
      <style>{DEVICE_CSS}</style>
      <div className="dv-card">
        <div className="dv-brand"><span className="dv-logo" /> chat-recall</div>
        {!pending ? (
          <>
            <h1>No connection request</h1>
            <p className="dv-sub">
              This page opens when an assistant such as Claude or ChatGPT asks to connect to your
              account. Start the connection again from the assistant.
            </p>
            <a className="dv-cta" href="/app">Open the dashboard</a>
          </>
        ) : (
          <>
            <h1>Connect {who}?</h1>
            <p className="dv-sub">
              {who} wants to use your chat-recall account. If you allow it, it can search and read your
              synced sessions, and save notes, facts and tasks to your account, until you disconnect it.
            </p>
            {!name && <p className="dv-warn">Client id: <code>{clientId}</code></p>}
            {error && <div className="dv-error">{error}</div>}
            <div className="dv-actions">
              <button className="dv-approve" disabled={state === 'busy'} onClick={() => decide(true)}>
                {state === 'busy' ? '…' : 'Allow'}
              </button>
              <button className="dv-deny" disabled={state === 'busy'} onClick={() => decide(false)}>
                Deny
              </button>
            </div>
            <p className="dv-fine">Only allow an assistant you started the connection from.</p>
          </>
        )}
      </div>
    </div>
  );
}
