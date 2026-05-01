import React, { useMemo, useState } from 'react';
import { Icon, ToolBadge, SegmentedControl } from './primitives';
import type { SessionInfo } from '../services/api';
import { stripInjectedBanners } from '../utils/clean';

interface ConversationListProps {
  results: SessionInfo[];
  selected: string | null;
  onSelect: (id: string) => void;
  sort: string;
  setSort: (s: string) => void;
}

export default function ConversationList({ results, selected, onSelect, sort, setSort }: ConversationListProps) {
  // Search results carry a relevance `score`; recent listings don't.
  const isSearch = results.some((r) => (r as any).score !== undefined);

  // Effective sort value. When the user is browsing recent sessions, only
  // 'recent' is meaningful — 'rel' has no score to sort by, so fall back.
  const effectiveSort = !isSearch && sort === 'rel' ? 'recent' : sort;

  const sortedResults = useMemo(() => {
    if (effectiveSort === 'rel') {
      return [...results].sort(
        (a, b) => ((b as any).score ?? 0) - ((a as any).score ?? 0),
      );
    }
    // 'recent' (default): newest first.
    return [...results].sort(
      (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
    );
  }, [results, effectiveSort]);

  // For search-by-relevance, drop the date grouping — relevance order would
  // be invisible inside Today/Yesterday buckets. Show as a single flat list.
  const grouped =
    effectiveSort === 'rel'
      ? [{ label: 'By relevance', items: sortedResults }]
      : groupByDate(sortedResults);

  return (
    <section
      style={{
        flex: '0 0 var(--cr-convos-w)',
        borderRight: '1px solid var(--cr-line-1)',
        background: 'var(--cr-ink-0)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Subheader */}
      <div
        style={{
          height: 'var(--cr-subbar-h)',
          flexShrink: 0,
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--cr-line-1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600 }}>Conversations</h3>
          <span style={{ fontSize: 12, color: 'var(--cr-fg-3)', fontVariantNumeric: 'tabular-nums' }}>
            {results.length}
          </span>
        </div>
        {/* Relevance sort only meaningful with active search results. */}
        <SegmentedControl
          size="sm"
          options={
            isSearch
              ? [
                  { value: 'rel', label: 'Relevance' },
                  { value: 'recent', label: 'Recent' },
                ]
              : [{ value: 'recent', label: 'Recent' }]
          }
          value={effectiveSort}
          onChange={setSort}
        />
      </div>

      {/* Results list */}
      <div
        style={{ flex: 1, overflowY: 'auto' }}
        data-testid={isSearch ? 'search-results' : 'recent-sessions'}
      >
        {grouped.map((group) => (
          <React.Fragment key={group.label}>
            <div
              style={{
                padding: '14px 16px 6px',
                fontSize: 11,
                fontWeight: 500,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: 'var(--cr-fg-3)',
              }}
            >
              {group.label}
            </div>
            {group.items.map((r) => (
              <ResultRow key={r.sessionId} r={r} on={selected === r.sessionId} onClick={() => onSelect(r.sessionId)} />
            ))}
          </React.Fragment>
        ))}
        {results.length === 0 && (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--cr-fg-3)' }}>
            <Icon name="search" size={22} style={{ opacity: 0.4, marginBottom: 12 }} />
            <div style={{ fontSize: 13 }}>No matching conversations</div>
          </div>
        )}
      </div>
    </section>
  );
}

function ResultRow({ r, on, onClick }: { r: SessionInfo; on: boolean; onClick: () => void }) {
  const [hov, setHov] = useState(false);
  const timeStr = formatTime(r.modified);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      data-testid="session-item"
      data-session-id={r.sessionId}
      style={{
        padding: '12px 16px',
        cursor: 'pointer',
        position: 'relative',
        background: on ? 'var(--cr-ink-2)' : hov ? 'var(--cr-ink-1)' : 'transparent',
        transition: 'background var(--cr-dur-fast)',
      }}
    >
      {/* Selected indicator */}
      {on && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 14,
            bottom: 14,
            width: 2,
            borderRadius: '0 2px 2px 0',
            background: 'var(--cr-brand-500)',
          }}
        />
      )}

      {/* Top line: tool + project + time */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <ToolBadge tool={r.tool || 'claude'} size="sm" />
        <span
          style={{
            flex: 1,
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--cr-fg-2)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {formatPath(r.projectPath)}
        </span>
        <span style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>{timeStr}</span>
      </div>

      {/* Title */}
      <div
        style={{
          fontSize: 14,
          fontWeight: 500,
          color: 'var(--cr-fg-1)',
          marginBottom: 4,
          letterSpacing: '-0.005em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {r.summary ? getShortSummary(r.summary, 80) : stripInjectedBanners(r.firstPrompt || '').substring(0, 80) || r.sessionId.slice(0, 8)}
      </div>

      {/* Preview */}
      <div
        style={{
          fontSize: 13,
          color: 'var(--cr-fg-2)',
          lineHeight: 1.45,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          marginBottom: 8,
        }}
      >
        {stripInjectedBanners(r.firstPrompt || '').substring(0, 120)}
      </div>
    </div>
  );
}

function formatPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return path;
}

function getShortSummary(rawSummary: string, maxLength: number = 150): string {
  if (!rawSummary) return '';
  const summary = stripInjectedBanners(rawSummary);
  const requestMatch = summary.match(/\*\*Request:\*\*\s*-?\s*([^\n*]+)/i);
  if (requestMatch && requestMatch[1]) {
    const request = requestMatch[1].trim();
    return request.length <= maxLength ? request : request.substring(0, maxLength) + '...';
  }
  const firstLine = summary.split('\n')[0].replace(/^\*\*[^*]+\*\*:?\s*-?\s*/, '');
  return firstLine.length <= maxLength ? firstLine : firstLine.substring(0, maxLength) + '...';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function groupByDate(items: SessionInfo[]): Array<{ label: string; items: SessionInfo[] }> {
  const groups: Record<string, SessionInfo[]> = {};
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  for (const item of items) {
    const d = new Date(item.modified);
    let label: string;
    if (d >= today) {
      label = 'Today';
    } else if (d >= yesterday) {
      label = 'Yesterday';
    } else if (d >= weekAgo) {
      label = 'This week';
    } else if (d.getFullYear() === today.getFullYear()) {
      label = d.toLocaleDateString(undefined, { month: 'long' });
    } else {
      label = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    }
    if (!groups[label]) groups[label] = [];
    groups[label].push(item);
  }

  const order = ['Today', 'Yesterday', 'This week'];
  const result: Array<{ label: string; items: SessionInfo[] }> = [];
  for (const key of order) {
    if (groups[key]) {
      result.push({ label: key, items: groups[key] });
      delete groups[key];
    }
  }
  const remaining = Object.keys(groups).sort((a, b) => {
    const da = new Date(groups[a][0].modified);
    const db = new Date(groups[b][0].modified);
    return db.getTime() - da.getTime();
  });
  for (const key of remaining) {
    result.push({ label: key, items: groups[key] });
  }
  return result;
}
