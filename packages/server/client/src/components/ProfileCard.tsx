/**
 * Who you are signed in as — the card the Account page never had.
 *
 * The page was called "Account" and showed a subscription, some machines and a
 * webhook. It never showed the address it all belonged to, never let anyone
 * change their name, and offered no way to change a password except signing out
 * and using "forgot password" on the login screen. On a page whose whole job is
 * account management, identity was the one thing missing.
 *
 * Everything here reads from and writes to better-auth directly (see
 * services/auth.ts). No route of our own: better-auth already owns this record,
 * and a second read path is a second thing that can disagree with what the
 * server enforces at the next sign-in.
 */
import { useEffect, useState } from 'react';
import { Button, Input } from './primitives';
import {
  getSessionUser, updateDisplayName, changePassword, resendVerificationEmail,
  type SessionUser,
} from '../services/auth';

/** Initials for the avatar. Falls back to the address when no name is set,
 *  because a blank circle beside an email address looks like a failed load. */
function initials(u: SessionUser): string {
  const source = u.name?.trim() || u.email.split('@')[0] || '?';
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

export default function ProfileCard({ onError }: { onError: (s: string) => void }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [name, setName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [msg, setMsg] = useState('');

  // The password form stays closed. It is three inputs that almost nobody needs
  // on any given visit, and an always-open form of empty password boxes reads as
  // something being wrong.
  const [pwOpen, setPwOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  const [resent, setResent] = useState(false);

  useEffect(() => {
    void getSessionUser().then((u) => { if (u) { setUser(u); setName(u.name); } });
  }, []);

  async function saveName() {
    if (!user || !name.trim() || name.trim() === user.name) return;
    setSavingName(true); setMsg(''); onError('');
    const r = await updateDisplayName(name.trim());
    setSavingName(false);
    if (!r.ok) return onError(r.error);
    setUser({ ...user, name: name.trim() });
    setMsg('Name saved.');
  }

  async function submitPassword() {
    setMsg(''); onError('');
    if (next.length < 8) return onError('Choose a password of at least 8 characters.');
    if (next !== confirm) return onError('The two new passwords do not match.');
    setPwBusy(true);
    const r = await changePassword(current, next);
    setPwBusy(false);
    if (!r.ok) return onError(r.error);
    setCurrent(''); setNext(''); setConfirm(''); setPwOpen(false);
    setMsg('Password changed. Every other browser has been signed out.');
  }

  if (!user) {
    return (
      <section className="acct-card">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  const since = user.createdAt ? new Date(user.createdAt) : null;

  return (
    <section className="acct-card">
      <div className="pf-id">
        <div className="pf-avatar" aria-hidden="true">{initials(user)}</div>
        <div className="pf-idtext">
          <div className="pf-name">{user.name || user.email.split('@')[0]}</div>
          <div className="pf-mail">
            {user.email}
            {user.emailVerified
              ? <span className="pf-chip pf-chip-ok" title="Confirmed">Verified</span>
              : <span className="pf-chip pf-chip-warn">Unverified</span>}
          </div>
        </div>
      </div>

      {/* An unconfirmed address is not cosmetic: the trial is withheld until it
          is confirmed (see util/trial.ts), so this is the one blocker on the page
          that silently costs the reader the product. */}
      {!user.emailVerified && (
        <div className="pf-warn">
          <p className="muted" style={{ margin: 0 }}>
            Your trial does not start until this address is confirmed. Check your inbox for the
            six-digit code, or send another.
          </p>
          <Button
            variant="secondary"
            disabled={resent}
            onClick={async () => {
              const r = await resendVerificationEmail(user.email);
              if (!r.ok) return onError(r.error);
              setResent(true); setMsg('Sent. It expires in 15 minutes.');
            }}
          >
            {resent ? 'Sent' : 'Resend the code'}
          </Button>
        </div>
      )}

      {msg && <div className="pf-ok" role="status">{msg}</div>}

      <div className="pf-field">
        <label htmlFor="pf-name">Display name</label>
        <div className="pf-inline">
          <Input
            id="pf-name" value={name} placeholder="Your name"
            autoComplete="name" onChange={(e) => setName(e.target.value)}
          />
          <Button
            variant="secondary"
            disabled={savingName || !name.trim() || name.trim() === user.name}
            onClick={saveName}
          >
            {savingName ? 'Saving…' : 'Save'}
          </Button>
        </div>
        <p className="muted" style={{ marginTop: 6 }}>
          Shown beside the work you sync, so a teammate can tell your sessions from theirs.
        </p>
      </div>

      <div className="acct-row">
        <span>Email</span>
        <span className="muted">Write to contact@chatrecall.dev to change it</span>
      </div>
      {since && (
        <div className="acct-row">
          <span>Member since</span>
          <span>{since.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</span>
        </div>
      )}

      <div className="pf-field">
        <label>Password</label>
        {!pwOpen ? (
          <div className="acct-actions" style={{ marginTop: 8 }}>
            <Button variant="secondary" onClick={() => setPwOpen(true)}>Change password</Button>
          </div>
        ) : (
          <div className="pf-pw">
            <Input
              type="password" placeholder="Current password" value={current}
              autoComplete="current-password" onChange={(e) => setCurrent(e.target.value)}
            />
            <Input
              type="password" placeholder="New password" value={next}
              autoComplete="new-password" onChange={(e) => setNext(e.target.value)}
            />
            <Input
              type="password" placeholder="New password again" value={confirm}
              autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)}
            />
            <p className="muted">
              Changing it signs out every other browser. That is deliberate: a password you are
              replacing because you suspect it should not stay valid anywhere.
            </p>
            <div className="acct-actions">
              <Button disabled={pwBusy || !current || !next} onClick={submitPassword}>
                {pwBusy ? 'Changing…' : 'Change password'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => { setPwOpen(false); setCurrent(''); setNext(''); setConfirm(''); }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
