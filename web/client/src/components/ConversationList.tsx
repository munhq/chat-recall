import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, Chip, SegmentedControl } from './primitives';
import type { SessionInfo, SessionMarkersResponse, SessionOutcomeBadgeResponse } from '../services/api';
import { getSessionMarkers, getSessionOutcomeBadge } from '../services/api';
import { stripInjectedBanners } from '../utils/clean';

/**
 * Conversation list — editorial-archive treatment.
 *
 * Per-row visual hierarchy (top → bottom, left → right):
 *
 *   ┌──┬──────────────────────────────────────────────────────────┐
 *   │  │ CLAUDE · personal/munbot              ·          5m ago │  ← meta
 *   │  │ ● in_progress · please use chat recall and see what we │  ← status + title
 *   │  │   have done yesterday and how did we improve munbot…   │
 *   │  │                                                  ⚠ 2  │  ← markers (rare)
 *   └──┴──────────────────────────────────────────────────────────┘
 *     ↑ tool color rail (3px, 4px when selected, brand color when selected)
 *
 * Why this layout:
 *   - Rail replaces tool chip → no horizontal competition with project path.
 *   - Status as inline dot+word prefix → no chip clutter; the dot pulses
 *     for in_progress to draw the eye to active sessions.
 *   - First prompt or summary is the dominant typographic element.
 *   - Path + time as quiet monospace caption — searchable with the eye
 *     but never fighting for attention.
 *   - Marker chips collapse to a tiny right column ONLY when present.
 */
interface ConversationListProps {
  results: SessionInfo[];
  selected: string | null;
  onSelect: (id: string) => void;
  sort: string;
  setSort: (s: string) => void;
  /** Pagination — when these are set, the list shows a sticky footer with
   *  progress and a "load more" trigger that fires `onLoadMore` either
   *  on scroll-near-bottom or click. Omit for the search-results case
   *  where the server returns one batch. */
  hasMore?: boolean;
  loadingMore?: boolean;
  total?: number;
  onLoadMore?: () => void | Promise<void>;
  /** Optional: pass true while the initial page is loading so we can
   *  render shimmer skeletons instead of an empty list. */
  loading?: boolean;
}

export default function ConversationList({
  results,
  selected,
  onSelect,
  sort,
  setSort,
  hasMore,
  loadingMore,
  total,
  onLoadMore,
  loading,
}: ConversationListProps) {
  // Search results carry a relevance `score`; recent listings don't.
  const isSearch = results.some((r) => (r as any).score !== undefined);
  const effectiveSort = !isSearch && sort === 'rel' ? 'recent' : sort;

  const sortedResults = useMemo(() => {
    if (effectiveSort === 'rel') {
      return [...results].sort(
        (a, b) => ((b as any).score ?? 0) - ((a as any).score ?? 0),
      );
    }
    return [...results].sort(
      (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
    );
  }, [results, effectiveSort]);

  // Group by date for browsing; flat list for relevance ordering.
  const grouped =
    effectiveSort === 'rel'
      ? [{ label: 'By relevance', items: sortedResults }]
      : groupByDate(sortedResults);

  return (
    <section
      className="cr-conv-list"
      style={{
        flex: '0 0 var(--cr-convos-w)',
        borderRight: '1px solid var(--cr-line-1)',
        background: 'var(--cr-ink-0)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Subheader — title + sort */}
      <div
        className="cr-subbar"
        style={{
          height: 'var(--cr-subbar-h)',
          flexShrink: 0,
          padding: '0 18px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--cr-line-1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            {isSearch ? 'Results' : 'Conversations'}
          </h3>
          <span
            style={{
              fontFamily: 'var(--cr-font-mono)',
              fontSize: 11,
              color: 'var(--cr-fg-3)',
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: 0,
            }}
          >
            {results.length}
            {total != null && total !== results.length ? ` / ${total}` : ''}
          </span>
        </div>
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

      {/* Scrollable list */}
      <div
        style={{ flex: 1, overflowY: 'auto', position: 'relative' }}
        data-testid={isSearch ? 'search-results' : 'recent-sessions'}
      >
        {/* Loading skeletons — shown when the first page is in flight and
            we have no rows yet. Once any rows arrive, they replace the
            skeletons entirely so we don't double-show. */}
        {loading && results.length === 0 && <SkeletonRows count={6} />}

        {!loading && results.length === 0 && (
          <div
            style={{
              padding: '64px 24px',
              textAlign: 'center',
              color: 'var(--cr-fg-3)',
            }}
          >
            <Icon name="search" size={22} style={{ opacity: 0.4, marginBottom: 14 }} />
            <div style={{ fontSize: 13, marginBottom: 4 }}>No matching conversations</div>
            <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', opacity: 0.7 }}>
              Try a different filter or search term
            </div>
          </div>
        )}

        {grouped.map((group, gi) => (
          <React.Fragment key={group.label}>
            <DateDivider label={group.label} first={gi === 0} />
            {group.items.map((r, i) => (
              <ResultRow
                key={r.sessionId}
                r={r}
                on={selected === r.sessionId}
                onClick={() => onSelect(r.sessionId)}
                /* Stagger only the first ~12 rows so a re-sort or filter
                   change isn't a long animation queue. */
                index={i < 12 ? i : 0}
              />
            ))}
          </React.Fragment>
        ))}

        {/* Pagination sentinel — fires onLoadMore when scrolled near the
            bottom. Invisible when collapsed; the footer below is the
            visible UI. */}
        {onLoadMore && hasMore !== undefined && results.length > 0 && (
          <LoadMoreSentinel
            hasMore={!!hasMore}
            loading={!!loadingMore}
            onLoadMore={onLoadMore}
          />
        )}
      </div>

      {/* Sticky footer — always-visible pagination state. Replaces the
          previous invisible 1px sentinel-as-only-feedback. */}
      {onLoadMore && hasMore !== undefined && (
        <PaginationFooter
          loaded={results.length}
          total={total}
          hasMore={!!hasMore}
          loading={!!loadingMore}
          onLoadMore={onLoadMore}
        />
      )}
    </section>
  );
}

/* ────────────────────────────── Result row ────────────────────────────── */

const TOOL_COLOR: Record<string, string> = {
  claude: 'var(--cr-tool-claude)',
  codex: 'var(--cr-tool-codex)',
  gemini: 'var(--cr-tool-gemini)',
  opencode: 'var(--cr-tool-opencode)',
};
const TOOL_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
};

function ResultRow({ r, on, onClick, index }: { r: SessionInfo; on: boolean; onClick: () => void; index: number }) {
  const tool = r.tool || 'claude';
  const toolColor = TOOL_COLOR[tool] || 'var(--cr-line-2)';
  const timeStr = formatTime(r.modified);
  const path = formatPath(r.projectPath);

  // Three states:
  //   1. summary present  → use it (curated title)
  //   2. summary failed   → show "summary unavailable" caption + first
  //                         prompt below, with the error in a tooltip
  //   3. summary pending  → faint italic first prompt + small "↻ pending"
  //                         marker so the user knows one is coming
  const hasSummary = !!r.summary;
  const hasSummaryError = !hasSummary && !!r.summaryError;
  const rawFirstPrompt = stripInjectedBanners(r.firstPrompt || '').trim();
  const titleText = hasSummary
    ? getShortSummary(r.summary!, 200)
    : rawFirstPrompt.slice(0, 220);

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      aria-current={on}
      data-testid="session-item"
      data-session-id={r.sessionId}
      className="cr-conv-row"
      style={
        {
          '--cr-row-tool': toolColor,
          '--cr-row-i': index,
        } as React.CSSProperties
      }
    >
      {/* Tool color rail */}
      <span className="cr-conv-rail" aria-hidden />

      {/* Content column */}
      <div style={{ minWidth: 0 }}>
        {/* Meta line: TOOL · path · time */}
        <div className="cr-conv-meta">
          <span className="cr-conv-meta-tool">{TOOL_LABEL[tool] || tool}</span>
          <span style={{ color: 'var(--cr-line-3)', flexShrink: 0 }}>·</span>
          <span className="cr-conv-meta-path" title={r.projectPath}>{path}</span>
          <span className="cr-conv-meta-time">{timeStr}</span>
        </div>

        {/* Title line: status prefix + title body.
            Body branches by summary state:
              - summary present  → render the summary in normal weight
              - summary failed   → "summary unavailable" caption followed
                                   by the raw first prompt; full error in
                                   tooltip
              - summary pending  → faded italic first prompt; the row will
                                   re-render once the worker finishes */}
        <div className="cr-conv-title">
          <SessionStatusPrefix sessionId={r.sessionId} tool={tool} />
          {hasSummaryError && (
            <span
              title={`${r.summaryError!.error}\n\n${r.summaryError!.attemptCount} attempt(s). Check Settings → Summary provider.`}
              data-testid="summary-unavailable"
              style={{
                display: 'inline-block',
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--cr-warn-500)',
                background: 'var(--cr-warn-surf)',
                border: '1px solid var(--cr-warn-line)',
                padding: '1px 6px',
                borderRadius: 3,
                marginRight: 8,
                verticalAlign: '1px',
                cursor: 'help',
                letterSpacing: 0,
              }}
            >
              summary unavailable · check settings
            </span>
          )}
          {titleText ? (
            <span className={hasSummary ? undefined : 'cr-conv-title-faded'}>{titleText}</span>
          ) : (
            <span style={{ color: 'var(--cr-fg-3)', fontStyle: 'italic', fontSize: 13 }}>
              (no preview captured for this session)
            </span>
          )}
        </div>
      </div>

      {/* Right column: marker chips. Empty when no markers — the column
          collapses (grid auto) and the row stays clean. */}
      <div className="cr-conv-markers">
        <SessionMarkerStrip sessionId={r.sessionId} tool={tool} />
      </div>
    </div>
  );
}

/* ────────────────────────────── Status prefix ────────────────────────────── */

const STATUS_COLOR: Record<string, string> = {
  shipped: 'var(--cr-ok-500)',
  in_progress: 'var(--cr-info-500)',
  interrupted: 'var(--cr-warn-500)',
  abandoned: 'var(--cr-err-500)',
  completed: 'var(--cr-fg-3)',
  unknown: 'var(--cr-fg-3)',
};
const STATUS_LABEL: Record<string, string> = {
  shipped: 'shipped',
  in_progress: 'in progress',
  interrupted: 'interrupted',
  abandoned: 'abandoned',
  completed: 'done',
  unknown: '',
};

/**
 * Inline status prefix: pulsing colored dot + status word + middot
 * separator. Sits in front of the title so it scans as a typographic
 * prefix rather than a competing chip.
 *
 * Lazy-loaded via IntersectionObserver so a list of 200 sessions doesn't
 * trigger 200 outcome-badge fetches up front. Renders nothing while the
 * status is unknown — the title slides left to fill the space.
 */
function SessionStatusPrefix({ sessionId, tool: _tool }: { sessionId: string; tool: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [data, setData] = useState<SessionOutcomeBadgeResponse | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setSeen(true);
            obs.disconnect();
          }
        }
      },
      { rootMargin: '160px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!seen || data) return;
    let cancelled = false;
    getSessionOutcomeBadge(sessionId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        /* benign — status hidden on failure */
      });
    return () => {
      cancelled = true;
    };
  }, [seen, sessionId, data]);

  if (!data || data.label === 'unknown' || !STATUS_LABEL[data.label]) {
    // Anchor for IntersectionObserver — must stay in DOM even when there's
    // nothing to show, so the observer fires.
    return <span ref={ref} aria-hidden />;
  }

  const label = STATUS_LABEL[data.label];
  const color = STATUS_COLOR[data.label] || 'var(--cr-fg-3)';

  return (
    <span
      ref={ref}
      className="cr-conv-status"
      data-status={data.label}
      data-testid="outcome-badge"
      data-outcome={data.label}
      title={data.tooltip}
      style={{ ['--cr-row-status' as string]: color } as React.CSSProperties}
    >
      <span className="cr-conv-status-dot" />
      {label}
      <span style={{ color: 'var(--cr-line-3)', marginLeft: 2 }}>·</span>
    </span>
  );
}

/* ────────────────────────────── Marker strip ────────────────────────────── */

/**
 * Right-aligned marker strip — only renders when sentiment markers have
 * actual signal (frustrated, interrupt, correction). A purely-positive
 * session shows nothing here, keeping the right column clean for the
 * sessions that warrant attention.
 *
 * Markers come from Claude transcripts only today; non-Claude tools
 * render nothing (no fetch fires).
 */
function SessionMarkerStrip({ sessionId, tool }: { sessionId: string; tool: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [data, setData] = useState<SessionMarkersResponse | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (tool !== 'claude') return;
    if (!ref.current) return;
    const el = ref.current;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setSeen(true);
            obs.disconnect();
          }
        }
      },
      { rootMargin: '160px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [tool]);

  useEffect(() => {
    if (!seen || data || tool !== 'claude') return;
    let cancelled = false;
    getSessionMarkers(sessionId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        /* benign */
      });
    return () => {
      cancelled = true;
    };
  }, [seen, sessionId, tool, data]);

  if (tool !== 'claude') return <span ref={ref} aria-hidden />;
  const summary = data?.summary;
  if (!summary) return <span ref={ref} aria-hidden />;

  const chips: Array<{ kind: Parameters<typeof Chip>[0]['kind']; text: string; title: string }> = [];
  if (summary.frustrated > 0) chips.push({ kind: 'err', text: `⚠ ${summary.frustrated}`, title: `${summary.frustrated} frustrated prompt(s)` });
  if (summary.interrupt > 0) chips.push({ kind: 'warn', text: `⏸ ${summary.interrupt}`, title: `${summary.interrupt} interrupt(s)` });
  if (summary.correction > 0 && chips.length < 2)
    chips.push({ kind: 'warn', text: `↩ ${summary.correction}`, title: `${summary.correction} correction(s)` });

  if (chips.length === 0) return <span ref={ref} aria-hidden />;

  return (
    <span ref={ref} style={{ display: 'inline-flex', gap: 4 }}>
      {chips.slice(0, 2).map((c, i) => (
        <Chip key={i} kind={c.kind} size="sm" style={{ height: 18, fontSize: 10 }}>
          <span title={c.title}>{c.text}</span>
        </Chip>
      ))}
    </span>
  );
}

/* ────────────────────────────── Date divider ────────────────────────────── */

function DateDivider({ label, first }: { label: string; first: boolean }) {
  return (
    <div className="cr-conv-divider" style={first ? undefined : { paddingTop: 28 }}>
      <span aria-hidden />
      <span>· {label} ·</span>
      <span aria-hidden />
    </div>
  );
}

/* ────────────────────────────── Skeleton loader ────────────────────────────── */

function SkeletonRows({ count }: { count: number }) {
  /* Vary bar widths per row so the placeholder doesn't read as a wall of
   * identical bars. The widths cycle to give the eye texture even when
   * many rows render at once. */
  const widths = [
    [70, 92, 60],
    [55, 80, 75],
    [85, 70, 50],
    [60, 88, 65],
    [75, 60, 80],
    [50, 95, 70],
  ];
  return (
    <>
      {Array.from({ length: count }).map((_, i) => {
        const w = widths[i % widths.length];
        return (
          <div key={i} className="cr-conv-skeleton" data-testid="conversation-list-skeleton">
            <span className="cr-conv-skeleton-rail" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <div className="cr-conv-skeleton-bar" style={{ width: 40, height: 8 }} />
                <div className="cr-conv-skeleton-bar" style={{ flex: 1, maxWidth: `${w[0]}%`, height: 8 }} />
              </div>
              <div className="cr-conv-skeleton-bar" style={{ width: `${w[1]}%`, height: 12 }} />
              <div className="cr-conv-skeleton-bar" style={{ width: `${w[2]}%`, height: 12 }} />
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ────────────────────────────── Pagination ────────────────────────────── */

function LoadMoreSentinel({
  hasMore,
  loading,
  onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void | Promise<void>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasMore || loading) return;
    if (!ref.current) return;
    const el = ref.current;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            obs.disconnect();
            void onLoadMore();
            break;
          }
        }
      },
      { rootMargin: '480px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loading, onLoadMore]);

  return (
    <div
      ref={ref}
      data-testid="conversation-list-load-more-sentinel"
      style={{ height: 1 }}
      aria-hidden
    />
  );
}

function PaginationFooter({
  loaded,
  total,
  hasMore,
  loading,
  onLoadMore,
}: {
  loaded: number;
  total?: number;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void | Promise<void>;
}) {
  const pct = total && total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 100;
  const label =
    loading
      ? 'loading…'
      : hasMore
        ? `${loaded}${total != null ? ` / ${total}` : ''}`
        : total != null
          ? `${loaded} / ${total} · end`
          : `${loaded} · end`;

  return (
    <div className="cr-conv-footer" data-testid="conversation-list-footer">
      <span style={{ flexShrink: 0 }}>{label}</span>
      <span className="cr-conv-footer-progress" aria-hidden>
        <span className="cr-conv-footer-progress-fill" style={{ width: `${pct}%` }} />
      </span>
      <button
        type="button"
        className="cr-conv-footer-action"
        disabled={!hasMore || loading}
        onClick={() => {
          if (!loading && hasMore) void onLoadMore();
        }}
        data-testid="conversation-list-load-more-button"
      >
        {hasMore ? 'load more →' : ''}
      </button>
    </div>
  );
}

/* ────────────────────────────── Helpers ────────────────────────────── */

function formatPath(path: string): string {
  if (!path) return '~';
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return parts[0] || path;
}

function getShortSummary(rawSummary: string, maxLength: number = 200): string {
  if (!rawSummary) return '';
  const summary = stripInjectedBanners(rawSummary);
  const requestMatch = summary.match(/\*\*Request:\*\*\s*-?\s*([^\n*]+)/i);
  if (requestMatch && requestMatch[1]) {
    const request = requestMatch[1].trim();
    return request.length <= maxLength ? request : request.substring(0, maxLength) + '…';
  }
  const firstLine = summary.split('\n')[0].replace(/^\*\*[^*]+\*\*:?\s*-?\s*/, '');
  return firstLine.length <= maxLength ? firstLine : firstLine.substring(0, maxLength) + '…';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
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
