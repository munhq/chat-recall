import { useState, useEffect } from 'react';
import { signInEmail, signUpEmail, requestPasswordReset, resetPassword, socialProviders, signInSocial } from '../services/auth';

/** Label and mark per provider. Only providers the SERVER reports are rendered,
 *  so an entry here is inert until its credentials exist. */
const PROVIDER_LABEL: Record<string, string> = { github: 'GitHub', google: 'Google' };

/**
 * What better-auth left in the URL after its /reset-password/:token redirect.
 *
 * It redirects to the callback with `{ token }` when the token is good and
 * `{ error: 'INVALID_TOKEN' }` when it is expired or already spent. Reading
 * only the token would drop that second case silently onto the sign-in form,
 * which reads as "my link did nothing" — the one moment a user needs to be
 * told to request a fresh one.
 */
function resetParamsFromUrl(): { token: string | null; error: string | null } {
  try {
    const p = new URLSearchParams(window.location.search);
    return { token: p.get('token'), error: p.get('error') };
  } catch { return { token: null, error: null }; }
}

type Mode = 'signin' | 'signup' | 'forgot' | 'reset';

/**
 * Email + password sign-in / sign-up / password reset for cloud mode. This form
 * replaced the Keycloak-hosted login page: the exchange runs against our own
 * /api/auth/* endpoints and never leaves this origin.
 * On success the session token is already stored — the caller re-renders
 * the app (no redirect, so any query string like ?view=connect survives).
 *
 * The reset half is entered two ways: the user clicks "Forgot your password?"
 * (mode 'forgot' → we mail a link), or they arrive from that link carrying a
 * ?token= (mode 'reset' → they choose a new password). Landing straight in
 * 'reset' when a token is present is what makes the emailed link work without
 * a separate route or page.
 */
export default function AuthPage({ onSuccess, initialMode = 'signin' }: {
  onSuccess: () => void;
  initialMode?: 'signin' | 'signup';
}) {
  const [{ token: resetToken, error: linkError }] = useState(resetParamsFromUrl);
  const [mode, setMode] = useState<Mode>(resetToken ? 'reset' : initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(
    linkError ? 'That reset link has expired or was already used. Request a new one.' : null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<string[]>([]);
  const signup = mode === 'signup';
  const forgot = mode === 'forgot';
  const resetting = mode === 'reset';

  const go = (m: Mode) => { setMode(m); setError(null); setNotice(null); };

  // Ask once at mount. The email form renders immediately regardless, so a slow
  // or failed capabilities call delays nothing — the buttons just appear late
  // or not at all, which is the right failure direction.
  useEffect(() => { void socialProviders().then(setProviders); }, []);

  const social = async (provider: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await signInSocial(provider);
    // On success the browser is already navigating to the IdP, so leaving busy
    // set is deliberate: it stops a second click landing mid-redirect.
    if (!r.ok) { setBusy(false); setError(r.error); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    if (forgot) {
      const r = await requestPasswordReset(email.trim());
      setBusy(false);
      // Deliberately the same message whether or not the account exists — see
      // requestPasswordReset() on why this must not confirm an address.
      if (r.ok) setNotice('If that address has an account, a reset link is on its way. The link expires in an hour.');
      else setError(r.error);
      return;
    }

    if (resetting) {
      const r = await resetPassword(resetToken || '', password);
      setBusy(false);
      if (r.ok) {
        // Resetting does not sign you in, so send them to a clean sign-in form
        // rather than the app — and drop the spent token from the URL so a
        // refresh does not retry it and show a confusing "invalid token".
        window.history.replaceState({}, '', window.location.pathname);
        setPassword('');
        go('signin');
        setNotice('Password updated. Sign in with it.');
      } else setError(r.error);
      return;
    }

    const r = signup
      ? await signUpEmail(name.trim() || email.split('@')[0], email.trim(), password)
      : await signInEmail(email.trim(), password);
    setBusy(false);
    if (r.ok) onSuccess();
    else setError(r.error);
  };

  const heading = resetting ? 'Choose a new password'
    : forgot ? 'Reset your password'
      : signup ? 'Create your account' : 'Sign in';
  const cta = resetting ? 'Update password'
    : forgot ? 'Send reset link'
      : signup ? 'Create account' : 'Sign in';

  return (
    <div className="au-wrap">
      <style>{AUTH_CSS}</style>
      <div className="au-card">
        <div className="au-brand"><span className="au-logo">◆</span> chat-recall</div>
        <h1>{heading}</h1>
        {/* Social buttons only on the two modes where they mean anything.
            During a reset the user already has an account and a token in hand;
            offering a different sign-in route there is a way to lose the reset. */}
        {(mode === 'signin' || signup) && providers.length > 0 && (
          <>
            {providers.map((p) => (
              <button key={p} type="button" className="au-social" disabled={busy} onClick={() => social(p)}>
                Continue with {PROVIDER_LABEL[p] || p}
              </button>
            ))}
            <div className="au-or"><span>or</span></div>
          </>
        )}
        <form onSubmit={submit}>
          {signup && (
            <label>
              Name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                autoComplete="name" placeholder="Ada" />
            </label>
          )}
          {!resetting && (
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                autoComplete="email" required placeholder="you@example.com" />
            </label>
          )}
          {!forgot && (
            <label>
              {resetting ? 'New password' : 'Password'}
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete={signup || resetting ? 'new-password' : 'current-password'} required minLength={8}
                placeholder={signup || resetting ? 'At least 8 characters' : ''} />
            </label>
          )}
          {error && <div className="au-error">{error}</div>}
          {notice && <div className="au-notice">{notice}</div>}
          <button className="au-submit" type="submit" disabled={busy}>
            {busy ? '…' : cta}
          </button>
        </form>
        {!resetting && (
          <button className="au-toggle" onClick={() => go(signup ? 'signin' : 'signup')}>
            {signup ? 'Already have an account? Sign in' : 'New here? Create an account'}
          </button>
        )}
        {mode === 'signin' && (
          <button className="au-toggle" onClick={() => go('forgot')}>Forgot your password?</button>
        )}
        {(forgot || resetting) && (
          <button className="au-toggle" onClick={() => go('signin')}>Back to sign in</button>
        )}
      </div>
    </div>
  );
}

const AUTH_CSS = `
/* Every colour, radius, font and focus ring comes from the design tokens in
 * index.css (loaded globally by main.tsx), not from literals.
 *
 * This page used to hardcode a dark palette and a #5b8cff BLUE accent while the
 * brand is #F5A97F — the same defect that got LandingPage.tsx deleted rather
 * than fixed. Hardcoding also pinned the page to dark, so a visitor who chose
 * the light theme met a dark sign-in form and then a light app. Tokens fix both
 * at once: the light overrides under [data-theme="light"] apply here for free.
 */
.au-wrap { min-height: 100vh; min-height: 100dvh; display: flex; align-items: center;
  justify-content: center; padding: 20px;
  background: var(--cr-ink-0); color: var(--cr-fg-1);
  font-family: var(--cr-font-sans); }
/* max-width, not width: this is the signed-out landing for the whole app now,
 * so it has to hold at 320px. */
.au-card { width: 100%; max-width: 340px; padding: clamp(20px, 6vw, 32px);
  background: var(--cr-ink-1); border: 1px solid var(--cr-ink-2);
  border-radius: var(--cr-radius-lg); box-sizing: border-box; }
.au-brand { font-family: var(--cr-font-display); font-weight: 600;
  letter-spacing: 0.02em; margin-bottom: 20px; color: var(--cr-fg-2); }
.au-logo { color: var(--cr-brand-500); margin-right: 6px; }
.au-card h1 { font-family: var(--cr-font-display); font-size: 20px; margin: 0 0 20px; }
.au-card label { display: block; font-size: 13px; color: var(--cr-fg-2); margin-bottom: 14px; }
.au-card input { display: block; width: 100%; margin-top: 6px; padding: 10px 12px;
  background: var(--cr-ink-0); color: var(--cr-fg-1); border: 1px solid var(--cr-ink-3);
  border-radius: var(--cr-radius-md); font-size: 14px; box-sizing: border-box;
  font-family: inherit; }
.au-card input:focus { outline: none; border-color: var(--cr-brand-500);
  box-shadow: var(--cr-focus-ring); }
.au-error { background: rgba(220, 80, 90, 0.10); border: 1px solid rgba(220, 80, 90, 0.30);
  color: #ff8f98; padding: 8px 12px; border-radius: var(--cr-radius-md);
  font-size: 13px; margin-bottom: 14px; }
.au-notice { background: var(--cr-brand-surf); border: 1px solid var(--cr-brand-line);
  color: var(--cr-brand-500); padding: 8px 12px; border-radius: var(--cr-radius-md);
  font-size: 13px; margin-bottom: 14px; }
/* min-height 44px so it is a real touch target on a phone, matching the
 * pointer:coarse sizing the marketing pages already use. */
.au-social { width: 100%; min-height: 44px; padding: 11px 12px; margin-bottom: 10px;
  background: var(--cr-ink-0); color: var(--cr-fg-1); border: 1px solid var(--cr-ink-3);
  border-radius: var(--cr-radius-md); font-size: 14px; font-weight: 500;
  font-family: inherit; cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease; }
.au-social:hover:not(:disabled) { border-color: var(--cr-brand-line);
  background: var(--cr-brand-surf); }
.au-social:focus-visible { outline: none; box-shadow: var(--cr-focus-ring); }
.au-social:disabled { opacity: 0.6; cursor: default; }
.au-or { display: flex; align-items: center; gap: 10px; margin: 4px 0 16px;
  color: var(--cr-fg-3); font-size: 12px; }
.au-or::before, .au-or::after { content: ""; flex: 1; height: 1px; background: var(--cr-ink-2); }
.au-submit { width: 100%; min-height: 44px; padding: 11px 12px;
  background: var(--cr-brand-500); color: var(--cr-ink-0); border: none;
  border-radius: var(--cr-radius-md); font-size: 14px; font-weight: 600;
  font-family: inherit; cursor: pointer; transition: background 120ms ease; }
.au-submit:hover:not(:disabled) { background: var(--cr-brand-600); }
.au-submit:focus-visible { outline: none; box-shadow: var(--cr-focus-ring); }
.au-submit:disabled { opacity: 0.6; cursor: default; }
.au-toggle { margin-top: 16px; width: 100%; background: none; border: none;
  color: var(--cr-fg-2); font-size: 13px; font-family: inherit; cursor: pointer;
  text-decoration: underline; }
.au-toggle:hover { color: var(--cr-fg-1); }
.au-toggle:focus-visible { outline: none; box-shadow: var(--cr-focus-ring);
  border-radius: var(--cr-radius-sm); }
`;
