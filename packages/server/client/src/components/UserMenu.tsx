import { useEffect, useRef, useState } from 'react';
import { isCloud, logout } from '../services/auth';
import { getMe } from '../services/api';
import { Avatar } from './primitives';

/**
 * The top-right avatar, as a menu rather than a link.
 *
 * It used to navigate straight to the Account page and render "name="User"" — a
 * placeholder that never said who was signed in — and there was no sign-out
 * control anywhere in the app at all.
 *
 * Top-right is the convention when an app HAS a header bar, which this one does.
 * A first attempt put a user chip at the bottom of the sidebar (the Linear /
 * Supabase pattern); that is right for a shell with no header, and here it just
 * duplicated this button in a second place. One location, this one.
 *
 * Outside cloud mode there is no session, so this stays a plain avatar with
 * nothing to open.
 */
export default function UserMenu({ onAccount }: { onAccount: () => void }) {
  const [email, setEmail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isCloud()) return;
    void getMe().then((me) => setEmail(me.user?.email ?? null)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Local mode: an avatar, no menu — there is no session to end and no identity
  // to show, so a chevron would promise something that is not there.
  if (!isCloud()) {
    return (
      <div className="cr-topbar-avatar" style={{ marginLeft: 4 }}>
        <Avatar name="User" size={28} />
      </div>
    );
  }

  return (
    <div ref={boxRef} className="cr-usermenu" data-testid="user-menu">
      <style>{MENU_CSS}</style>
      <button
        className="cr-topbar-avatar cr-usermenu-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={email || 'Account'}
        aria-label={email ? `Account — ${email}` : 'Account'}
        data-testid="user-menu-trigger"
      >
        {/* Avatar keys off the address, so the initial is the user's rather than
            a literal "U" from the placeholder name it used before. */}
        <Avatar name={email || 'User'} size={28} />
      </button>

      {open && (
        <div className="cr-usermenu-pop" role="menu" aria-label="Account">
          {email && <div className="cr-usermenu-who" title={email}>{email}</div>}
          <button
            type="button"
            role="menuitem"
            className="cr-usermenu-item"
            onClick={() => { setOpen(false); onAccount(); }}
            data-testid="user-menu-account"
          >
            Account &amp; devices
          </button>
          <button
            type="button"
            role="menuitem"
            className="cr-usermenu-item danger"
            onClick={() => logout()}
            data-testid="user-menu-signout"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

const MENU_CSS = `
.cr-usermenu { position: relative; margin-left: 4px; display: inline-flex; }
.cr-usermenu-trigger { background: none; border: none; cursor: pointer; padding: 0;
  border-radius: 50%; display: inline-flex; }
.cr-usermenu-trigger:focus-visible { outline: none; box-shadow: var(--cr-focus-ring); }

/* Anchored to the RIGHT edge: the trigger is the last item in the header, so a
   left-anchored menu would run off the viewport on a narrow window. */
.cr-usermenu-pop { position: absolute; top: calc(100% + 8px); right: 0; min-width: 216px;
  background: var(--cr-ink-1); border: var(--cr-frame-w) solid var(--cr-frame);
  border-radius: var(--cr-radius-md); padding: 4px;
  border: var(--cr-frame-w) solid var(--cr-frame); z-index: 60; }

/* min-width:0 + ellipsis: addresses are long and this box must not grow to fit
   one. The full value is in the trigger's title attribute. */
.cr-usermenu-who { padding: 8px 10px 9px; margin-bottom: 4px;
  border-bottom: 1px solid var(--cr-line-1);
  font-size: 12px; color: var(--cr-fg-2); min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.cr-usermenu-item { display: block; width: 100%; text-align: left;
  padding: 9px 10px; min-height: 38px; background: transparent; border: none;
  border-radius: var(--cr-radius-sm); color: var(--cr-fg-1);
  font: inherit; font-size: 13px; cursor: pointer; }
.cr-usermenu-item:hover { background: var(--cr-ink-3); }
.cr-usermenu-item:focus-visible { outline: none; box-shadow: var(--cr-focus-ring); }
.cr-usermenu-item.danger { color: var(--cr-err-500); }
`;
