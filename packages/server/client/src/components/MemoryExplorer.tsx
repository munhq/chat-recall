/**
 * Memory — the cross-chat memory hub. Not a flat table of rows (that answered
 * "what files exist"); instead it answers "what does my history KNOW" — the
 * decisions/preferences/milestones the classifier tagged, cross-linked across
 * sessions, plans, notes, tasks and diary — and lets you search or browse into
 * any of it.
 *
 * Visuals follow the app's cr-* design system and mirror the Activity rebuild:
 * an overview strip of stat tiles, then a search/browse split with source and
 * memory-type badges. The memory-type + importance chips read the classifier
 * tag baked into chunk_type (`…:decision:imp5`) that search results carry.
 */

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
  getMemoryLinks,
  browseMemory,
  reindexMemory,
  getMemoryItemContent,
  getMemoryItem,
} from '../services/api';

// Sessions live under the Conversations tab — Memory is for non-session memory
// primitives. Skills / MCPs / Agents are config-y and live under the new
// Toolkit tab, not here.
const SOURCE_TABS: Array<{ id: SourceType | 'all'; label: string }> = [
  { id: 'all', label: 'Everything' },
  { id: 'plan', label: 'Plans' },
  // CLAUDE.md / GEMINI.md / AGENTS.md all live in this source type.
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
    case 'claude_md': return 'notes';
    case 'paste':     return 'pastes';
    case 'history':   return 'history';
    case 'diary':     return 'diary entries';
    default:          return 'everything';
  }
}

// ── Memory-type presentation ─────────────────────────────────────
// The classifier bakes `…:<type>:imp<N>` into chunk_type. We surface it as a
// colored chip so the highest-signal memories (decisions, milestones) read at a
// glance — never color alone, always the label too.
type MemoryKind = 'decision' | 'preference' | 'milestone' | 'problem' | 'discovery';
const KIND_META: Record<MemoryKind, { label: string; color: string; surf: string }> = {
  decision:   { label: 'decision',   color: 'var(--cr-brand-500)', surf: 'var(--cr-brand-surf)' },
  milestone:  { label: 'milestone',  color: 'var(--cr-ok-500)',    surf: 'var(--cr-ok-surf)' },
  problem:    { label: 'problem',     color: 'var(--cr-err-500)',   surf: 'var(--cr-err-surf)' },
  preference: { label: 'preference', color: 'var(--cr-info-500)',  surf: 'var(--cr-info-surf)' },
  discovery:  { label: 'discovery',  color: 'var(--cr-warn-500)',  surf: 'var(--cr-warn-surf)' },
};

/** Parse `assistant:decision:imp5` → { kind, imp }. */
function parseKind(chunkType?: string): { kind: MemoryKind; imp: number } | null {
  if (!chunkType) return null;
  const m = chunkType.match(/:(\w+):imp([0-9])/);
  if (!m) return null;
  const kind = m[1] as MemoryKind;
  if (!(kind in KIND_META)) return null;
  return { kind, imp: Number(m[2]) };
}

function MemoryTypeChip({ chunkType }: { chunkType?: string }) {
  const parsed = parseKind(chunkType);
  if (!parsed) return null;
  const meta = KIND_META[parsed.kind];
  return (
    <span
      title={`classified ${meta.label}, importance ${parsed.imp}/5`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600,
        color: meta.color, background: meta.surf, border: `1px solid ${meta.color}`,
        borderRadius: 'var(--cr-radius-xs)', padding: '1px 6px', whiteSpace: 'nowrap',
      }}
    >
      {meta.label}
      {parsed.imp >= 4 && <span style={{ opacity: 0.8 }}>·{parsed.imp}</span>}
    </span>
  );
}

function StatTile({ value, label, accent }: { value: React.ReactNode; label: string; accent?: string }) {
  return (
    <div style={{ padding: '10px 14px', background: 'var(--cr-ink-2)', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-sm)', minWidth: 92 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent || 'var(--cr-fg-1)', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
    </div>
  );
}

interface MemoryExplorerProps {
  onSessionClick?: (sessionId: string) => void;
  toolFilter?: string;
  projectFilter?: string | null;
  /** Resolved filesystem path for the selected project. Memory search/browse
   *  scope on project_path (a substring), not the project_id the sidebar holds. */
  projectPathFilter?: string | null;
}

type SessionToolFilter = 'all' | 'claude' | 'gemini' | 'opencode' | 'codex' | 'agy';

/** A list row: a browsed metadata row, or a search hit carrying its chunkType. */
type DisplayRow = MemoryMetadataRow & { chunkType?: string; snippet?: string };

function readItemTool(item: { source_type: string; extra_json?: string }): string {
  if (!TOOL_FILTERABLE.has(item.source_type as any)) return '';
  try {
    const t = JSON.parse(item.extra_json || '{}').tool;
    if (t) return t;
  } catch { /* fall through */ }
  return 'claude';
}

export default function MemoryExplorer({ onSessionClick, toolFilter = 'all', projectFilter = null, projectPathFilter = null }: MemoryExplorerProps) {
  const [activeType, setActiveType] = useState<SourceType | 'all'>('all');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MemoryMetadataRow[]>([]);
  const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [reindexing, setReindexing] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const sessionTool = (toolFilter || 'all') as SessionToolFilter;
  const errMsg = (e: unknown, verb: string) => `Couldn't ${verb}${e instanceof Error ? `: ${e.message}` : '. Try again.'}`;

  useEffect(() => {
    getMemoryStatus().then(setStatus).catch(console.error);
  }, []);

  // The server scopes memory by project_path SUBSTRING (see store.searchFTS),
  // so browse — which has no server-side project param — is scoped here on the
  // fetched rows' project_path. Search passes the path substring to the server.
  const scopeToProject = (rows: MemoryMetadataRow[]) =>
    projectPathFilter ? rows.filter(r => (r.project_path || '').includes(projectPathFilter)) : rows;

  useEffect(() => {
    if (activeType !== 'all' && query === '') {
      setLoading(true); setError(null);
      const limit = TOOL_FILTERABLE.has(activeType) ? 1000 : 50;
      browseMemory(activeType, limit)
        .then((rows) => setItems(scopeToProject(rows)))
        .catch((e) => setError(errMsg(e, 'load these items')))
        .finally(() => setLoading(false));
    } else if (activeType === 'all' && query === '') {
      // "Everything" browse: pull a mixed recent page across the primitive sources.
      setLoading(true); setError(null);
      Promise.all(SOURCE_TABS.filter(t => t.id !== 'all').map(t => browseMemory(t.id as SourceType, 40).catch(() => [])))
        .then(lists => setItems(scopeToProject(lists.flat().sort((a, b) => b.mtime - a.mtime))))
        .catch((e) => setError(errMsg(e, 'load your memory')))
        .finally(() => setLoading(false));
    } else {
      setItems([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeType, query, projectPathFilter]);

  const handleSearch = () => {
    if (!query.trim()) return;
    setLoading(true); setError(null);
    searchMemory(query, 30, activeType === 'all' ? undefined : [activeType as SourceType], projectPathFilter || undefined)
      .then(setSearchResults)
      .catch((e) => setError(errMsg(e, 'run that search')))
      .finally(() => setLoading(false));
  };

  // Re-run an active search when the project scope changes.
  useEffect(() => {
    if (query.trim()) handleSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPathFilter]);

  const handleReindex = (type: SourceType) => {
    setReindexing((s) => new Set(s).add(type));
    setError(null);
    reindexMemory([type])
      .then(() => {
        getMemoryStatus().then(setStatus).catch(() => {});
        if (activeType === type) browseMemory(type).then((rows) => setItems(scopeToProject(rows))).catch(() => {});
      })
      .catch((e) => setError(errMsg(e, `re-index ${type}`)))
      .finally(() => {
        setReindexing((s) => { const next = new Set(s); next.delete(type); return next; });
      });
  };

  const getTypeCount = (type: string, tool: SessionToolFilter) => {
    if (!status) return 0;
    if (type === 'all') {
      if (tool === 'all') return status.totalItems;
      let n = 0;
      const map = status.bySourceAndTool || {};
      for (const t of Object.keys(map)) n += map[t][tool] || 0;
      return n;
    }
    if (tool === 'all') return status.bySourceType[type]?.items || 0;
    return status.bySourceAndTool?.[type]?.[tool] || 0;
  };

  const visibleSourceTabs = useMemo(() => {
    if (sessionTool === 'all') return SOURCE_TABS;
    return SOURCE_TABS.filter(t => t.id === 'all' || getTypeCount(t.id, sessionTool) > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionTool, status]);

  useEffect(() => {
    if (sessionTool === 'all') return;
    const stillVisible = visibleSourceTabs.some(t => t.id === activeType);
    if (!stillVisible) { setActiveType('all'); setSelectedId(null); }
  }, [sessionTool, visibleSourceTabs, activeType]);

  useSidebarExtrasRegister(() => ([{
    heading: 'Type',
    rows: visibleSourceTabs.map(t => ({
      id: `memory-type-${t.id}`,
      label: t.label,
      count: getTypeCount(t.id, sessionTool),
      on: activeType === t.id,
      onClick: () => { setActiveType(t.id as SourceType | 'all'); setSearchResults([]); setSelectedId(null); },
      testId: `memory-type-${t.id}`,
    })),
  }]), [visibleSourceTabs, activeType, sessionTool, status]);

  const rawDisplayedItems: DisplayRow[] = query
    ? searchResults.map((r) => ({
        id: r.itemId,
        source_type: r.sourceType,
        title: r.title,
        content_preview: r.matchedChunks?.[0]?.text || r.text,
        mtime: r.mtime,
        project_path: r.projectPath,
        file_path: r.filePath,
        indexed_at: 0,
        extra_json: '{}',
        chunkType: r.chunkType,
        snippet: r.matchedChunks?.[0]?.text || r.text,
      }))
    : items;

  const isToolFilterable = TOOL_FILTERABLE.has(activeType);
  const filteredItems =
    isToolFilterable && sessionTool !== 'all'
      ? rawDisplayedItems.filter(it => readItemTool(it) === sessionTool)
      : rawDisplayedItems;
  const displayedItems = query ? filteredItems : [...filteredItems].sort((a, b) => {
    const pa = (a.project_path || '~~').split('/').pop() || '~~';
    const pb = (b.project_path || '~~').split('/').pop() || '~~';
    return pa.localeCompare(pb) || (b.mtime - a.mtime);
  });

  // A connected item can live outside the currently-browsed list, so opening
  // one fetches it directly and holds it as an override keyed by id.
  const [detailOverride, setDetailOverride] = useState<MemoryMetadataRow | null>(null);
  const selectedItem =
    displayedItems.find((i) => i.id === selectedId) ||
    (detailOverride && detailOverride.id === selectedId ? detailOverride : undefined);
  const openConnectedItem = (sourceType: string, id: string) => {
    setSelectedId(id);
    getMemoryItem(sourceType, id).then(setDetailOverride).catch(console.error);
  };

  // Overview tiles from status — total memory + a compact source breakdown.
  const overview = useMemo(() => {
    if (!status) return null;
    const order = ['plan', 'claude_md', 'task', 'paste', 'history', 'diary'];
    const byType = order
      .map(k => ({ k, label: SOURCE_TABS.find(t => t.id === k)?.label || k, n: status.bySourceType[k]?.items || 0 }))
      .filter(x => x.n > 0);
    return { total: status.totalItems, chunks: status.totalChunks, byType };
  }, [status]);

  return (
    <div
      data-testid="memory-explorer"
      style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--cr-ink-0)', overflow: 'hidden' }}
    >
      {/* Header + overview */}
      <div style={{ padding: '20px 32px 14px', borderBottom: '1px solid var(--cr-line-1)', background: 'var(--cr-ink-1)' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--cr-fg-1)' }}>Memory</h2>
            <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>
              what your history knows — decisions, plans and notes, cross-linked across chats
            </span>
          </div>

          {overview && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'stretch', marginBottom: 14 }}>
              <StatTile value={overview.total.toLocaleString()} label="memories" accent="var(--cr-brand-500)" />
              <StatTile value={overview.chunks.toLocaleString()} label="searchable chunks" />
              {overview.byType.map(x => (
                <button
                  key={x.k}
                  {...pressableProps(() => { setActiveType(x.k as SourceType); setQuery(''); setSearchResults([]); setSelectedId(null); })}
                  style={{
                    all: 'unset', cursor: 'pointer', padding: '10px 14px', minWidth: 78,
                    background: activeType === x.k ? 'var(--cr-brand-surf)' : 'var(--cr-ink-2)',
                    border: `1px solid ${activeType === x.k ? 'var(--cr-brand-line)' : 'var(--cr-line-1)'}`,
                    borderRadius: 'var(--cr-radius-sm)',
                  }}
                >
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--cr-fg-1)', lineHeight: 1.1 }}>{x.n.toLocaleString()}</div>
                  <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginTop: 2 }}>{x.label}</div>
                </button>
              ))}
            </div>
          )}

          {/* Search */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <Input
                placeholder={`Search ${activeType === 'all' ? 'all memory' : pluralizeSource(activeType)}…`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                onClear={() => { setQuery(''); setSearchResults([]); }}
                inputSize="lg"
              />
            </div>
            <Button variant="primary" size="lg" onClick={handleSearch} disabled={!query.trim() || loading}>
              Search
            </Button>
            {activeType !== 'all' && (
              <Button
                size="lg"
                variant="ghost"
                icon="refresh"
                onClick={() => handleReindex(activeType as SourceType)}
                disabled={reindexing.has(activeType as SourceType)}
              >
                {reindexing.has(activeType as SourceType) ? 'Reindexing…' : 'Reindex'}
              </Button>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 16px 8px', padding: '8px 12px', fontSize: 13, color: 'var(--cr-err-500)', background: 'var(--cr-err-surf)', border: '1px solid var(--cr-err-line)', borderRadius: 'var(--cr-radius-sm)' }}>
          <Icon name="shield" size={14} />
          <span style={{ flex: 1 }}>{error}</span>
          <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', color: 'var(--cr-fg-2)', cursor: 'pointer', fontSize: 12 }}>Dismiss</button>
        </div>
      )}

      {/* Body: list + detail */}
      <div className="cr-split" data-has-selection={selectedId ? 'true' : undefined} style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* List */}
        <div className="cr-split-list" style={{ width: 400, flexShrink: 0, borderRight: '1px solid var(--cr-line-1)', overflowY: 'auto', background: 'var(--cr-ink-1)' }}>
          {query && searchResults.length > 0 && (
            <div style={{ padding: '10px 20px', fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--cr-line-1)' }}>
              {searchResults.length} result{searchResults.length === 1 ? '' : 's'} for “{query}”
            </div>
          )}
          {loading && displayedItems.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>Loading…</div>
          ) : displayedItems.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)', fontSize: 13, lineHeight: 1.6 }}>
              {query ? <>No matches for “{query}”.<br />Try fewer or different words.</> : 'Nothing indexed here yet.'}
            </div>
          ) : (
            displayedItems.map((item) => {
              const tool = readItemTool(item);
              return (
                <div
                  key={`${item.source_type}:${item.id}`}
                  {...pressableProps(() => setSelectedId(item.id))}
                  style={{
                    padding: '13px 20px', cursor: 'pointer', borderBottom: '1px solid var(--cr-line-1)',
                    background: selectedId === item.id ? 'var(--cr-ink-2)' : 'transparent',
                    transition: 'background var(--cr-dur-fast)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                    <SourceBadge source={item.source_type as any} />
                    {tool ? <ToolBadge tool={tool} size="sm" /> : null}
                    <MemoryTypeChip chunkType={item.chunkType} />
                    {item.project_path && (
                      <span className="mono" style={{ fontSize: 11, color: 'var(--cr-fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
                        {item.project_path.split('/').pop()}
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginLeft: 'auto' }}>
                      {new Date(item.mtime).toLocaleDateString()}
                    </span>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: selectedId === item.id ? 'var(--cr-fg-1)' : 'var(--cr-fg-2)', marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.title || <span style={{ color: 'var(--cr-fg-3)', fontStyle: 'italic', fontWeight: 400 }}>(untitled)</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.4 }}>
                    {item.content_preview}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Detail */}
        <div className="cr-split-detail" style={{ flex: 1, overflowY: 'auto', background: 'var(--cr-ink-0)' }}>
          {selectedItem ? (
            <>
              <button type="button" className="cr-mobile-only cr-split-back" onClick={() => setSelectedId(null)} aria-label="Back to list">
                <Icon name="chevronLeft" size={14} /> Back
              </button>
              <MemoryDetail item={selectedItem} onSessionClick={onSessionClick} onOpenItem={openConnectedItem} />
            </>
          ) : (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cr-fg-3)' }}>
              <div style={{ textAlign: 'center' }}>
                <Icon name="brain" size={32} style={{ opacity: 0.2, marginBottom: 16 }} />
                <div>Select a memory to view it</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function MemoryDetail({ item, onSessionClick, onOpenItem }: { item: MemoryMetadataRow & { chunkType?: string }; onSessionClick?: (id: string) => void; onOpenItem?: (sourceType: string, id: string) => void }) {
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
  const MAX_RENDER_CHARS = 200_000;
  const contentTooLarge = !!displayContent && displayContent.length > MAX_RENDER_CHARS;
  const safeContent = contentTooLarge ? displayContent!.slice(0, MAX_RENDER_CHARS) : displayContent;

  return (
    <div style={{ padding: '36px 40px 100px', maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <SourceBadge source={item.source_type as any} />
        <MemoryTypeChip chunkType={item.chunkType} />
        <span className="mono" style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>{item.id}</span>
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 600, color: 'var(--cr-fg-1)', marginBottom: 20, letterSpacing: '-0.015em' }}>
        {item.title || <span style={{ color: 'var(--cr-fg-3)', fontStyle: 'italic' }}>Untitled</span>}
      </h1>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 28 }}>
        {item.project_path && <Chip kind="mono" icon="database">{item.project_path.split('/').pop()}</Chip>}
        <Chip kind="mono" icon="clock">Indexed {new Date(item.mtime).toLocaleString()}</Chip>
        {item.file_path && <Chip kind="mono" icon="file">{item.file_path.split('/').slice(-2).join('/')}</Chip>}
      </div>

      {links.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', color: 'var(--cr-fg-3)', marginBottom: 12, letterSpacing: '0.04em' }}>
            Connected across your memory
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {links.map((link) => {
              const isTarget = link.source_id === item.id;
              const otherId = isTarget ? link.target_id : link.source_id;
              const otherType = isTarget ? link.target_type : link.source_type;
              const canOpen = otherType === 'session' ? !!onSessionClick : !!onOpenItem;
              return (
                <Card
                  key={link.id}
                  interactive={canOpen}
                  onClick={canOpen ? () => (otherType === 'session' ? onSessionClick!(otherId) : onOpenItem!(otherType, otherId)) : undefined}
                  title={canOpen ? `Open ${otherType} ${otherId}` : otherId}
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

      <div style={{ background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-md)', padding: 24, position: 'relative' }}>
        <div style={{ position: 'absolute', top: 12, right: 12, fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', fontWeight: 600 }}>
          {loading ? 'Loading…' : 'Full Content'}
        </div>
        <div className="markdown-body" style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--cr-fg-1)' }}>
          {contentTooLarge ? (
            <>
              <div style={{ fontSize: 12, color: 'var(--cr-warn-500)', marginBottom: 12 }}>
                Content is {(displayContent!.length / 1_048_576).toFixed(1)} MB — showing the first {Math.round(MAX_RENDER_CHARS / 1024)} KB as plain text.
              </div>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, margin: 0 }}>{safeContent}</pre>
            </>
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '');
                  if (match && String(children).includes('\n')) {
                    return (
                      <SyntaxHighlighter language={match[1]} style={vscDarkPlus} customStyle={{ margin: '1rem 0', borderRadius: '8px', fontSize: '13px' }}>
                        {String(children).replace(/\n$/, '')}
                      </SyntaxHighlighter>
                    );
                  }
                  return <code style={{ background: 'var(--cr-ink-2)', padding: '2px 4px', borderRadius: 4, fontSize: '0.9em' }} {...props}>{children}</code>;
                },
                h1: ({ children }) => <h1 style={{ borderBottom: '1px solid var(--cr-line-1)', paddingBottom: '0.3em', marginTop: '1.5em' }}>{children}</h1>,
                h2: ({ children }) => <h2 style={{ borderBottom: '1px solid var(--cr-line-1)', paddingBottom: '0.3em', marginTop: '1.5em' }}>{children}</h2>,
                blockquote: ({ children }) => <blockquote style={{ borderLeft: '4px solid var(--cr-brand-500)', paddingLeft: '1em', color: 'var(--cr-fg-3)', margin: '1em 0' }}>{children}</blockquote>,
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
