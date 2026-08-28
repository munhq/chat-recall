import { useEffect, useState } from 'react';
import { Button, Input } from './primitives';
import {
  enableTwoFactor, disableTwoFactor, verifyTotp, twoFactorEnabled, type TwoFactorSetup,
} from '../services/auth';

/**
 * Turn on two-factor authentication, with an authenticator app.
 *
 * ── Why this account needs it ─────────────────────────────────────────────
 *
 * The account holds every AI coding session its owner has run — the search
 * index, the knowledge graph, the secret findings. Until now the only thing in
 * front of that was a password or an OAuth button, which made the weakest link
 * in the product the one part the product itself was not about.
 *
 * ── TOTP only, and that is a decision, not a phase one ────────────────────
 *
 * No SMS. It is billed per message, it is the factor SIM-swap defeats, and it
 * would mean a second vendor for a weaker guarantee. An authenticator app
 * generates the code offline and the server checks it against a secret it
 * already holds, so this costs nothing to run and involves no third party at
 * all.
 *
 * ── The enrolment is two steps on purpose ─────────────────────────────────
 *
 * `enable` returns the QR and the recovery codes but does NOT arm anything. The
 * factor turns on only after a code from the app verifies. A user who scans the
 * wrong thing, or scans nothing, finds out here — while they can still cancel —
 * instead of at their next sign-in with no way back in.
 *
 * The recovery codes are shown exactly once, because the server stores them
 * hashed and cannot show them again. The panel says so at the moment they are on
 * screen rather than in help text nobody reads afterwards.
 */
export default function TwoFactorCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [disarming, setDisarming] = useState(false);
  const [savedCodes, setSavedCodes] = useState(false);

  useEffect(() => { void twoFactorEnabled().then(setEnabled); }, []);

  async function begin() {
    setBusy(true); setErr(''); setMsg('');
    const r = await enableTwoFactor(password);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setSetup(r.setup);
    setPassword('');
    setSavedCodes(false);
  }

  async function confirm() {
    setBusy(true); setErr(''); setMsg('');
    const r = await verifyTotp(code.trim());
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setSetup(null); setCode(''); setEnabled(true);
    setMsg('Two-factor authentication is on. You will be asked for a code at your next sign-in.');
  }

  async function turnOff() {
    setBusy(true); setErr(''); setMsg('');
    const r = await disableTwoFactor(password);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setPassword(''); setDisarming(false); setEnabled(false);
    setMsg('Two-factor authentication is off.');
  }

  // The otpauth:// URI is what a QR encodes. Rendering the QR needs a library
  // this bundle does not carry, so the secret is offered as text — every
  // authenticator accepts a typed key, and shipping a dependency to draw a
  // square is not worth 40 kB on a page most people open once.
  const secret = setup ? new URL(setup.totpURI).searchParams.get('secret') ?? '' : '';

  return (
    <section className="acct-card">
      <h2>Two-factor authentication</h2>
      <style>{TF_CSS}</style>

      {err && <div className="tf-err" role="alert">{err}</div>}
      {msg && <div className="tf-ok" role="status">{msg}</div>}

      {enabled === null && <p className="muted">Checking…</p>}

      {enabled === false && !setup && (
        <>
          <p className="muted">
            Your account holds every session you have synced. A second factor means a
            stolen password is not enough to read it. Use any authenticator app —
            we never send codes by SMS or email.
          </p>
          <div className="acct-actions">
            <Input type="password" placeholder="Your password" value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)} aria-label="Password" />
            <Button variant="secondary" disabled={!password || busy} onClick={begin}>
              {busy ? 'Starting…' : 'Turn on'}
            </Button>
          </div>
        </>
      )}

      {setup && (
        <>
          <p className="muted">
            Add this key to your authenticator app, then enter the code it shows. Nothing is
            switched on until that code checks out.
          </p>
          <p className="tf-secret mono">{secret || setup.totpURI}</p>

          {setup.backupCodes.length > 0 && (
            <div className="tf-warn">
              <strong>Save these recovery codes now — this is the only time they are shown.</strong>
              <br />
              They are stored hashed, so we cannot show them again or read them out to you. Each
              works once, and they are the only way in if you lose the authenticator.
              <ul className="tf-codes">{setup.backupCodes.map((c) => <li key={c} className="mono">{c}</li>)}</ul>
              <label className="tf-ack">
                <input type="checkbox" checked={savedCodes} onChange={(e) => setSavedCodes(e.target.checked)} />
                I have saved these recovery codes
              </label>
            </div>
          )}

          <div className="acct-actions">
            <Input placeholder="123456" value={code} inputMode="numeric" autoComplete="one-time-code"
              onChange={(e) => setCode(e.target.value)} aria-label="Code from your authenticator app" />
            <Button variant="primary" disabled={busy || code.trim().length < 6 || !savedCodes} onClick={confirm}>
              {busy ? 'Verifying…' : 'Verify and turn on'}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => { setSetup(null); setCode(''); }}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {enabled === true && !setup && (
        <>
          <p className="muted">
            On. You are asked for a code from your authenticator app at every sign-in.
          </p>
          {!disarming ? (
            <div className="acct-actions">
              <Button variant="secondary" onClick={() => setDisarming(true)}>Turn off</Button>
            </div>
          ) : (
            <div className="acct-actions">
              <Input type="password" placeholder="Your password" value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)} aria-label="Password" />
              <Button variant="danger" disabled={!password || busy} onClick={turnOff}>
                {busy ? 'Turning off…' : 'Confirm turn off'}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => { setDisarming(false); setPassword(''); }}>
                Cancel
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const TF_CSS = `
.tf-err { background: var(--cr-err-surf); color: var(--cr-err-500);
  border: 1px solid var(--cr-err-line); padding: 8px 12px;
  border-radius: var(--cr-radius-md); margin-bottom: 12px; font-size: 13px; }
.tf-ok { background: var(--cr-ok-surf); color: var(--cr-ok-500);
  border: 1px solid var(--cr-ok-line); padding: 8px 12px;
  border-radius: var(--cr-radius-md); margin-bottom: 12px; font-size: 13px; }
.tf-secret { background: var(--cr-ink-2,#0d1014); border: 1px solid var(--cr-line-1);
  border-radius: var(--cr-radius-md); padding: 10px 12px; font-size: 13px;
  word-break: break-all; user-select: all; margin: 10px 0; }
.tf-warn { background: var(--cr-err-surf); border: 1px solid var(--cr-err-line);
  border-radius: var(--cr-radius-md); padding: 10px 12px; margin: 12px 0;
  font-size: 13px; line-height: 1.5; }
.tf-codes { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 6px; margin: 10px 0 4px; padding: 0; list-style: none; font-size: 13px; }
.tf-ack { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-weight: 600; }
`;
