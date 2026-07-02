import React, { useState, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Icon, Button, Input, SourceBadge, ToolBadge, Card, Chip, pressableProps } from './primitives';
import { useSidebarExtrasRegister } from '../context/sidebar-extras';
import type {
  SourceType,
  MemoryMetadataRow,
  MemoryLinkRow,
  MemorySearchResult,
  MemoryStatus,
} from '../services/api';
import {
  searchMemory,
  getMemoryStatus,
  getMemoryItem,
  getMemoryLinks,
  browseMemory,
  reindexMemory,
  getMemoryItemContent,
} from '../services/api';

// Sessions live under the Conversations tab — Memory is for non-session memory
// primitives. Skills / MCPs / Agents are config-y and live under the new
// Toolkit tab, not here.
const SOURCE_TABS: Array<{ id: SourceType | 'all'; label: string }> = [
  { id: 'all', label: 'Everything' },
  { id: 'plan', label: 'Plans' },
  // CLAUDE.md / GEMINI.md / AGENTS.md all live in this source type. The label
  // used to read "CLAUDE.md" but that misrepresented what's indexed.
  { id: 'claude_md', label: 'Notes' },
  { id: 'task', label: 'Tasks' },
  { id: 'paste', label: 'Pastebin' },
  { id: 'history', label: 'History' },
  { id: 'diary', label: 'Diary' },
];

/** Source-types whose rows carry a meaningful per-tool tag (extra.tool). */
const TOOL_FILTERABLE: ReadonlySet<SourceType | 'all'> = new Set(['plan', 'claude_md', 'task']);

/** Properly pluralize a source-type for the search placeholder. */
function pluralizeSource(t: SourceType | 'all'): string {
  switch (t) {
    case 'session':   return 'sessions';
    case 'plan':      return 'plans';
    case 'task':      return 'tasks';
    case 'claude_md': return 'CLAUDE.md files';
    case 'paste':     return 'pastes';
    case 'history':   return 'history';
    case 'diary':     return 'diary entries';
    default:          return 'everything';
  }
}

interface MemoryExplorerProps {
  onSessionClick?: (sessionId: string) => void;
  /** Source filter from the global Sidebar. */
  toolFilter?: string;
  /** Project filter from the global Sidebar. */
  projectFilter?: string | null;
}

type SessionToolFilter = 'all' | 'claude' | 'gemini' | 'opencode' | 'codex';

/**
 * Read the per-row tool tag. Defaults to 'claude' for sessions and
 * notes-style rows that pre-date the multi-tool indexer (their extra_json
 * has no `tool` field). Returns '' for source types that aren't
 * tool-tagged at all.
 */
function readItemTool(item: { source_type: string; extra_json?: string }): string {
  if (!TOOL_FILTERABLE.has(item.source_type as any)) return '';
  try {
    const t = JSON.parse(item.extra_json || '{}').tool;
    if (t) return t;
  } catch { /* fall through */ }
  return 'claude';
}

export default function MemoryExplorer({ onSessionClick, toolFilter = 'all', projectFilter = null }: MemoryExplorerProps) {
  const [activeType, setActiveType] = useState<SourceType | 'all'>('plan');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MemoryMetadataRow[]>([]);
  const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [reindexing, setReindexing] = useState<Set<string>>(new Set());
  // Sidebar-driven filter is the source of truth — local sessionTool state
  // is gone; everything reads `toolFilter` from props.
  const sessionTool = (toolFilter || 'all') as SessionToolFilter;
  // Reserved for a future per-view project drilldown — kept on the prop
  // surface so the layout above keeps its shape.
  void projectFilter;

  useEffect(() => {
    getMemoryStatus().then(setStatus).catch(console.error);
  }, []);

  useEffect(() => {
    if (activeType !== 'all' && query === '') {
      setLoading(true);
      // Tool-filterable sources span up to 3 AI tools — pull a wider page so
      // the per-tool filter has enough rows on initial load. Tabs that aren't
      // tool-filterable (paste/history/diary) keep the small default limit.
      const limit = TOOL_FILTERABLE.has(activeType) ? 1000 : 50;
      browseMemory(activeType, limit)
        .then(setItems)
        .finally(() => setLoading(false));
    } else {
      setItems([]);
    }
  }, [activeType, query]);

  const handleSearch = () => {
    if (!query.trim()) return;
    setLoading(true);
    searchMemory(query, 30, activeType === 'all' ? undefined : [activeType as SourceType])
      .then(setSearchResults)
      .finally(() => setLoading(false));
  };

  const handleReindex = (type: SourceType) => {
    setReindexing((s) => new Set(s).add(type));
    reindexMemory([type])
      .then(() => {
        getMemoryStatus().then(setStatus);
        if (activeType === type) {
          browseMemory(type).then(setItems);
        }
      })
      .finally(() => {
        setReindexing((s) => {
          const next = new Set(s);
          next.delete(type);
          return next;
        });
      });
  };

  /**
   * Tool-aware count for a source-type tab. When the user has selected a
   * specific tool, we want the count to reflect only that tool's rows so
   * the chip doesn't lie ("Pastebin (727)" while filtered to Gemini = 0).
   */
  const getTypeCount = (type: string, tool: SessionToolFilter) => {
    if (!status) return 0;
    if (type === 'all') {
      if (tool === 'all') return status.totalItems;
      // Sum across all source types for the selected tool.
      let n = 0;
      const map = status.bySourceAndTool || {};
      for (const t of Object.keys(map)) n += map[t][tool] || 0;
      return n;
    }
    if (tool === 'all') return status.bySourceType[type]?.items || 0;
    return status.bySourceAndTool?.[type]?.[tool] || 0;
  };

  /** Tabs visible for the currently-selected tool — hides tabs with 0 rows. */
  const visibleSourceTabs = useMemo(() => {
    if (sessionTool === 'all') return SOURCE_TABS;
    return SOURCE_TABS.filter(t => t.id === 'all' || getTypeCount(t.id, sessionTool) > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionTool, status]);

  // If the active tab gets hidden by the tool filter, snap back to "Everything".
  useEffect(() => {
    if (sessionTool === 'all') return;
    const stillVisible = visibleSourceTabs.some(t => t.id === activeType);
    if (!stillVisible) {
      setActiveType('all');
      setSelectedId(null);
    }
  }, [sessionTool, visibleSourceTabs, activeType]);

  // Push source-type rows into the global Sidebar as a "Type" section so
  // the horizontal SegmentedControl below can disappear.
  useSidebarExtrasRegister(() => ([{
    heading: 'Type',
    rows: visibleSourceTabs.map(t => ({
      id: `memory-type-${t.id}`,
      label: t.label,
      count: getTypeCount(t.id, sessionTool),
      on: activeType === t.id,
      onClick: () => {
        setActiveType(t.id as SourceType | 'all');
        setSearchResults([]);
        setSelectedId(null);
      },
      testId: `memory-type-${t.id}`,
    })),
  }]), [visibleSourceTabs, activeType, sessionTool, status]);

  const rawDisplayedItems: MemoryMetadataRow[] = query
    ? searchResults.map((r) => ({
        id: r.itemId,
        source_type: r.sourceType,
        title: r.title,
        content_preview: r.text,
        mtime: r.mtime,
        project_path: r.projectPath,
        file_path: r.filePath,
        indexed_at: 0,
        extra_json: '{}',
      }))
    : items;

  const isToolFilterable = TOOL_FILTERABLE.has(activeType);
  const filteredItems =
    isToolFilterable && sessionTool !== 'all'
      ? rawDisplayedItems.filter(it => readItemTool(it) === sessionTool)
      : rawDisplayedItems;
  // When browsing (not searching), cluster by project so a repo's notes/plans
  // sit together — a light "grouped" feel without restructuring the list.
  const displayedItems = query ? filteredItems : [...filteredItems].sort((a, b) => {
    const pa = (a.project_path || '~~').split('/').pop() || '~~';
    const pb = (b.project_path || '~~').split('/').pop() || '~~';
    return pa.localeCompare(pb) || (b.mtime - a.mtime);
  });

  // Per-tool counts in the currently-loaded set, for the filter chip badges.
  const sessionToolCounts = useMemo(() => {
    if (!isToolFilterable) return { claude: 0, gemini: 0, opencode: 0, codex: 0 };
    const c = { claude: 0, gemini: 0, opencode: 0, codex: 0 } as Record<string, number>;
    for (const it of rawDisplayedItems) {
      const t = readItemTool(it);
      if (t in c) c[t]++;
    }
    return c as { claude: number; gemini: number; opencode: number; codex: number };
  }, [isToolFilterable, rawDisplayedItems]);

  const selectedItem = displayedItems.find((i) => i.id === selectedId);

  return (
    <div
      data-testid="memory-explorer"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--cr-ink-0)',
        overflow: 'hidden',
      }}
    >
      {/* Header / Search */}
      <div
        style={{
          padding: '24px 32px 16px',
          borderBottom: '1px solid var(--cr-line-1)',
          background: 'var(--cr-ink-1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, maxWidth: 1000, margin: '0 auto', width: '100%' }}>
          <div style={{ flex: 1 }}>
            <Input
              placeholder={`Search in ${activeType === 'all' ? 'everything' : pluralizeSource(activeType)}…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              onClear={() => {
                setQuery('');
                setSearchResults([]);
              }}
              inputSize="lg"
            />
          </div>
          <Button variant="primary" size="lg" onClick={handleSearch} disabled={!query.trim() || loading}>
            Search Memory
          </Button>
        </div>
      </div>

      {/* Both the Tool filter and the Type filter live in the global
          Sidebar now. We keep just the per-type Reindex action here so it
          stays close to the visible content. */}
      <div
        style={{
          padding: '8px 32px',
          borderBottom: '1px solid var(--cr-line-1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 12,
          minHeight: 36,
        }}
      >
        {activeType !== 'all' && (
          <Button
            size="sm"
            variant="ghost"
            icon="refresh"
            onClick={() => handleReindex(activeType as SourceType)}
            disabled={reindexing.has(activeType as SourceType)}
          >
            {reindexing.has(activeType as SourceType) ? 'Reindexing...' : 'Reindex'}
          </Button>
        )}
      </div>

      {/* Body: list + detail */}
      <div
        className="cr-split"
        data-has-selection={selectedId ? 'true' : undefined}
        style={{ flex: 1, display: 'flex', overflow: 'hidden' }}
      >
        {/* List */}
        <div
          className="cr-split-list"
          style={{
            width: 380,
            flexShrink: 0,
            borderRight: '1px solid var(--cr-line-1)',
            overflowY: 'auto',
            background: 'var(--cr-ink-1)',
          }}
        >
          {loading && displayedItems.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>Loading…</div>
          ) : displayedItems.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>
              {query ? 'No results found' : 'No items indexed yet'}
            </div>
          ) : (
            displayedItems.map((item) => (
              <div
                key={`${item.source_type}:${item.id}`}
                {...pressableProps(() => setSelectedId(item.id))}
                style={{
                  padding: '14px 20px',
                  cursor: 'pointer',
                  borderBottom: '1px solid var(--cr-line-1)',
                  background: selectedId === item.id ? 'var(--cr-ink-2)' : 'transparent',
                  transition: 'background var(--cr-dur-fast)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <SourceBadge source={item.source_type as any} />
                  {(() => {
                    const tool = readItemTool(item);
                    return tool ? <ToolBadge tool={tool} size="sm" /> : null;
                  })()}
                  {item.project_path && (
                    <span className="mono" style={{ fontSize: 11, color: 'var(--cr-fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
                      {item.project_path.split('/').pop()}
                    </span>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginLeft: 'auto' }}>
                    {new Date(item.mtime).toLocaleDateString()}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: selectedId === item.id ? 'var(--cr-fg-1)' : 'var(--cr-fg-2)',
                    marginBottom: 4,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {item.title}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--cr-fg-3)',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    lineHeight: 1.4,
                  }}
                >
                  {item.content_preview}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Detail */}
        <div className="cr-split-detail" style={{ flex: 1, overflowY: 'auto', background: 'var(--cr-ink-0)' }}>
          {selectedItem ? (
            <>
              {/* Mobile-only back button — returns to list view. */}
              <button
                type="button"
                className="cr-mobile-only cr-split-back"
                onClick={() => setSelectedId(null)}
                aria-label="Back to list"
              >
                <Icon name="chevronLeft" size={14} /> Back
              </button>
              <MemoryDetail item={selectedItem} onSessionClick={onSessionClick} />
            </>
          ) : (
            <div
              style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--cr-fg-3)',
              }}
            >
              <div style={{ textAlign: 'center' }}>
                <Icon name="brain" size={32} style={{ opacity: 0.2, marginBottom: 16 }} />
                <div>Select an item to view details</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function MemoryDetail({ item, onSessionClick }: { item: MemoryMetadataRow; onSessionClick?: (id: string) => void }) {
  const [links, setLinks] = useState<MemoryLinkRow[]>([]);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLinks([]);
    setContent(null);
    setLoading(true);

    Promise.all([
      getMemoryLinks(item.source_type, item.id).then(setLinks).catch(console.error),
      getMemoryItemContent(item.source_type, item.id).then(setContent).catch(console.error),
    ]).finally(() => setLoading(false));
  }, [item.id, item.source_type]);

  const displayContent = content || item.content_preview;
  // Some memory items (notably `history` aggregates) can be many megabytes on
  // a single line. Handing that to ReactMarkdown + syntax highlighting freezes
  // the whole tab. Cap what we render and fall back to plain truncated text.
  const MAX_RENDER_CHARS = 200_000;
  const contentTooLarge = !!displayContent && displayContent.length > MAX_RENDER_CHARS;
  const safeContent = contentTooLarge ? displayContent!.slice(0, MAX_RENDER_CHARS) : displayContent;

  return (
    <div style={{ padding: '40px 40px 100px', maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <SourceBadge source={item.source_type as any} />
        <span style={{ fontSize: 13, color: 'var(--cr-fg-3)' }}>{item.id}</span>
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--cr-fg-1)', marginBottom: 20, letterSpacing: '-0.015em' }}>
        {item.title}
      </h1>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 32 }}>
        {item.project_path && (
          <Chip kind="mono" icon="database">
            {item.project_path.split('/').pop()}
          </Chip>
        )}
        <Chip kind="mono" icon="clock">
          Indexed {new Date(item.mtime).toLocaleString()}
        </Chip>
        {item.file_path && (
          <Chip kind="mono" icon="file">
            {item.file_path.split('/').slice(-2).join('/')}
          </Chip>
        )}
      </div>

      {links.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              textTransform: 'uppercase',
              color: 'var(--cr-fg-3)',
              marginBottom: 12,
              letterSpacing: '0.04em',
            }}
          >
            Connected to
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {links.map((link) => {
              const isTarget = link.source_id === item.id;
              const otherId = isTarget ? link.target_id : link.source_id;
              const otherType = isTarget ? link.target_type : link.source_type;

              return (
                <Card
                  key={link.id}
                  interactive
                  style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <SourceBadge source={otherType as any} />
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{otherId.slice(0, 20)}…</span>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      <div
        style={{
          background: 'var(--cr-ink-1)',
          border: '1px solid var(--cr-line-1)',
          borderRadius: 'var(--cr-radius-md)',
          padding: 24,
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            fontSize: 11,
            color: 'var(--cr-fg-3)',
            textTransform: 'uppercase',
            fontWeight: 600,
          }}
        >
          {loading ? 'Loading Full Content…' : 'Full Content'}
        </div>

        <div className="markdown-body" style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--cr-fg-1)' }}>
          {contentTooLarge ? (
            <>
              <div style={{ fontSize: 12, color: 'var(--cr-warn-500)', marginBottom: 12 }}>
                Content is {(displayContent!.length / 1_048_576).toFixed(1)} MB — showing the first
                {' '}{Math.round(MAX_RENDER_CHARS / 1024)} KB as plain text.
              </div>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, margin: 0 }}>
                {safeContent}
              </pre>
            </>
          ) : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || '');
                if (match && String(children).includes('\n')) {
                  return (
                    <SyntaxHighlighter
                      language={match[1]}
                      style={vscDarkPlus}
                      customStyle={{ margin: '1rem 0', borderRadius: '8px', fontSize: '13px' }}
                    >
                      {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                  );
                }
                return (
                  <code
                    style={{
                      background: 'var(--cr-ink-2)',
                      padding: '2px 4px',
                      borderRadius: 4,
                      fontSize: '0.9em',
                    }}
                    {...props}
                  >
                    {children}
                  </code>
                );
              },
              h1: ({ children }) => <h1 style={{ borderBottom: '1px solid var(--cr-line-1)', paddingBottom: '0.3em', marginTop: '1.5em' }}>{children}</h1>,
              h2: ({ children }) => <h2 style={{ borderBottom: '1px solid var(--cr-line-1)', paddingBottom: '0.3em', marginTop: '1.5em' }}>{children}</h2>,
              blockquote: ({ children }) => (
                <blockquote
                  style={{
                    borderLeft: '4px solid var(--cr-brand-500)',
                    paddingLeft: '1em',
                    color: 'var(--cr-fg-3)',
                    margin: '1em 0',
                  }}
                >
                  {children}
                </blockquote>
              ),
            }}
          >
            {safeContent}
          </ReactMarkdown>
          )}
        </div>
      </div>

      {item.source_type === 'session' && onSessionClick && (
        <div style={{ marginTop: 32 }}>
          <Button variant="primary" size="md" icon="arrowRight" onClick={() => onSessionClick(item.id)}>
            Open Full Conversation
          </Button>
        </div>
      )}
    </div>
  );
}
