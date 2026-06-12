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
  const groupedRaw =
    effectiveSort === 'rel'
      ? [{ label: 'By relevance', items: sortedResults }]
      : groupByDate(sortedResults);

  // Collapse adjacent template-runs. A PR-bot pushes the same first
  // prompt against the same project many times in rapid succession;
  // showing 150 identical-looking rows is noise. Adjacent rows with
  // (same project, same first 80 chars of first-prompt, within the
  // same date group) collapse into one representative row that
  // displays a "(N runs)" badge.
  const grouped = useMemo(() => groupedRaw.map(g => ({
    label: g.label,
    items: collapseAdjacentRuns(g.items),
  })), [groupedRaw]);

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

// Source-type badge color/label. `session` rows fall back to the tool color
// rail and don't need a separate badge — only non-session memory hits show one.
const SOURCE_BADGE: Record<string, { label: string; bg: string; fg: string; line: string }> = {
  paste:     { label: 'PASTE',     bg: 'var(--cr-warn-surf)', fg: 'var(--cr-warn-500)', line: 'var(--cr-warn-line)' },
  plan:      { label: 'PLAN',      bg: 'var(--cr-ok-surf)',   fg: 'var(--cr-ok-500)',   line: 'var(--cr-ok-line)' },
  task:      { label: 'TASK',      bg: 'var(--cr-ink-2)',     fg: 'var(--cr-fg-2)',     line: 'var(--cr-line-1)' },
  claude_md: { label: 'CLAUDE.md', bg: 'var(--cr-ink-2)',     fg: 'var(--cr-fg-1)',     line: 'var(--cr-line-2)' },
  history:   { label: 'HISTORY',   bg: 'var(--cr-ink-2)',     fg: 'var(--cr-fg-3)',     line: 'var(--cr-line-1)' },
  diary:     { label: 'DIARY',     bg: 'var(--cr-ok-surf)',   fg: 'var(--cr-ok-500)',   line: 'var(--cr-ok-line)' },
};

function ResultRow({ r, on, onClick, index }: { r: SessionInfo; on: boolean; onClick: () => void; index: number }) {
  const tool = r.tool || 'claude';
  const toolColor = TOOL_COLOR[tool] || 'var(--cr-line-2)';
  const timeStr = formatTime(r.modified);
  const path = formatPath(r.projectPath);

  const hasSummary = !!r.summary;
  const hasSummaryError = !hasSummary && !!r.summaryError;
  const rawFirstPrompt = stripInjectedBanners(r.firstPrompt || '').trim();
  const titleText = hasSummary
    ? getShortSummary(r.summary!, 200)
    : rawFirstPrompt.slice(0, 220);

  // Search-only: render every matched chunk (up to a small cap), each
  // windowed around the first query-term hit and with the query terms
  // highlighted. The user sees WHERE the term appears, not just one snippet.
  const isSearchHit = r.score !== undefined && !!r.matchedChunks?.length;
  const matchSnippets = isSearchHit
    ? r.matchedChunks!.slice(0, 3).map((c) => buildMatchSnippet([c], r.query)).filter(Boolean)
    : [];
  const matchChunksMeta = isSearchHit ? r.matchedChunks!.slice(0, 3) : [];
  const extraMatchCount = isSearchHit
    ? Math.max(0, (r.matchedChunks!.length) - matchSnippets.length)
    : 0;

  const sourceType = r.sourceType || 'session';
  const sourceBadge = sourceType !== 'session' ? SOURCE_BADGE[sourceType] : null;

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
        {/* Meta line: SOURCE/TOOL · path · time */}
        <div className="cr-conv-meta">
          {sourceBadge ? (
            <span
              title={`Memory source: ${sourceType}`}
              data-testid="source-badge"
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.06em',
                color: sourceBadge.fg,
                background: sourceBadge.bg,
                border: `1px solid ${sourceBadge.line}`,
                padding: '1px 5px',
                borderRadius: 3,
                textTransform: 'uppercase',
              }}
            >
              {sourceBadge.label}
            </span>
          ) : (
            <span className="cr-conv-meta-tool">{TOOL_LABEL[tool] || tool}</span>
          )}
          <span style={{ color: 'var(--cr-line-3)', flexShrink: 0 }}>·</span>
          <span className="cr-conv-meta-path" title={r.projectPath}>{path}</span>
          <span className="cr-conv-meta-time">{timeStr}</span>
          {/*
            Collapsed-run badge. When ≥2 adjacent sessions in the same
            project share a templated first prompt within 24h
            (PR-bot pattern), they fold into one feed row. The badge
            shows the run size so the user knows the work happened
            multiple times. Clicking the row still opens the head
            session — the rest are reachable via search by project.
          */}
          {r.runCount && r.runCount > 1 && (
            <span
              title={`${r.runCount} sessions with the same first prompt collapsed into one row (e.g. PR-bot iterations).`}
              data-testid="run-count-badge"
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--cr-fg-2)',
                background: 'var(--cr-ink-2)',
                border: '1px solid var(--cr-line-1)',
                padding: '1px 6px',
                borderRadius: 3,
                marginLeft: 4,
                letterSpacing: '0.02em',
              }}
            >
              ×{r.runCount} runs
            </span>
          )}
          {r.oneShot && (
            <span
              title="Single-prompt invocation — likely a batch/bot run, not an interactive conversation."
              data-testid="one-shot-badge"
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--cr-fg-3)',
                background: 'var(--cr-ink-2)',
                border: '1px dashed var(--cr-line-1)',
                padding: '1px 6px',
                borderRadius: 3,
                marginLeft: 4,
                letterSpacing: '0.02em',
              }}
            >
              one-shot
            </span>
          )}
        </div>

        {/* Search-only: relevance score chip after time */}
        {isSearchHit && (
          <div className="cr-conv-meta" style={{ marginTop: 0 }}>
            <span
              title="Relevance score for this query (higher = stronger match)"
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.04em',
                color: 'var(--cr-ok-500)',
                background: 'var(--cr-ok-surf)',
                border: '1px solid var(--cr-ok-line)',
                padding: '1px 5px',
                borderRadius: 3,
              }}
            >
              {scoreLabel(r.score!)}
            </span>
            <span style={{ color: 'var(--cr-line-3)', flexShrink: 0 }}>·</span>
            <span style={{ color: 'var(--cr-fg-3)', fontSize: 11 }}>
              {r.matchedChunks!.length} match{r.matchedChunks!.length === 1 ? '' : 'es'}
            </span>
          </div>
        )}

        {/* Title line: status prefix + title body */}
        <div className="cr-conv-title">
          <SessionStatusPrefix sessionId={r.sessionId} tool={tool} />

          {hasSummaryError ? (
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
          ) : null}

          {titleText ? (
            <span
              className={hasSummary ? undefined : 'cr-conv-title-faded'}
              title={hasSummary ? 'AI-generated summary' : 'Raw first prompt'}
            >
              {titleText}
            </span>
          ) : (
            <span style={{ color: 'var(--cr-fg-3)', fontStyle: 'italic', fontSize: 13 }}>
              (no preview captured for this session)
            </span>
          )}

          {/* Quiet source badge: whether this is summary or raw */}
          {titleText && (
            <span style={{
              marginLeft: 10,
              fontSize: 10,
              fontWeight: 500,
              color: hasSummary ? 'var(--cr-ok-500)' : 'var(--cr-fg-3)',
              background: hasSummary ? 'var(--cr-ok-surf)' : 'var(--cr-ink-2)',
              border: `1px solid ${hasSummary ? 'var(--cr-ok-line)' : 'var(--cr-line-1)'}`,
              padding: '1px 5px',
              borderRadius: 3,
              whiteSpace: 'nowrap',
              verticalAlign: '2px',
              letterSpacing: 0,
            }}>
              {hasSummary ? 'AI summary' : 'raw prompt'}
            </span>
          )}
        </div>

        {/* Search-only: stack of matched snippets, each with the query term
            highlighted. Click on a snippet propagates to the row's onClick so
            the viewer opens at the matched session. */}
        {matchSnippets.length > 0 && (
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="search-snippets">
            {matchSnippets.map((snip, idx) => (
              <div
                key={idx}
                className="cr-conv-snippet"
                data-testid="search-snippet"
                title={`Matched chunk · ${matchChunksMeta[idx]?.chunkType || ''}`}
                style={{
                  padding: '6px 8px',
                  borderLeft: '2px solid var(--cr-accent-500, #6cf)',
                  background: 'var(--cr-ink-2)',
                  color: 'var(--cr-fg-2)',
                  fontSize: 12,
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 96,
                  overflow: 'hidden',
                  fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)',
                }}
              >
                <div style={{
                  fontSize: 10,
                  color: 'var(--cr-fg-3)',
                  marginBottom: 3,
                  fontFamily: 'inherit',
                  letterSpacing: '0.04em',
                }}>
                  {matchChunksMeta[idx]?.chunkType} · {scoreLabel(matchChunksMeta[idx]?.score ?? 0)}
                </div>
                {snip!.parts.map((p, i) =>
                  p.hit ? (
                    <mark
                      key={i}
                      style={{
                        background: 'var(--cr-warn-surf, #553)',
                        color: 'var(--cr-warn-500, #fc6)',
                        padding: '0 2px',
                        borderRadius: 2,
                      }}
                    >
                      {p.text}
                    </mark>
                  ) : (
                    <span key={i}>{p.text}</span>
                  ),
                )}
              </div>
            ))}
            {extraMatchCount > 0 && (
              <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', paddingLeft: 8 }}>
                + {extraMatchCount} more match{extraMatchCount === 1 ? '' : 'es'} in this item
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right column: marker chips */}
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

// Search-only helpers ----------------------------------------------------

function scoreLabel(score: number): string {
  // FTS5 / vector scores live in vastly different ranges, so we just give the
  // user a magnitude they can compare across the result list rather than a
  // raw float that looks like noise (e.g. 0.0032).
  if (score >= 1) return `score ${score.toFixed(2)}`;
  if (score >= 0.01) return `score ${(score * 100).toFixed(1)}`;
  return `score ${(score * 1000).toFixed(2)}‰`;
}

function buildMatchSnippet(
  chunks: Array<{ chunkType: string; text: string; score: number }>,
  query?: string,
): { parts: Array<{ text: string; hit: boolean }> } | null {
  if (!chunks.length) return null;
  const best = chunks[0];
  const text = best.text.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const terms = (query || '')
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((t) => t.length >= 2);

  const WINDOW = 220;
  let window = text.slice(0, WINDOW);
  if (terms.length) {
    const lower = text.toLowerCase();
    let firstHit = -1;
    for (const t of terms) {
      const i = lower.indexOf(t.toLowerCase());
      if (i !== -1 && (firstHit === -1 || i < firstHit)) firstHit = i;
    }
    if (firstHit !== -1) {
      const start = Math.max(0, firstHit - 60);
      const end = Math.min(text.length, start + WINDOW);
      window = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
    } else if (text.length > WINDOW) {
      window = text.slice(0, WINDOW) + '…';
    }
  } else if (text.length > WINDOW) {
    window = text.slice(0, WINDOW) + '…';
  }

  if (!terms.length) return { parts: [{ text: window, hit: false }] };

  // Highlight every occurrence of any term (case-insensitive).
  const escaped = terms
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts: Array<{ text: string; hit: boolean }> = [];
  let last = 0;
  for (const m of window.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) parts.push({ text: window.slice(last, i), hit: false });
    parts.push({ text: m[0], hit: true });
    last = i + m[0].length;
  }
  if (last < window.length) parts.push({ text: window.slice(last), hit: false });
  return { parts };
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

/**
 * Collapse adjacent rows that look like repeated runs of the same template.
 *
 * Use case: PR-bot worktree sessions — your bot fires N=10-150 Claude
 * sessions per PR with an identical first prompt
 * ("User requested: You are addressing review comments on …#393…").
 * Each is a real distinct conversation but listing them all clogs the
 * feed.
 *
 * Heuristic: two adjacent rows collapse when
 *   - same projectPath
 *   - same first 80 chars of the cleaned first-prompt (so the bot's
 *     templated opener counts; user-edited follow-ups don't collapse)
 *   - mtime within 24h of the head of the run
 *
 * The first member of the run is returned with `runCount` set to the
 * group size and `runMemberIds` carrying every member's sessionId so
 * an "Expand N runs" affordance can later list them. Subsequent
 * members are dropped from the list.
 */
function collapseAdjacentRuns(items: SessionInfo[]): SessionInfo[] {
  if (items.length < 2) return items;

  // Group every row in this date bucket by (project, templated-prompt).
  // We don't require adjacency — within "Today" all PR-bot iterations
  // for a single PR collapse to one row regardless of how interleaved
  // other work was. The keeper is the most recent member (first in the
  // sorted list) so the feed still shows the latest activity timestamp.
  const sigOf = (s: SessionInfo): string => {
    const prompt = (s.firstPrompt || s.summary || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    // Empty-prompt sessions DO collapse — they're the most common
    // PR-bot pattern (templated initial prompt swallowed by Claude's
    // banner stripping). Collapsing by projectPath alone is the right
    // call here; it's exactly what the user wants for those rows.
    return `${s.projectPath}::${prompt}`;
  };

  const groups = new Map<string, SessionInfo[]>();
  const order: string[] = []; // remember first-seen order so collapsed rows keep their position
  for (const item of items) {
    const sig = sigOf(item);
    if (!groups.has(sig)) {
      groups.set(sig, []);
      order.push(sig);
    }
    groups.get(sig)!.push(item);
  }

  const out: SessionInfo[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    if (group.length === 1) {
      out.push(group[0]);
    } else {
      const memberIds = group.map(g => g.sessionId);
      out.push({ ...group[0], runCount: group.length, runMemberIds: memberIds });
    }
  }
  return out;
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
