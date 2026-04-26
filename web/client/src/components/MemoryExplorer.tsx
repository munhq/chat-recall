import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Icon, Button, Input, SourceBadge, SegmentedControl, Card, Chip } from './primitives';
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

const SOURCE_TABS: Array<{ id: SourceType | 'all'; label: string }> = [
  { id: 'all', label: 'Everything' },
  { id: 'plan', label: 'Plans' },
  { id: 'session', label: 'Sessions' },
  { id: 'claude_md', label: 'CLAUDE.md' },
  { id: 'task', label: 'Tasks' },
  { id: 'paste', label: 'Pastebin' },
  { id: 'history', label: 'History' },
  { id: 'diary', label: 'Diary' },
];

interface MemoryExplorerProps {
  onSessionClick?: (sessionId: string) => void;
}

export default function MemoryExplorer({ onSessionClick }: MemoryExplorerProps) {
  const [activeType, setActiveType] = useState<SourceType | 'all'>('plan');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MemoryMetadataRow[]>([]);
  const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [reindexing, setReindexing] = useState<Set<string>>(new Set());

  useEffect(() => {
    getMemoryStatus().then(setStatus).catch(console.error);
  }, []);

  useEffect(() => {
    if (activeType !== 'all' && query === '') {
      setLoading(true);
      browseMemory(activeType)
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

  const getTypeCount = (type: string) => {
    if (!status) return 0;
    if (type === 'all') return status.totalItems;
    return status.bySourceType[type]?.items || 0;
  };

  const displayedItems = query
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
              placeholder={`Search in ${activeType === 'all' ? 'everything' : activeType + 's'}…`}
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

      {/* Tabs */}
      <div
        style={{
          padding: '12px 32px',
          borderBottom: '1px solid var(--cr-line-1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <SegmentedControl
          value={activeType}
          onChange={(v) => {
            setActiveType(v as SourceType | 'all');
            setSearchResults([]);
            setSelectedId(null);
          }}
          options={SOURCE_TABS.map((t) => ({
            value: t.id,
            label: `${t.label} (${getTypeCount(t.id)})`,
          }))}
        />

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
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* List */}
        <div
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
                onClick={() => setSelectedId(item.id)}
                style={{
                  padding: '14px 20px',
                  cursor: 'pointer',
                  borderBottom: '1px solid var(--cr-line-1)',
                  background: selectedId === item.id ? 'var(--cr-ink-2)' : 'transparent',
                  transition: 'background var(--cr-dur-fast)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <SourceBadge type={item.source_type as any} />
                  <span style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>
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
        <div style={{ flex: 1, overflowY: 'auto', background: 'var(--cr-ink-0)' }}>
          {selectedItem ? (
            <MemoryDetail item={selectedItem} onSessionClick={onSessionClick} />
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

function MemoryDetail({ item, onSessionClick }: { item: MemoryMetadataRow; onSessionClick?: (id: string) => void }) {
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

  return (
    <div style={{ padding: '40px 40px 100px', maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <SourceBadge type={item.source_type as any} />
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
                  <SourceBadge type={otherType as any} />
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
            {displayContent}
          </ReactMarkdown>
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
