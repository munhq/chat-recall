import React, { useState } from 'react';
import { Icon, IconButton, Input, Logo, Button, Avatar } from './primitives';

interface TopBarProps {
  view: string;
  setView: (v: 'search' | 'memory' | 'dashboard' | 'activity' | 'settings') => void;
  query: string;
  setQuery: (q: string) => void;
  searchRef?: React.RefObject<HTMLInputElement>;
  onSearch?: (q: string) => void;
}

export default function TopBar({ view, setView, query, setQuery, searchRef, onSearch }: TopBarProps) {
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

  const navItems: Array<{ id: 'search' | 'memory' | 'dashboard' | 'activity'; label: string; icon: string }> = [
    { id: 'search', label: 'Conversations', icon: 'message' },
    { id: 'activity', label: 'Activity', icon: 'clock' },
    { id: 'memory', label: 'Memory', icon: 'brain' },
    { id: 'dashboard', label: 'Insights', icon: 'chart' },
  ];

  return (
    <header
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
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 'var(--cr-sidebar-w)', paddingLeft: 4 }}>
        <Logo size={26} />
        <span data-testid="brand" style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--cr-fg-1)' }}>
          Chat Recall
        </span>
        <span
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
      </div>

      {/* Nav */}
      <nav style={{ display: 'flex', gap: 2 }}>
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
      </nav>

      {/* Global search */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', maxWidth: 640, margin: '0 auto', gap: 8 }}>
        <Input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations, plans, files…"
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
        >
          Search
        </Button>
      </div>

      {/* Right actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <IconButton icon="refresh" title="Refresh index" />
        <IconButton
          icon={theme === 'dark' ? 'sun' : 'moon'}
          title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          onClick={toggleTheme}
        />
        <IconButton
          icon="settings"
          title="Settings"
          onClick={() => setView('settings')}
          data-testid="open-settings"
          // Visual cue when already on the settings page so the user can see
          // the gear icon is the current location, not just a button.
          style={view === 'settings' ? { color: 'var(--cr-brand-500)' } : undefined}
        />
        <div style={{ marginLeft: 4 }}>
          <Avatar name="User" size={28} />
        </div>
      </div>
    </header>
  );
}
