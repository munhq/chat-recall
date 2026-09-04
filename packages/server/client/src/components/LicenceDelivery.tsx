/**
 * The screen a self-host buyer lands on after paying.
 *
 * The problem it solves is not cosmetic. The serial used to exist in exactly one
 * place — an email sent from a webhook that swallows its own failures — so a
 * bounced or misfiled message left someone who had paid with nothing, and no way
 * to help themselves. The purchase redirect carries the Checkout Session id, and
 * that is enough to hand them the serial on the spot.
 *
 * Design decisions worth keeping:
 *
 *  - The serial is the hero. It is the one thing they came for, so it gets
 *    display size, a monospace face, tabular figures and generous tracking. Its
 *    own grouping (blocks of four) is preserved rather than re-flowed, because
 *    that is how it is read back off a screen and retyped.
 *  - Copy is the primary action, not a footnote icon. The next thing anyone does
 *    is paste this somewhere else.
 *  - The activation step is on the page, not in a doc. A key with no instruction
 *    is an unfinished delivery.
 *  - Waiting is a state, not a failure. The webhook can land after the redirect,
 *    so a 202 shows "issuing" and retries rather than claiming something broke.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './primitives';
import { getLicenceForSession, resendLicenceSerial, type LicenceDelivery as Delivery } from '../services/api';

type Phase = 'loading' | 'pending' | 'ready' | 'none' | 'error';

/** How long to keep waiting for the webhook before saying so plainly. */
const PENDING_TRIES = 10;
const PENDING_GAP_MS = 3000;

export default function LicenceDeliveryPanel({ sessionId }: { sessionId: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [lic, setLic] = useState<Delivery | null>(null);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const [resent, setResent] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const tries = useRef(0);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const r = await getLicenceForSession(sessionId);
        if (!live) return;
        if (r.pending) {
          tries.current += 1;
          if (tries.current >= PENDING_TRIES) { setPhase('pending'); return; }
          setPhase('pending');
          timer = setTimeout(poll, PENDING_GAP_MS);
          return;
        }
        if (!r.serial) { setPhase('none'); return; }
        setLic(r);
        setPhase('ready');
      } catch (e) {
        if (!live) return;
        // A hosted-plan purchase has no licence, which is not a fault.
        if (e instanceof Error && /no licence/i.test(e.message)) { setPhase('none'); return; }
        setMsg(e instanceof Error ? e.message : 'could not look up this purchase');
        setPhase('error');
      }
    };

    void poll();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [sessionId]);

  const copy = useCallback(async () => {
    if (!lic?.serial) return;
    try {
      await navigator.clipboard.writeText(lic.serial);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard denied (insecure context, or a policy). Say what to do instead
      // of failing silently — the text is on screen and selectable.
      setMsg('Copying is blocked in this browser. Select the serial and copy it by hand.');
    }
  }, [lic]);

  const resend = useCallback(async () => {
    setResending(true); setMsg('');
    try {
      const r = await resendLicenceSerial(sessionId);
      setResent(r.email);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'could not send the email');
    } finally {
      setResending(false);
    }
  }, [sessionId]);

  // Nothing to deliver: a hosted-plan checkout. Render nothing rather than an
  // empty box on an otherwise complete account page.
  if (phase === 'none') return null;

  return (
    <section className="cr-lic" data-testid="licence-delivery">
      <style>{CSS}</style>

      <header className="cr-lic-head">
        <span className="cr-lic-tick" aria-hidden="true">
          <svg viewBox="0 0 16 16" width={13} height={13}>
            <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div>
          <h2>Your licence is ready</h2>
          <p>
            One serial covers your whole self-hosted deployment
            {lic?.seats ? `, for ${lic.seats} seats` : ''}.
          </p>
        </div>
      </header>

      {phase === 'loading' && <div className="cr-lic-skel" aria-label="Loading your licence" />}

      {phase === 'pending' && (
        <div className="cr-lic-wait" role="status" aria-live="polite">
          <span className="cr-lic-spin" aria-hidden="true" />
          <div>
            <strong>Issuing your serial</strong>
            <p>
              The payment went through. Stripe confirms it to us within a few
              seconds — this page updates itself. It is also emailed to you, so
              you can close this safely.
            </p>
          </div>
        </div>
      )}

      {phase === 'ready' && lic?.serial && (
        <>
          <div className="cr-lic-serialwrap">
            <span className="cr-lic-label">Licence serial</span>
            {/* Selectable, and grouped as issued: this gets retyped by hand. */}
            <code className="cr-lic-serial">{lic.serial}</code>
            <div className="cr-lic-actions">
              <Button variant="primary" onClick={copy}>
                {copied ? 'Copied' : 'Copy serial'}
              </Button>
              {/* Announced without moving anything: the button's own label change
                  is invisible to a screen reader that is not focused on it. */}
              <span className="cr-sr-only" role="status" aria-live="polite">
                {copied ? 'Serial copied to the clipboard' : ''}
              </span>
            </div>
          </div>

          <ol className="cr-lic-steps">
            <li>
              <span className="cr-lic-step">1</span>
              <div>
                <strong>Put it in your server's environment</strong>
                <code className="cr-lic-code">CHAT_RECALL_LICENCE={lic.serial}</code>
              </div>
            </li>
            <li>
              <span className="cr-lic-step">2</span>
              <div>
                <strong>Restart the server</strong>
                <code className="cr-lic-code">docker compose up -d</code>
                <p>
                  It exchanges the serial for a short-lived signed entitlement on
                  start, and renews it on its own. Nothing else to run.
                </p>
              </div>
            </li>
          </ol>

          <footer className="cr-lic-foot" aria-live="polite">
            {lic.email && !resent && (
              <span>
                A copy went to <strong>{lic.email}</strong>.{' '}
                <button type="button" className="cr-lic-link" onClick={resend} disabled={resending}>
                  {resending ? 'Sending…' : 'Send it again'}
                </button>
              </span>
            )}
            {resent && <span>Sent again to <strong>{resent}</strong>.</span>}
            {!lic.email && (
              <span>
                Stripe holds no email for this purchase, so nothing was sent. Keep
                this serial somewhere safe.
              </span>
            )}
          </footer>
        </>
      )}

      {phase === 'error' && (
        <div className="cr-lic-err" role="alert">
          <strong>We could not look up this purchase</strong>
          <p>{msg}</p>
          <p>
            Your payment is unaffected. The serial is emailed to you as well — if
            it does not arrive, write to contact@chatrecall.dev with the date of purchase.
          </p>
        </div>
      )}

      {msg && phase === 'ready' && <p className="cr-lic-inline-err">{msg}</p>}
    </section>
  );
}

const CSS = `
.cr-lic { max-width: 620px; margin: 0 0 26px; padding: 22px 24px;
  border: 1px solid var(--cr-ok-line); border-radius: var(--cr-radius-lg);
  background: var(--cr-ink-1); }
.cr-lic-head { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 18px; }
.cr-lic-tick { flex: none; width: 22px; height: 22px; margin-top: 2px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--cr-ok-surf); color: var(--cr-ok-500);
  border: 1px solid var(--cr-ok-line); }
.cr-lic-head h2 { margin: 0 0 4px; font-size: 17px; font-weight: 600; letter-spacing: -0.01em;
  color: var(--cr-fg-1); }
.cr-lic-head p { margin: 0; font-size: 13px; color: var(--cr-fg-2); }

.cr-lic-serialwrap { display: flex; flex-direction: column; gap: 10px; padding: 16px;
  border-radius: var(--cr-radius-md); background: var(--cr-ink-0);
  border: 1px solid var(--cr-line-1); }
.cr-lic-label { font-size: 12.5px; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--cr-fg-3); }
.cr-lic-serial { font-family: var(--cr-font-annot);
  font-size: clamp(16px, 3.4vw, 21px); font-weight: 600; letter-spacing: 0.06em;
  font-variant-numeric: tabular-nums; color: var(--cr-fg-1); word-break: break-all;
  user-select: all; line-height: 1.35; }
.cr-lic-actions { display: flex; gap: 10px; align-items: center; }

.cr-lic-steps { list-style: none; margin: 20px 0 0; padding: 0;
  display: flex; flex-direction: column; gap: 14px; }
.cr-lic-steps li { display: flex; gap: 11px; align-items: flex-start; }
/* Both steps' content fills the row, so the two code boxes share one right
   edge instead of ending wherever their text happens to stop. */
.cr-lic-steps li > div { flex: 1; min-width: 0; }
.cr-lic-step { flex: none; width: 20px; height: 20px; border-radius: var(--cr-radius-xs);
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--cr-ink-2); border: 1px solid var(--cr-line-1);
  font-size: 12px; color: var(--cr-fg-2); font-variant-numeric: tabular-nums; }
.cr-lic-steps strong { display: block; font-size: 13px; font-weight: 600; color: var(--cr-fg-1);
  margin-bottom: 5px; }
.cr-lic-steps p { margin: 6px 0 0; font-size: 12px; line-height: 1.55; color: var(--cr-fg-3);
  max-width: 52ch; }
/* Scrolls rather than breaks. word-break:break-all split the serial mid-group
   on a phone ("…8H2K-4 / QM7-XT91"), which is the one thing this panel promises
   not to do, because that grouping is how the value gets retyped. A narrow
   viewport gets a scrollbar on this one box instead. */
.cr-lic-code { display: block; padding: 7px 9px; border-radius: var(--cr-radius-sm);
  background: var(--cr-ink-0); border: 1px solid var(--cr-line-1);
  font-family: var(--cr-font-annot);
  font-size: 12px; color: var(--cr-fg-2); user-select: all;
  white-space: pre; overflow-x: auto; overscroll-behavior-x: contain; }
.cr-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

.cr-lic-foot { margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--cr-line-1);
  font-size: 12px; color: var(--cr-fg-3); }
.cr-lic-foot strong { color: var(--cr-fg-2); font-weight: 500; }
.cr-lic-link { background: none; border: 0; padding: 0; cursor: pointer;
  color: var(--cr-brand-500); font-size: 12px; text-decoration: underline;
  text-underline-offset: 2px; }
.cr-lic-link:disabled { opacity: 0.6; cursor: default; }
.cr-lic-link:focus-visible { outline: 2px solid var(--cr-brand-500); outline-offset: 2px; }

.cr-lic-wait { display: flex; gap: 12px; align-items: flex-start; }
.cr-lic-wait strong { display: block; font-size: 13px; color: var(--cr-fg-1); margin-bottom: 4px; }
.cr-lic-wait p { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--cr-fg-3);
  max-width: 52ch; }
.cr-lic-spin { flex: none; width: 15px; height: 15px; margin-top: 2px; border-radius: 50%;
  border: 2px solid var(--cr-line-2); border-top-color: var(--cr-brand-500);
  animation: cr-lic-spin 720ms linear infinite; }
@keyframes cr-lic-spin { to { transform: rotate(360deg); } }

/* A skeleton in the shape of the serial block, not a spinner in the middle of
   nowhere: the layout does not jump when the real thing arrives. */
.cr-lic-skel { height: 92px; border-radius: var(--cr-radius-md);
  background: linear-gradient(100deg, var(--cr-ink-0) 30%, var(--cr-ink-2) 50%, var(--cr-ink-0) 70%);
  background-size: 220% 100%; animation: cr-lic-shim 1.3s ease-in-out infinite;
  border: 1px solid var(--cr-line-1); }
@keyframes cr-lic-shim { from { background-position: 120% 0; } to { background-position: -20% 0; } }

.cr-lic-err strong { display: block; font-size: 13px; color: var(--cr-err-500); margin-bottom: 6px; }
.cr-lic-err p { margin: 0 0 6px; font-size: 12.5px; line-height: 1.55; color: var(--cr-fg-3);
  max-width: 54ch; }
.cr-lic-inline-err { margin: 12px 0 0; font-size: 12px; color: var(--cr-warn-500); }

@media (prefers-reduced-motion: reduce) {
  .cr-lic-spin { animation-duration: 2.4s; }
  .cr-lic-skel { animation: none; }
}
`;
