import React, { useState } from 'react';
import { IconButton, Input, Logo, Button, Avatar } from './primitives';
import { getSyncStatus } from '../services/api';

type NavView = 'home' | 'projects' | 'search' | 'memory' | 'toolkit' | 'security' | 'settings' | 'account' | 'connect' | 'admin';

// Primary navigation now lives in the left rail (see Sidebar.tsx) where every
// destination is visible at once. The topbar is deliberately just three zones:
// brand · global search · status + actions.

interface TopBarProps {
  view: string;
  setView: (v: NavView) => void;
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
  /** Re-fetch the current view's data + freshness (the "Refresh index" button). */
  onRefresh?: () => void;
}

export default function TopBar({ view, setView, enabledViews, query, setQuery, searchRef, onSearch, onMobileMenu, mobileSidebarOpen, onRefresh }: TopBarProps) {
  const [theme, setTheme] = useState(() =>
    document.documentElement.getAttribute('data-theme') || 'dark'
  );
  const [refreshing, setRefreshing] = useState(false);
  const [chipRefresh, setChipRefresh] = useState(0);
  const handleRefresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    setChipRefresh((n) => n + 1);
    onRefresh?.();
    window.setTimeout(() => setRefreshing(false), 900);
  };

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

      {/* Brand — clickable, goes home (Overview). The build stamp is
          developer debug, not user-facing; it's a tooltip on the BETA
          tag now instead of a visible chip. */}
      <div
        className="cr-topbar-brand"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          minWidth: 'var(--cr-sidebar-w)',
          paddingLeft: 4,
          cursor: 'pointer',
        }}
        onClick={() => setView('home')}
        data-testid="brand"
        title="Back to Overview"
      >
        <span className="cr-topbar-brand-logo"><Logo size={26} /></span>
        <span className="cr-topbar-brand-text" style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--cr-fg-1)' }}>
          Chat Recall
        </span>
        <span
          className="cr-topbar-brand-tag"
          title={`Beta — build ${typeof __BUILD_STAMP__ !== 'undefined' ? __BUILD_STAMP__ : 'dev'}`}
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
            cursor: 'help',
          }}
        >
          Beta
        </span>
      </div>

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

      {/* Right actions — status first (freshness at a glance), then controls. */}
      <div className="cr-topbar-actions" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <SyncStatusChip refreshSignal={chipRefresh} />
        <IconButton
          icon="refresh"
          title="Refresh data"
          aria-label="Refresh data"
          disabled={refreshing}
          onClick={handleRefresh}
          className={`cr-topbar-action-refresh${refreshing ? ' cr-spin' : ''}`}
        />
        <IconButton
          icon={theme === 'dark' ? 'sun' : 'moon'}
          title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={toggleTheme}
          className="cr-topbar-action-theme"
        />
        {(!enabledViews || enabledViews.has('admin')) && (
          <IconButton
            icon="shield"
            title="Admin Console"
            aria-label="Admin Console"
            onClick={() => setView('admin')}
            data-testid="open-admin"
            style={view === 'admin' ? { color: 'var(--cr-brand-500)' } : undefined}
          />
        )}
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
 * Live data-coverage chip: sessions held, raw-archived count, freshness of
 * the newest session. Trust-by-glance — replaces "is it synced?" arguments.
 */
export function SyncStatusChip({ refreshSignal }: { refreshSignal?: number }) {
  const [s, setS] = React.useState<{ sessions: number; rawArchived: number; newestSessionAgeMs: number | null } | null>(null);
  React.useEffect(() => {
    let dead = false;
    // getSyncStatus goes through the api helper → correct origin + Keycloak
    // Bearer in cloud mode. A raw fetch('/api/…') here 401'd on the SaaS.
    const load = () => getSyncStatus().then(d => { if (!dead) setS(d); }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { dead = true; clearInterval(t); };
  }, [refreshSignal]);
  if (!s || typeof s.sessions !== 'number') return null;
  // Freshness is the one signal worth showing at a glance; raw counts are
  // detail, so they live in the tooltip. A single ok/warn dot + one word keeps
  // the brand zone clean instead of a monospace telemetry chip.
  const fresh = s.newestSessionAgeMs != null && s.newestSessionAgeMs < 120_000;
  const word = s.newestSessionAgeMs == null ? '—'
    : fresh ? 'live'
    : s.newestSessionAgeMs < 3_600_000 ? `${Math.round(s.newestSessionAgeMs / 60_000)}m behind`
    : `${Math.round(s.newestSessionAgeMs / 3_600_000)}h behind`;
  const dot = fresh ? 'var(--cr-ok-500)' : s.newestSessionAgeMs == null ? 'var(--cr-fg-3)' : 'var(--cr-warn-500)';
  return (
    <span
      className="cr-topbar-sync"
      title={`${s.sessions.toLocaleString()} sessions held · ${s.rawArchived.toLocaleString()} raw-archived · newest data ${word}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 8px 2px 7px', fontSize: 11, fontWeight: 450,
        color: 'var(--cr-fg-2)', border: '1px solid var(--cr-line-1)', borderRadius: 999,
      }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: '50%', background: dot, flexShrink: 0,
        boxShadow: fresh ? `0 0 5px ${dot}` : 'none',
      }} />
      {word}
    </span>
  );
}
