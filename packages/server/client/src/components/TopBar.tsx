import React, { useEffect, useRef, useState } from 'react';
import { Icon, IconButton, Input, Logo, Button, Avatar } from './primitives';

type NavView = 'home' | 'projects' | 'search' | 'memory' | 'toolkit' | 'dashboard' | 'activity' | 'security' | 'code' | 'settings' | 'account';

interface NavItem { id: NavView; label: string; icon: string }

/**
 * Primary nav — the 5 core destinations. Projects is intentionally NOT here:
 * it stays reachable via the Overview tiles and the sidebar project picker
 * (the view + ?view=projects deep links keep working).
 */
const PRIMARY_NAV: NavItem[] = [
  { id: 'home', label: 'Overview', icon: 'home' },
  { id: 'search', label: 'Conversations', icon: 'message' },
  { id: 'security', label: 'Security', icon: 'shield' },
  { id: 'code', label: 'Code', icon: 'code' },
  { id: 'dashboard', label: 'Insights', icon: 'chart' },
];

/** Secondary destinations, tucked into the "More" overflow menu. */
const OVERFLOW_NAV: NavItem[] = [
  { id: 'memory', label: 'Memory', icon: 'brain' },
  { id: 'toolkit', label: 'Toolkit', icon: 'terminal' },
  { id: 'activity', label: 'Activity', icon: 'clock' },
];

interface TopBarProps {
  view: string;
  setView: (v: 'home' | 'projects' | 'search' | 'memory' | 'toolkit' | 'dashboard' | 'activity' | 'security' | 'code' | 'settings' | 'account') => void;
  /** Views this deployment supports (/api/capabilities). Absent = all. */
  enabledViews?: Set<string>;
  query: string;
  setQuery: (q: string) => void;
  searchRef?: React.RefObject<HTMLInputElement>;
  onSearch?: (q: string) => void;
  /** Mobile-only: open/close the sidebar drawer. Hidden on desktop via CSS. */
  onMobileMenu?: () => void;
  /** Mobile drawer state — drives aria-expanded on the hamburger so
   *  screen readers announce open/closed transitions. */
  mobileSidebarOpen?: boolean;
}

export default function TopBar({ view, setView, enabledViews, query, setQuery, searchRef, onSearch, onMobileMenu, mobileSidebarOpen }: TopBarProps) {
  const [theme, setTheme] = useState(() =>
    document.documentElement.getAttribute('data-theme') || 'dark'
  );

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    const killer = document.createElement('style');
    killer.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
    document.head.appendChild(killer);
    setTheme(next);
    if (next === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    try { localStorage.setItem('cr-theme', next); } catch (e) {}
    requestAnimationFrame(() => requestAnimationFrame(() => killer.remove()));
  };

  const gate = (n: NavItem) => !enabledViews || enabledViews.has(n.id);
  const navItems = PRIMARY_NAV.filter(gate);
  const overflowItems = OVERFLOW_NAV.filter(gate);

  return (
    <header
      className="cr-topbar"
      style={{
        height: 'var(--cr-header-h)',
        flexShrink: 0,
        background: 'var(--cr-ink-1)',
        borderBottom: '1px solid var(--cr-line-1)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        gap: 16,
      }}
    >
      {/* Mobile hamburger — opens the sidebar drawer. Hidden on desktop. */}
      <IconButton
        icon="menu"
        title={mobileSidebarOpen ? 'Close menu' : 'Open menu'}
        onClick={onMobileMenu}
        className="cr-mobile-only"
        aria-label={mobileSidebarOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={mobileSidebarOpen}
        aria-controls="cr-sidebar-drawer"
        data-testid="open-mobile-menu"
      />

      {/* Brand */}
      <div className="cr-topbar-brand" style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 'var(--cr-sidebar-w)', paddingLeft: 4 }}>
        <span className="cr-topbar-brand-logo"><Logo size={26} /></span>
        <span data-testid="brand" className="cr-topbar-brand-text" style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--cr-fg-1)' }}>
          Chat Recall
        </span>
        <span
          className="cr-topbar-brand-tag"
          style={{
            padding: '2px 6px',
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '0.04em',
            color: 'var(--cr-fg-3)',
            background: 'var(--cr-ink-2)',
            border: '1px solid var(--cr-line-1)',
            borderRadius: 4,
            textTransform: 'uppercase',
          }}
        >
          Beta
        </span>
        <span
          title="Build time (UTC) of the dashboard your tab is running. If this is older than the latest deploy, your browser is serving a stale copy."
          style={{
            padding: '2px 6px',
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '0.02em',
            color: 'var(--cr-fg-3)',
            border: '1px dashed var(--cr-line-1)',
            borderRadius: 4,
            fontFamily: 'monospace',
          }}
        >
          {typeof __BUILD_STAMP__ !== 'undefined' ? __BUILD_STAMP__ : 'dev'}
        </span>
        <SyncStatusChip />
      </div>

      {/* Nav */}
      <nav className="cr-topbar-nav" style={{ display: 'flex', gap: 2 }}>
        {navItems.map((n) => {
          const on = view === n.id;
          return (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              data-testid={`nav-${n.id}`}
              style={{
                height: 32,
                padding: '0 12px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                background: on ? 'var(--cr-ink-2)' : 'transparent',
                color: on ? 'var(--cr-fg-1)' : 'var(--cr-fg-2)',
                border: 'none',
                borderRadius: 6,
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: on ? 500 : 400,
                cursor: 'pointer',
                transition: 'background var(--cr-dur-fast), color var(--cr-dur-fast)',
              }}
              onMouseEnter={(e) => {
                if (!on) (e.currentTarget as HTMLButtonElement).style.color = 'var(--cr-fg-1)';
              }}
              onMouseLeave={(e) => {
                if (!on) (e.currentTarget as HTMLButtonElement).style.color = 'var(--cr-fg-2)';
              }}
            >
              <Icon name={n.icon} size={14} />
              {n.label}
            </button>
          );
        })}
        {overflowItems.length > 0 && (
          <MoreMenu items={overflowItems} view={view} setView={setView} />
        )}
      </nav>

      {/* Global search */}
      <div className="cr-topbar-search" style={{ flex: 1, display: 'flex', justifyContent: 'center', maxWidth: 640, margin: '0 auto', gap: 8 }}>
        <Input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter' && query.trim()) onSearch?.(query);
          }}
          placeholder={'Search… (use "exact phrase" or +keyword)'}
          title='Search syntax: "exact phrase" for literal match, +keyword to require a term, bare words for permissive OR.'
          onClear={query ? () => setQuery('') : undefined}
          kbd="⌘K"
          inputSize="md"
          style={{ width: '100%' }}
          data-testid="search-input"
        />
        <Button
          variant="primary"
          size="md"
          disabled={!query.trim()}
          data-testid="search-button"
          onClick={() => onSearch?.(query)}
          className="cr-topbar-search-btn"
        >
          Search
        </Button>
      </div>

      {/* Right actions */}
      <div className="cr-topbar-actions" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <IconButton icon="refresh" title="Refresh index" aria-label="Refresh index" className="cr-topbar-action-refresh" />
        <IconButton
          icon={theme === 'dark' ? 'sun' : 'moon'}
          title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={toggleTheme}
          className="cr-topbar-action-theme"
        />
        {(!enabledViews || enabledViews.has('settings')) && (
          <IconButton
            icon="settings"
            title="Settings"
            aria-label="Settings"
            onClick={() => setView('settings')}
            data-testid="open-settings"
            // Visual cue when already on the settings page so the user can see
            // the gear icon is the current location, not just a button.
            style={view === 'settings' ? { color: 'var(--cr-brand-500)' } : undefined}
          />
        )}
        {(!enabledViews || enabledViews.has('account')) ? (
          <button
            className="cr-topbar-avatar"
            title="Account"
            onClick={() => setView('account')}
            aria-label="Account"
            style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', padding: 0, borderRadius: '50%', outline: view === 'account' ? '2px solid var(--cr-brand-500)' : 'none' }}
          >
            <Avatar name="User" size={28} />
          </button>
        ) : (
          <div className="cr-topbar-avatar" style={{ marginLeft: 4 }}>
            <Avatar name="User" size={28} />
          </div>
        )}
      </div>
    </header>
  );
}


/**
 * MoreMenu — overflow dropdown for secondary nav destinations (Memory,
 * Toolkit, Activity). Built from existing primitives + the shared nav button
 * style. Keyboard accessible: ArrowDown/ArrowUp walk the items, Escape
 * closes and returns focus to the trigger, Enter/Space activate (native
 * <button> behavior). Closes on outside click.
 */
function MoreMenu({ items, view, setView }: { items: NavItem[]; view: string; setView: (v: NavView) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const active = items.some((n) => n.id === view);

  // Close when clicking anywhere outside the trigger + menu.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const openAndFocus = (index: number) => {
    setOpen(true);
    // Focus after the menu renders.
    requestAnimationFrame(() => itemRefs.current[index]?.focus());
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = itemRefs.current.findIndex((el) => el === document.activeElement);
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const next = (idx + delta + items.length) % items.length;
      itemRefs.current[next]?.focus();
    } else if (e.key === 'Tab') {
      // Tab walks out of the menu — close it so it doesn't linger.
      setOpen(false);
    }
  };

  const pick = (id: NavView) => {
    setView(id);
    setOpen(false);
    btnRef.current?.focus();
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        data-testid="nav-more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More views"
        onClick={() => (open ? setOpen(false) : openAndFocus(0))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) { e.preventDefault(); openAndFocus(0); }
          if (e.key === 'Escape' && open) { setOpen(false); }
        }}
        style={{
          height: 32,
          padding: '0 12px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          background: active || open ? 'var(--cr-ink-2)' : 'transparent',
          color: active || open ? 'var(--cr-fg-1)' : 'var(--cr-fg-2)',
          border: 'none',
          borderRadius: 6,
          fontFamily: 'inherit',
          fontSize: 13,
          fontWeight: active ? 500 : 400,
          cursor: 'pointer',
          transition: 'background var(--cr-dur-fast), color var(--cr-dur-fast)',
        }}
        onMouseEnter={(e) => {
          if (!active && !open) (e.currentTarget as HTMLButtonElement).style.color = 'var(--cr-fg-1)';
        }}
        onMouseLeave={(e) => {
          if (!active && !open) (e.currentTarget as HTMLButtonElement).style.color = 'var(--cr-fg-2)';
        }}
      >
        More
        <Icon name="chevronDown" size={13} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="More views"
          data-testid="nav-more-menu"
          onKeyDown={onMenuKeyDown}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            minWidth: 168,
            padding: 4,
            background: 'var(--cr-ink-1)',
            border: '1px solid var(--cr-line-1)',
            borderRadius: 8,
            boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
            zIndex: 200,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
          {items.map((n, i) => {
            const on = view === n.id;
            return (
              <button
                key={n.id}
                role="menuitem"
                ref={(el) => { itemRefs.current[i] = el; }}
                data-testid={`nav-${n.id}`}
                onClick={() => pick(n.id)}
                style={{
                  height: 32,
                  padding: '0 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  textAlign: 'left',
                  background: on ? 'var(--cr-ink-2)' : 'transparent',
                  color: on ? 'var(--cr-fg-1)' : 'var(--cr-fg-2)',
                  border: 'none',
                  borderRadius: 6,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: on ? 500 : 400,
                  cursor: 'pointer',
                  transition: 'background var(--cr-dur-fast), color var(--cr-dur-fast)',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--cr-ink-2)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = on ? 'var(--cr-ink-2)' : 'transparent'; }}
              >
                <Icon name={n.icon} size={14} />
                {n.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Live data-coverage chip: sessions held, raw-archived count, freshness of
 * the newest session. Trust-by-glance — replaces "is it synced?" arguments.
 */
export function SyncStatusChip() {
  const [s, setS] = React.useState<{ sessions: number; rawArchived: number; newestSessionAgeMs: number | null } | null>(null);
  React.useEffect(() => {
    let dead = false;
    const load = () => fetch('/api/status/sync').then(r => r.json()).then(d => { if (!dead) setS(d); }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { dead = true; clearInterval(t); };
  }, []);
  if (!s || typeof s.sessions !== 'number') return null;
  const age = s.newestSessionAgeMs == null ? '—'
    : s.newestSessionAgeMs < 120_000 ? 'live'
    : s.newestSessionAgeMs < 3_600_000 ? `${Math.round(s.newestSessionAgeMs / 60_000)}m behind`
    : `${Math.round(s.newestSessionAgeMs / 3_600_000)}h behind`;
  return (
    <span
      title={`${s.sessions} sessions held · ${s.rawArchived} raw-archived · newest data ${age}`}
      style={{
        padding: '2px 6px', fontSize: 10, fontWeight: 500, letterSpacing: '0.02em',
        color: 'var(--cr-fg-3)', border: '1px solid var(--cr-line-1)', borderRadius: 4,
        fontFamily: 'monospace',
      }}
    >
      {s.sessions.toLocaleString()} sess · {s.rawArchived.toLocaleString()} raw · {age}
    </span>
  );
}
