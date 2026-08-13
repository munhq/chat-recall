import { useState } from 'react';
import { signInEmail, signUpEmail } from '../services/auth';

/**
 * Email + password sign-in / sign-up for cloud mode. This form replaced the
 * Keycloak-hosted login page: the exchange runs against our own
 * /api/auth/sign-{in,up}/email endpoints and never leaves this origin.
 * On success the session token is already stored — the caller re-renders
 * the app (no redirect, so any query string like ?view=connect survives).
 */
export default function AuthPage({ onSuccess, initialMode = 'signin' }: {
  onSuccess: () => void;
  initialMode?: 'signin' | 'signup';
}) {
  const [mode, setMode] = useState<'signin' | 'signup'>(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = signup
      ? await signUpEmail(name.trim() || email.split('@')[0], email.trim(), password)
      : await signInEmail(email.trim(), password);
    setBusy(false);
    if (r.ok) onSuccess();
    else setError(r.error);
  };

  return (
    <div className="au-wrap">
      <style>{AUTH_CSS}</style>
      <div className="au-card">
        <div className="au-brand"><span className="au-logo">◆</span> chat-recall</div>
        <h1>{signup ? 'Create your account' : 'Sign in'}</h1>
        <form onSubmit={submit}>
          {signup && (
            <label>
              Name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                autoComplete="name" placeholder="Ada" />
            </label>
          )}
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              autoComplete="email" required placeholder="you@example.com" />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete={signup ? 'new-password' : 'current-password'} required minLength={8}
              placeholder={signup ? 'At least 8 characters' : ''} />
          </label>
          {error && <div className="au-error">{error}</div>}
          <button className="au-submit" type="submit" disabled={busy}>
            {busy ? '…' : signup ? 'Create account' : 'Sign in'}
          </button>
        </form>
        <button className="au-toggle" onClick={() => { setMode(signup ? 'signin' : 'signup'); setError(null); }}>
          {signup ? 'Already have an account? Sign in' : 'New here? Create an account'}
        </button>
      </div>
    </div>
  );
}

const AUTH_CSS = `
.au-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: #0b0e14; color: #e6e9ef; font-family: system-ui, -apple-system, sans-serif; }
.au-card { width: 340px; padding: 32px; background: #11151f; border: 1px solid #1e2534;
  border-radius: 12px; }
.au-brand { font-weight: 600; letter-spacing: 0.02em; margin-bottom: 20px; color: #9aa4b8; }
.au-logo { color: #5b8cff; margin-right: 6px; }
.au-card h1 { font-size: 20px; margin: 0 0 20px; }
.au-card label { display: block; font-size: 13px; color: #9aa4b8; margin-bottom: 14px; }
.au-card input { display: block; width: 100%; margin-top: 6px; padding: 10px 12px;
  background: #0b0e14; color: #e6e9ef; border: 1px solid #2a3346; border-radius: 8px;
  font-size: 14px; box-sizing: border-box; }
.au-card input:focus { outline: none; border-color: #5b8cff; }
.au-error { background: #2a1215; border: 1px solid #6b2a31; color: #ff8f98;
  padding: 8px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 14px; }
.au-submit { width: 100%; padding: 10px 12px; background: #5b8cff; color: #fff;
  border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
.au-submit:disabled { opacity: 0.6; cursor: default; }
.au-toggle { margin-top: 16px; width: 100%; background: none; border: none;
  color: #9aa4b8; font-size: 13px; cursor: pointer; text-decoration: underline; }
`;
