import React, { useState } from 'react';
import { Icon, IconButton, Input, Logo, Button, Avatar } from './primitives';

interface TopBarProps {
  view: string;
  setView: (v: 'search' | 'memory' | 'toolkit' | 'dashboard' | 'activity' | 'security' | 'settings') => void;
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

/**
 * Live data-coverage chip: sessions held, raw-archived count, freshness of
 * the newest session. Trust-by-glance — replaces "is it synced?" arguments.
 */
function SyncStatusChip() {
  const [s, setS] = React.useState<{ sessions: number; rawArchived: number; newestSessionAgeMs: number | null } | null>(null);
  React.useEffect(() => {
    let dead = false;
    const load = () => fetch('/api/status/sync').then(r => r.json()).then(d => { if (!dead) setS(d); }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { dead = true; clearInterval(t); };
  }, []);
  if (!s) return null;
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

export