import React, { useState } from 'react';
import UserMenu from './UserMenu';
import { IconButton, Input, Logo, Button, Avatar } from './primitives';
import { getSyncStatus, type SyncStatus } from '../services/api';
import { syncLabel, syncTone, ago } from '../services/sync-label';
import { getEntitlement } from '../services/api';

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

      {/* Brand — clickable, goes home (Overview). The build stamp is developer
          debug, not user-facing, so it rides as a tooltip on the brand text
          rather than as a visible chip. */}
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
        <span
          className="cr-topbar-brand-text"
          title={`build ${typeof __BUILD_STAMP__ !== 'undefined' ? __BUILD_STAMP__ : 'dev'}`}
          style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--cr-fg-1)' }}
        >
          Chat Recall
        </span>
      </div>

      {/* Global search */}
      <div className="cr-topbar-search" style={{ flex: 1, display: 'flex', justifyContent: 'center', maxWidth: 640, margin: '0 auto', gap: 8 }}>
        <Input
          icon="search"
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
        <PlanChip onOpenAccount={() => setView('account')} enabledViews={enabledViews} />
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
        <UserMenu onAccount={() => setView('account')} />
      </div>
    </header>
  );
}

/**
 * Live data-coverage chip: sessions held, raw-archived count, freshness of
 * the newest session. Trust-by-glance — replaces "is it synced?" arguments.
 */
export function SyncStatusChip({ refreshSignal }: { refreshSignal?: number }) {
  // The shared SyncStatus type rather than a local restatement of three of its
  // fields — a hand-copied shape is why adding `progress` to the API did not
  // reach this component.
  const [s, setS] = React.useState<SyncStatus | null>(null);
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
  // Both decisions live in services/sync-label.ts, where they can be tested.
  // They were a JSX ternary here, which is why "syncing 99%" and "1h behind on
  // a healthy install" both shipped.
  const syncing = s.progress && s.progress.total > 0 ? s.progress : null;
  const word = syncLabel(s);
  const tone = syncTone(s);
  const dot = tone === 'busy' ? 'var(--cr-ok-500)'
    : tone === 'ok' ? 'var(--cr-ok-500)'
    : tone === 'warn' ? 'var(--cr-warn-500)'
    : 'var(--cr-fg-3)';
  const num = (n?: number | null) => (typeof n === 'number' ? n.toLocaleString() : '—');
  return (
    <span
      className="cr-topbar-sync"
      // `num` instead of `.toLocaleString()` on the raw field. An older or
      // newer server that omits one of these numbers threw a TypeError here,
      // and because this sits in the TOP BAR it took the whole app down — a
      // white screen from one missing field in one status response.
      title={syncing
        ? `Collector is walking ${num(syncing.total)} sessions — ${num(syncing.done)} considered so far. `
          + `${num(s.sessions)} held · ${num(s.rawArchived)} raw-archived`
        : `${num(s.sessions)} sessions held · ${num(s.rawArchived)} raw-archived`
          + (s.lastSyncAgeMs != null ? ` · last sync ${ago(s.lastSyncAgeMs)}` : '')
          + (s.newestSessionAgeMs != null ? ` · newest session ${ago(s.newestSessionAgeMs)}` : '')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 8px 2px 7px', fontSize: 12, fontWeight: 450,
        color: 'var(--cr-fg-2)', border: '1px solid var(--cr-line-1)', borderRadius: 0,
      }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: '50%', background: dot, flexShrink: 0,
        boxShadow: 'none',
      }} />
      {word}
    </span>
  );
}


/**
 * Which plan am I on — answered in the chrome, not buried in Account. The
 * trial banner is dismissible and the Account page is a click away, so
 * "what am I actually on right now?" had no persistent answer; that read as
 * confusing the moment the feature set changed under someone.
 */
function PlanChip({ onOpenAccount, enabledViews }: { onOpenAccount: () => void; enabledViews?: Set<string> }) {
  const [label, setLabel] = React.useState<string | null>(null);
  const [tone, setTone] = React.useState<'trial' | 'free' | 'paid'>('paid');
  React.useEffect(() => {
    getEntitlement()
      .then((e) => {
        if (!e.billingEnabled) return;                      // self-host: no plans to state
        if (e.onTrial && e.entitled !== false) {
          setTone('trial');
          setLabel(e.trialDaysLeft != null ? `Trial · ${e.trialDaysLeft}d` : 'Trial');
        } else if (e.entitled === false) {
          setTone('free');
          setLabel('Free');
        } else {
          setTone('paid');
          const p = (e.effectivePlan || e.plan || '').toLowerCase();
          setLabel(p.startsWith('enterprise') ? 'Enterprise' : p.startsWith('team') ? 'Team' : 'Solo');
        }
      })
      .catch(() => { /* unknown state: show nothing rather than a guess */ });
  }, []);
  if (!label) return null;
  const toneStyle: React.CSSProperties = tone === 'free'
    ? { borderColor: 'var(--cr-line-2)', color: 'var(--cr-fg-2)', background: 'var(--cr-ink-1)' }
    : { borderColor: 'var(--cr-brand-line)', color: 'var(--cr-brand-500)', background: 'var(--cr-brand-surf)' };
  const clickable = !enabledViews || enabledViews.has('account');
  return (
    <button
      type="button"
      data-testid="plan-chip"
      onClick={clickable ? onOpenAccount : undefined}
      title={clickable ? 'Your plan — open Account' : 'Your plan'}
      style={{
        ...toneStyle,
        border: '1px solid', borderRadius: 0, padding: '3px 10px',
        font: '600 12px/1.4 var(--cr-font-annot)', letterSpacing: '0.04em',
        cursor: clickable ? 'pointer' : 'default', whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}
