import { useState, useEffect } from 'react';
import { useDocumentScroll } from '../hooks/useDocumentScroll';
import { signInEmail, signUpEmail, requestPasswordReset, resetPassword, socialProviders, signInSocial } from '../services/auth';

/**
 * Provider marks, inline so the page needs no icon dependency and no network
 * request before it can render its own buttons.
 *
 * Google's mark keeps its four official brand colours: their guidelines require
 * the unmodified logo, and a monochrome version is the thing that gets a sign-in
 * button rejected in review. GitHub's is single-colour by design and inherits
 * currentColor, so it follows the theme.
 */
const PROVIDER_MARK: Record<string, JSX.Element> = {
  google: (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1z" />
      <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.4 46 24 46z" />
      <path fill="#FBBC05" d="M11.8 28.2c-.4-1.3-.7-2.7-.7-4.2s.2-2.9.7-4.2v-5.7H4.5C3 17.1 2.1 20.4 2.1 24s.9 6.9 2.4 9.9l7.3-5.7z" />
      <path fill="#EA4335" d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.2 29.9 2 24 2 15.4 2 8.1 6.9 4.5 14.1l7.3 5.7c1.7-5.2 6.5-9 12.2-9z" />
    </svg>
  ),
  github: (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  ),
};

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

  useDocumentScroll();

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
      : signup ? 'Create your account' : 'Welcome back';
  // A subtitle per mode, because the heading alone leaves the two reset screens
  // ambiguous — "Reset your password" does not say whether a mail is coming.
  const subtitle = resetting ? 'Pick something you have not used elsewhere.'
    : forgot ? 'We will email you a link. It works once and expires in an hour.'
      : signup ? 'One memory across Claude Code, Gemini, Codex and OpenCode.'
        : 'Sign in to your chat-recall account.';
  const cta = resetting ? 'Update password'
    : forgot ? 'Send reset link'
      : signup ? 'Create account' : 'Sign in';

  return (
    <div className="au-wrap">
      <style>{AUTH_CSS}</style>
      <div className="au-card">
        <div className="au-brand"><span className="au-logo">◆</span> chat-recall</div>
        <h1>{heading}</h1>
        <p className="au-sub">{subtitle}</p>
        {/* Social buttons only on the two modes where they mean anything.
            During a reset the user already has an account and a token in hand;
            offering a different sign-in route there is a way to lose the reset. */}
        {(mode === 'signin' || signup) && providers.length > 0 && (
          <>
            <div className="au-socials">
              {providers.map((p) => (
                <button key={p} type="button" className="au-social" disabled={busy} onClick={() => social(p)}>
                  <span className="au-social-mark">{PROVIDER_MARK[p]}</span>
                  Continue with {PROVIDER_LABEL[p] || p}
                </button>
              ))}
            </div>
            <div className="au-or"><span>or use email</span></div>
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
            {busy ? <span className="au-spin" aria-label="Working" /> : cta}
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
 * index.css (loaded globally by main.tsx), never from literals — the one
 * exception being Google's brand marks, which their guidelines require
 * unmodified.
 *
 * This page previously hardcoded a dark palette and a #5b8cff BLUE accent while
 * the brand is #F5A97F, the same defect that got LandingPage.tsx deleted rather
 * than fixed. Hardcoding also pinned it to dark, so a visitor on the light theme
 * met a dark form and then a light app. Tokens fix both at once.
 */
.au-wrap { min-height: 100vh; min-height: 100dvh; display: flex; align-items: center;
  justify-content: center; padding: 24px 20px;
  background: var(--cr-ink-0); color: var(--cr-fg-1);
  font-family: var(--cr-font-sans);
  /* One soft brand wash behind the card. Sized in vmax so it scales with the
   * viewport instead of becoming a hard disc on a phone. */
  background-image: radial-gradient(60vmax 40vmax at 50% -10%, var(--cr-brand-surf), transparent 70%); }

/* max-width, not width: this is the signed-out landing for the whole app, so it
 * has to hold at 320px. */
.au-card { width: 100%; max-width: 380px; padding: clamp(24px, 6vw, 36px);
  background: var(--cr-ink-1); border: 1px solid var(--cr-ink-2);
  border-radius: var(--cr-radius-lg); box-sizing: border-box;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.34); }

.au-brand { display: flex; align-items: center; gap: 7px;
  font-family: var(--cr-font-display); font-size: 13px; font-weight: 600;
  letter-spacing: 0.04em; text-transform: lowercase;
  margin-bottom: 26px; color: var(--cr-fg-2); }
.au-logo { color: var(--cr-brand-500); font-size: 11px; }

.au-card h1 { font-family: var(--cr-font-display); font-size: 21px; line-height: 1.25;
  margin: 0 0 7px; color: var(--cr-fg-1); letter-spacing: -0.01em; }
.au-sub { margin: 0 0 24px; font-size: 13px; line-height: 1.5; color: var(--cr-fg-2); }

.au-socials { display: flex; flex-direction: column; gap: 9px; }
/* min-height 44px so it is a real touch target on a phone, matching the
 * pointer:coarse sizing the marketing pages already use. */
.au-social { display: flex; align-items: center; justify-content: center; gap: 9px;
  width: 100%; min-height: 44px; padding: 11px 14px;
  background: var(--cr-ink-2); color: var(--cr-fg-1); border: 1px solid var(--cr-ink-3);
  border-radius: var(--cr-radius-md); font-size: 14px; font-weight: 500;
  font-family: inherit; cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease, transform 120ms ease; }
.au-social:hover:not(:disabled) { border-color: var(--cr-brand-line); background: var(--cr-ink-3); }
.au-social:active:not(:disabled) { transform: translateY(1px); }
.au-social:focus-visible { outline: none; box-shadow: var(--cr-focus-ring); }
.au-social:disabled { opacity: 0.55; cursor: default; }
.au-social-mark { display: inline-flex; align-items: center; }

.au-or { display: flex; align-items: center; gap: 12px; margin: 22px 0 20px;
  color: var(--cr-fg-3); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.au-or::before, .au-or::after { content: ""; flex: 1; height: 1px; background: var(--cr-ink-2); }

.au-card label { display: block; font-size: 12px; font-weight: 500;
  letter-spacing: 0.02em; color: var(--cr-fg-2); margin-bottom: 16px; }
.au-card input { display: block; width: 100%; margin-top: 7px; padding: 11px 13px;
  background: var(--cr-ink-0); color: var(--cr-fg-1); border: 1px solid var(--cr-ink-3);
  border-radius: var(--cr-radius-md); font-size: 14px; box-sizing: border-box;
  font-family: inherit; transition: border-color 120ms ease, box-shadow 120ms ease; }
.au-card input::placeholder { color: var(--cr-fg-3); opacity: 0.65; }
.au-card input:focus { outline: none; border-color: var(--cr-brand-500);
  box-shadow: var(--cr-focus-ring); }

.au-error, .au-notice { padding: 9px 12px; border-radius: var(--cr-radius-md);
  font-size: 12.5px; line-height: 1.45; margin-bottom: 16px; }
.au-error { background: rgba(220, 80, 90, 0.10); border: 1px solid rgba(220, 80, 90, 0.30);
  color: #ff8f98; }
.au-notice { background: var(--cr-brand-surf); border: 1px solid var(--cr-brand-line);
  color: var(--cr-brand-500); }

.au-submit { display: flex; align-items: center; justify-content: center;
  width: 100%; min-height: 44px; padding: 11px 14px; margin-top: 4px;
  background: var(--cr-brand-500); color: var(--cr-ink-0); border: none;
  border-radius: var(--cr-radius-md); font-size: 14px; font-weight: 600;
  font-family: inherit; cursor: pointer;
  transition: background 120ms ease, transform 120ms ease; }
.au-submit:hover:not(:disabled) { background: var(--cr-brand-600); }
.au-submit:active:not(:disabled) { transform: translateY(1px); }
.au-submit:focus-visible { outline: none; box-shadow: var(--cr-focus-ring); }
.au-submit:disabled { opacity: 0.7; cursor: default; }

/* A spinner rather than an ellipsis: "…" is indistinguishable from a typo and
 * gives no sense that anything is happening on a slow connection. */
.au-spin { width: 15px; height: 15px; border-radius: 50%;
  border: 2px solid rgba(0, 0, 0, 0.25); border-top-color: var(--cr-ink-0);
  animation: au-spin 620ms linear infinite; }
@keyframes au-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .au-spin { animation-duration: 2.4s; }
  .au-social, .au-submit { transition: none; }
}

.au-toggle { margin-top: 14px; width: 100%; background: none; border: none;
  color: var(--cr-fg-2); font-size: 12.5px; font-family: inherit; cursor: pointer;
  padding: 6px 0; }
.au-toggle:hover { color: var(--cr-brand-500); }
.au-toggle:focus-visible { outline: none; box-shadow: var(--cr-focus-ring);
  border-radius: var(--cr-radius-sm); }
`;
