import { useEffect, useRef, useState } from 'react';
import { isCloud, logout } from '../services/auth';
import { getMe } from '../services/api';

/**
 * The signed-in user, pinned to the bottom of the sidebar, opening a small menu.
 *
 * This is the convention for a left-rail app shell — Linear, Supabase, Vercel
 * and Slack all put identity and sign-out here. The other common pattern, an
 * avatar in the top right, belongs to apps with a top header bar; this one has
 * no header, so there is nowhere for it to live up there.
 *
 * It exists because sign-out previously had no control at all: logout() was
 * exported and never called, so the only way out was clearing the cookie by
 * hand. Putting it at the bottom of the Account page was the first attempt and
 * was still wrong — nobody scrolls past Connected machines and fleet health
 * looking for a way to leave.
 *
 * Renders nothing outside cloud mode, where there is no session to end.
 */
export default function SidebarUser({ onAccount }: { onAccount?: () => void }) {
  const [email, setEmail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isCloud()) return;
    void getMe().then((me) => setEmail(me.user?.email ?? null)).catch(() => {});
  }, []);

  // Close on outside click and on Escape. Both, because a menu that traps the
  // page is worse than no menu, and Escape is what people reach for first.
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

  if (!isCloud()) return null;

  const label = email || 'Signed in';
  const initial = (email?.trim()?.[0] || '?').toUpperCase();

  return (
    <div ref={boxRef} className="cr-user" data-testid="sidebar-user">
      <style>{USER_CSS}</style>

      {open && (
        <div className="cr-user-menu" role="menu" aria-label="Account">
          {onAccount && (
            <button
              type="button"
              role="menuitem"
              className="cr-user-menu-item"
              onClick={() => { setOpen(false); onAccount(); }}
              data-testid="user-menu-account"
            >
              Account settings
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="cr-user-menu-item danger"
            onClick={() => logout()}
            data-testid="user-menu-signout"
          >
            Sign out
          </button>
        </div>
      )}

      <button
        type="button"
        className="cr-user-chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        // The full address in the tooltip because the visible one is truncated:
        // long addresses are the common case, not the edge case.
        title={label}
        data-testid="sidebar-user-chip"
      >
        <span className="cr-user-avatar" aria-hidden="true">{initial}</span>
        <span className="cr-user-email">{label}</span>
        <span className="cr-user-caret" aria-hidden="true">{open ? '▾' : '▴'}</span>
      </button>
    </div>
  );
}

const USER_CSS = `
.cr-user { position: relative; border-top: 1px solid var(--cr-line-1, #1e232b);
  padding: 8px; background: var(--cr-ink-1); flex: 0 0 auto; }

.cr-user-chip { display: flex; align-items: center; gap: 9px; width: 100%;
  min-height: 44px; padding: 7px 8px; background: transparent; border: none;
  border-radius: var(--cr-radius-md, 8px); cursor: pointer; text-align: left;
  color: var(--cr-fg-1); font: inherit; transition: background 120ms ease; }
.cr-user-chip:hover { background: var(--cr-ink-2); }
.cr-user-chip:focus-visible { outline: none; box-shadow: var(--cr-focus-ring); }

.cr-user-avatar { flex: 0 0 auto; width: 26px; height: 26px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--cr-brand-surf); color: var(--cr-brand-500);
  border: 1px solid var(--cr-brand-line);
  font-size: 12px; font-weight: 600; }

/* min-width:0 is load-bearing: without it a flex child refuses to shrink below
   its content and the ellipsis never engages, so a long address pushes the
   caret out of the sidebar instead of truncating. */
.cr-user-email { flex: 1; min-width: 0; font-size: 12.5px; color: var(--cr-fg-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cr-user-caret { flex: 0 0 auto; font-size: 9px; color: var(--cr-fg-3); }

/* Opens UPWARD — the chip is the last thing in the sidebar, so a downward menu
   would render off-screen. */
.cr-user-menu { position: absolute; bottom: calc(100% - 4px); left: 8px; right: 8px;
  background: var(--cr-ink-2); border: 1px solid var(--cr-line-1, #1e232b);
  border-radius: var(--cr-radius-md, 8px); padding: 4px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.42); z-index: 40; }
.cr-user-menu-item { display: block; width: 100%; text-align: left;
  padding: 9px 10px; min-height: 38px; background: transparent; border: none;
  border-radius: var(--cr-radius-sm, 6px); color: var(--cr-fg-1);
  font: inherit; font-size: 13px; cursor: pointer; }
.cr-user-menu-item:hover { background: var(--cr-ink-3); }
.cr-user-menu-item:focus-visible { outline: none; box-shadow: var(--cr-focus-ring); }
.cr-user-menu-item.danger { color: var(--cr-err-500, #f87171); }
`;
