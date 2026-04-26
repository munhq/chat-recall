import React, { useState, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import JsonView from '@uiw/react-json-view';
import { darkTheme } from '@uiw/react-json-view/dark';
import * as diff from 'diff';
import { Icon, Button, Chip, ToolBadge, SegmentedControl, Card } from './primitives';
import type {
  Message,
  SearchResult,
  SessionInfo,
  Subagent,
  RelatedItemsResponse,
  SessionMetadataResponse,
} from '../services/api';
import { getRawConversation, getSessionRelated, getSessionMetadata } from '../services/api';
import { stripInjectedBanners } from '../utils/clean';

type ViewMode = 'summary' | 'firstPrompt' | 'full' | 'raw' | 'related';
type MessageFilter = 'all' | 'user' | 'assistant' | 'thinking' | 'tools' | 'edits';

interface ConversationViewerProps {
  sessionId: string | null;
  messages: Message[];
  subagents?: Subagent[];
  loading: boolean;
  onClose: () => void;
  onLoadFull: () => void;
  searchResult: SearchResult | null;
  sessionInfo: SessionInfo | null;
}

export default function ConversationViewer({
  sessionId,
  messages,
  subagents = [],
  loading,
  onClose,
  onLoadFull,
  searchResult,
  sessionInfo,
}: ConversationViewerProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('summary');
  const [filter, setFilter] = useState<MessageFilter>('all');
  const [rawData, setRawData] = useState<any[]>([]);
  const [rawLoading, setRawLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [relatedData, setRelatedData] = useState<RelatedItemsResponse | null>(null);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [sessionMeta, setSessionMeta] = useState<SessionMetadataResponse | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);

  // ── Hooks ──

  useEffect(() => {
    if (sessionId) {
      setSessionMeta(null);
      setRelatedData(null);
      setMetaLoading(true);
      getSessionMetadata(sessionId)
        .then(setSessionMeta)
        .catch(() => {})
        .finally(() => setMetaLoading(false));
    }
  }, [sessionId]);

  useEffect(() => {
    const derivedTool = sessionMeta?.tool || sessionInfo?.tool || 'claude';
    const shouldAutoLoad = derivedTool !== 'claude' || viewMode === 'full';
    
    if (sessionId && shouldAutoLoad && messages.length === 0 && !loading) {
      onLoadFull();
    }
  }, [sessionId, sessionMeta?.tool, sessionInfo?.tool, messages.length, loading, onLoadFull, viewMode]);

  const isEdit = (m: Message) => m.toolCalls?.some(tc => 
    ['write', 'replace', 'insert', 'edit', 'patch', 'create'].some(keyword => tc.name.toLowerCase().includes(keyword))
  );

  const filteredMessages = useMemo(() => {
    if (filter === 'all') return messages;
    if (filter === 'user') return messages.filter(m => m.role === 'user');
    if (filter === 'assistant') return messages.filter(m => m.role === 'assistant');
    if (filter === 'thinking') return messages.filter(m => !!m.thinking);
    if (filter === 'tools') return messages.filter(m => m.toolCalls && m.toolCalls.length > 0);
    if (filter === 'edits') return messages.filter(m => isEdit(m));
    return messages;
  }, [messages, filter]);

  // ── Early return ──

  if (!sessionId) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--cr-ink-0)',
          color: 'var(--cr-fg-3)',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <Icon name="message" size={28} style={{ opacity: 0.3, marginBottom: 14 }} />
          <div style={{ fontSize: 14 }}>Select a conversation to view it</div>
        </div>
      </div>
    );
  }

  const tool = sessionMeta?.tool || sessionInfo?.tool || 'claude';
  const summary = stripInjectedBanners(
    searchResult?.summary ||
      sessionInfo?.summary ||
      sessionInfo?.firstPrompt ||
      sessionMeta?.contentPreview ||
      sessionMeta?.slug ||
      'No summary available'
  );
  const firstPrompt = stripInjectedBanners(
    searchResult?.firstPrompt ||
      sessionInfo?.firstPrompt ||
      sessionMeta?.contentPreview ||
      'No first prompt available'
  );

  function extractTitle(text: string | undefined): string {
    if (!text) return '';
    const stripped = stripInjectedBanners(text);
    const firstLine = stripped.split('\n')[0].trim();
    const cleaned = firstLine.replace(/^\*\*[^*]+\*\*:?\s*-?\s*/, '').trim();
    return cleaned.length > 80 ? cleaned.substring(0, 80) + '…' : cleaned;
  }
  const title =
    extractTitle(sessionInfo?.summary) ||
    extractTitle(searchResult?.summary) ||
    extractTitle(firstPrompt) ||
    extractTitle(summary) ||
    sessionMeta?.slug ||
    sessionId;

  const handleResume = () => {
    if (!sessionId) return;
    const command = `claude --resume ${sessionId}`;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = command;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (err) {
      console.error('Copy failed', err);
    }
  };

  const handleViewChange = (mode: ViewMode) => {
    if (mode === 'full' && messages.length === 0) {
      onLoadFull();
    }
    if (mode === 'raw' && rawData.length === 0) {
      setRawLoading(true);
      getRawConversation(sessionId)
        .then(setRawData)
        .catch(() => alert('Failed to load raw JSONL'))
        .finally(() => setRawLoading(false));
    }
    if (mode === 'related' && !relatedData) {
      setRelatedLoading(true);
      getSessionRelated(sessionId)
        .then(setRelatedData)
        .catch(() => {})
        .finally(() => setRelatedLoading(false));
    }
    if (mode === 'summary' && !sessionMeta) {
      setMetaLoading(true);
      getSessionMetadata(sessionId)
        .then(setSessionMeta)
        .catch(() => {})
        .finally(() => setMetaLoading(false));
    }
    setViewMode(mode);
  };

  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  };

  const formatCost = (n: number) => {
    if (n < 0.01) return `<$0.01`;
    return `$${n.toFixed(2)}`;
  };

  return (
    <div 
      className="conversation-column" 
      data-testid="conversation-viewer"
      style={{ flex: 1, overflowY: 'auto', background: 'var(--cr-ink-0)', position: 'relative' }}
    >
      <div style={{ padding: '20px 20px 80px', maxWidth: '100%' }}>
        {/* Top row: back + actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Button 
            variant="ghost" 
            size="sm" 
            icon="chevronRight" 
            onClick={onClose} 
            style={{ transform: 'rotate(180deg)' }}
            data-testid="close-conversation"
          >
            Back
          </Button>
          <div style={{ flex: 1 }} />
          {tool === 'claude' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {copied && <span style={{ fontSize: 12, color: 'var(--cr-ok-500)', fontWeight: 600 }}>Copied!</span>}
              <Button 
                variant={copied ? "outline" : "primary"} 
                size="sm" 
                icon={copied ? "check" : "arrowRight"} 
                onClick={handleResume}
              >
                Resume
              </Button>
            </div>
          )}
        </div>

        {/* Title */}
        <h1
          style={{
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            color: 'var(--cr-fg-1)',
            marginBottom: 8,
            wordBreak: 'break-word',
          }}
        >
          {title}
        </h1>

        {/* Meta context row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 12,
            flexWrap: 'wrap',
          }}
        >
          <ToolBadge tool={tool} />
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--cr-fg-2)' }}>
            {formatPath(sessionInfo?.projectPath || searchResult?.projectPath || '')}
          </span>
          <span style={{ fontSize: 13, color: 'var(--cr-fg-3)' }}>·</span>
          <span style={{ fontSize: 13, color: 'var(--cr-fg-3)' }}>
            {new Date(sessionInfo?.modified || Date.now()).toLocaleDateString()}
          </span>
        </div>

        {/* Meta row — chips */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            marginBottom: 16,
            alignItems: 'center',
          }}
        >
          {sessionMeta?.gitBranch && <Chip kind="ok" icon="check">{sessionMeta.gitBranch}</Chip>}
          {sessionMeta?.estimatedCostUsd && sessionMeta.estimatedCostUsd > 0 && (
            <Chip kind="warn">{formatCost(sessionMeta.estimatedCostUsd)}</Chip>
          )}
          {sessionMeta?.cacheSavingsUsd && sessionMeta.cacheSavingsUsd > 0.01 && (
            <Chip kind="ok">saved {formatCost(sessionMeta.cacheSavingsUsd)}</Chip>
          )}
          {sessionMeta?.toolsUsed && sessionMeta.toolsUsed.length > 0 && (
            <Chip kind="mono">
              {sessionMeta.toolsUsed.slice(0, 8).join(', ')}
              {sessionMeta.toolsUsed.length > 8 && ' +' + (sessionMeta.toolsUsed.length - 8)}
            </Chip>
          )}
        </div>

        {/* Token strip */}
        {(sessionMeta?.inputTokens || 0) > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))',
              gap: 1,
              background: 'var(--cr-line-1)',
              border: '1px solid var(--cr-line-1)',
              borderRadius: 'var(--cr-radius-md)',
              marginBottom: 24,
              overflow: 'hidden',
            }}
          >
            {[
              ['Input', formatTokens(sessionMeta?.inputTokens || 0)],
              ['Output', formatTokens(sessionMeta?.outputTokens || 0)],
              ['Cache read', formatTokens(sessionMeta?.cacheReadTokens || 0)],
              ['Cache write', formatTokens(sessionMeta?.cacheCreationTokens || 0)],
              ['Peak ctx', formatTokens(sessionMeta?.peakContextTokens || 0)],
            ].map(([l, v]) => (
              <div
                key={l}
                style={{
                  padding: '10px 12px',
                  background: 'var(--cr-ink-1)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--cr-fg-3)',
                    fontWeight: 500,
                    letterSpacing: '0.02em',
                    textTransform: 'uppercase',
                  }}
                >
                  {l}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--cr-fg-1)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {v}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* View mode buttons */}
        <div style={{ marginBottom: 20 }}>
          <SegmentedControl
            value={viewMode}
            onChange={(m) => handleViewChange(m as ViewMode)}
            options={[
              { value: 'summary', label: 'Summary', icon: 'file' },
              { value: 'firstPrompt', label: 'First Prompt', icon: 'message' },
              { value: 'full', label: 'Full', icon: 'list' },
              { value: 'raw', label: 'Raw', icon: 'terminal' },
              { value: 'related', label: 'Related', icon: 'sparkle' },
            ]}
          />
        </div>

        {/* Content */}
        {viewMode === 'summary' && (
          <div data-testid="conversation-summary">
            {metaLoading && <div style={{ color: 'var(--cr-fg-3)' }}>Loading...</div>}
            <div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--cr-fg-1)' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
            </div>
          </div>
        )}

        {viewMode === 'firstPrompt' && (
          <div data-testid="conversation-first-prompt" style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--cr-fg-1)' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{firstPrompt}</ReactMarkdown>
          </div>
        )}

        {viewMode === 'full' && (
          <div data-testid="conversation-full">
            <div 
              style={{ 
                display: 'flex', 
                flexDirection: 'column',
                gap: 12,
                background: 'var(--cr-ink-1)',
                border: '1px solid var(--cr-line-1)',
                borderRadius: 'var(--cr-radius-md)',
                padding: '12px 16px',
                marginBottom: 24 
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Filter conversation
                </div>
                <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>
                  Showing {filteredMessages.length} of {messages.length} messages
                  {subagents.length > 0 && (
                    <>
                      {' · '}
                      <span style={{ color: 'var(--cr-brand-500)' }}>
                        +{subagents.reduce((n, s) => n + s.messageCount, 0)} in {subagents.length}{' '}
                        subagent{subagents.length === 1 ? '' : 's'}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {[
                  { id: 'all', label: 'All', icon: 'list' },
                  { id: 'user', label: 'User', icon: 'message' },
                  { id: 'assistant', label: 'AI', icon: 'zap' },
                  { id: 'thinking', label: 'Thinking', icon: 'brain' },
                  { id: 'tools', label: 'Tool Calls', icon: 'terminal' },
                  { id: 'edits', label: 'Edits', icon: 'check' },
                ].map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => setFilter(opt.id as MessageFilter)}
                    style={{
                      height: 28,
                      padding: '0 10px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      background: filter === opt.id ? 'var(--cr-brand-surf)' : 'transparent',
                      color: filter === opt.id ? 'var(--cr-brand-500)' : 'var(--cr-fg-2)',
                      border: `1px solid ${filter === opt.id ? 'var(--cr-brand-line)' : 'transparent'}`,
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: filter === opt.id ? 600 : 400,
                      cursor: 'pointer',
                      transition: 'all var(--cr-dur-fast)',
                    }}
                  >
                    <Icon name={opt.icon} size={13} />
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {loading && (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>Loading conversation...</div>
            )}
            {!loading && filteredMessages.length === 0 && (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>
                <Icon name="filter" size={24} style={{ opacity: 0.3, marginBottom: 12 }} />
                <div>{messages.length === 0 ? "No messages found" : "No messages match the active filter"}</div>
                {filter !== 'all' && (
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    style={{ marginTop: 12 }} 
                    onClick={() => setFilter('all')}
                  >
                    Clear filter
                  </Button>
                )}
              </div>
            )}
            {!loading &&
              filteredMessages.map((msg, idx) => (
                <MessageBlock key={`${msg.line}-${idx}`} message={msg} />
              ))}

            {!loading && subagents.length > 0 && (
              <div
                style={{
                  marginTop: 32,
                  paddingTop: 24,
                  borderTop: '1px dashed var(--cr-line-1)',
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: 'var(--cr-fg-3)',
                    marginBottom: 12,
                  }}
                >
                  Subagent conversations ({subagents.length})
                </div>
                {subagents.map((sa) => (
                  <details
                    key={sa.id}
                    style={{
                      marginBottom: 10,
                      background: 'var(--cr-ink-1)',
                      border: '1px solid var(--cr-line-1)',
                      borderRadius: 'var(--cr-radius-md)',
                      padding: '10px 14px',
                    }}
                  >
                    <summary
                      style={{
                        cursor: 'pointer',
                        fontSize: 13,
                        fontWeight: 600,
                        color: 'var(--cr-fg-1)',
                        listStyle: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                      }}
                    >
                      <Icon name="zap" size={14} />
                      <span>
                        {sa.agentType || 'Subagent'}
                        {sa.description ? ` — ${sa.description}` : ''}
                      </span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--cr-fg-3)', fontWeight: 400 }}>
                        {sa.messageCount} msgs · {sa.toolUseCount} tool calls · {sa.kind}
                      </span>
                    </summary>
                    <div style={{ marginTop: 12 }}>
                      {sa.messages.map((msg, idx) => (
                        <MessageBlock key={`${sa.id}-${msg.line}-${idx}`} message={msg} />
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}

        {viewMode === 'raw' && (
          <div>
            {rawLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>Loading raw JSONL...</div>
            ) : (
              <div>
                <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginBottom: 8 }}>
                  Raw JSONL ({rawData.length} lines)
                </div>
                <JsonView value={rawData} style={darkTheme} displayDataTypes={false} collapsed={2} />
              </div>
            )}
          </div>
        )}

        {viewMode === 'related' && (
          <div>
            {relatedLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>Loading related items...</div>
            ) : !relatedData ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>
                No related items found.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                {relatedData.links.length > 0 && (
                  <div>
                    <h3 style={{ marginBottom: 12, fontSize: 14 }}>Linked Items</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
                      {relatedData.links.map((item) => (
                        <Card
                          key={`${item.sourceType}-${item.id}`}
                          interactive
                          style={{ padding: 14 }}
                        >
                          <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                            {item.sourceType} · {Math.round(item.confidence * 100)}% Match
                          </div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--cr-fg-1)', marginBottom: 6 }}>{item.title}</div>
                          {item.contentPreview && (
                            <div style={{ fontSize: 13, color: 'var(--cr-fg-2)', lineHeight: 1.5 }}>{item.contentPreview}</div>
                          )}
                        </Card>
                      ))}
                    </div>
                  </div>
                )}
                
                {relatedData.projectPlans.length > 0 && (
                  <div>
                    <h3 style={{ marginBottom: 12, fontSize: 14 }}>Project Plans</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
                      {relatedData.projectPlans.map((plan) => (
                        <Card
                          key={plan.id}
                          interactive
                          style={{ padding: 14 }}
                        >
                          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--cr-fg-1)', marginBottom: 6 }}>{plan.title}</div>
                          {plan.contentPreview && (
                            <div style={{ fontSize: 13, color: 'var(--cr-fg-2)', lineHeight: 1.5 }}>{plan.contentPreview}</div>
                          )}
                        </Card>
                      ))}
                    </div>
                  </div>
                )}

                {relatedData.siblingSessionsInProject.length > 0 && (
                  <div>
                    <h3 style={{ marginBottom: 12, fontSize: 14 }}>Other Sessions in Project</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
                      {relatedData.siblingSessionsInProject.map((sib) => (
                        <Card
                          key={sib.sessionId}
                          interactive
                          style={{ padding: 14 }}
                        >
                          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--cr-fg-1)', marginBottom: 6 }}>
                            {extractTitle(sib.summary) || extractTitle(sib.firstPrompt) || sib.sessionId.slice(0, 8)}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginBottom: 6 }}>
                            {new Date(sib.modified).toLocaleDateString()}
                          </div>
                          {sib.summary && (
                            <div style={{ fontSize: 13, color: 'var(--cr-fg-2)', lineHeight: 1.5 }}>{extractTitle(sib.summary)}</div>
                          )}
                        </Card>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function getLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    js: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    md: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml',
    dockerfile: 'dockerfile', docker: 'dockerfile',
    zig: 'zig', cpp: 'cpp', c: 'c', h: 'cpp',
    html: 'html', css: 'css', sql: 'sql',
  };
  const lowerPath = path.toLowerCase();
  if (lowerPath.includes('dockerfile')) return 'dockerfile';
  if (lowerPath.includes('.sh')) return 'bash';
  return map[ext] || 'text';
}

function MessageBlock({ message }: { message: Message }) {
  const renderContent = () => {
    if (!message.content) return null;
    return (
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
                  customStyle={{ margin: '0.5rem 0', borderRadius: '6px' }}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {message.content}
      </ReactMarkdown>
    );
  };

  return (
    <div 
      className={`message message-${message.role}`}
      style={{ marginBottom: 40, display: 'flex', gap: 16 }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          flexShrink: 0,
          borderRadius: 8,
          background: message.role === 'user' ? 'var(--cr-ink-2)' : 'var(--cr-brand-surf)',
          border: `1px solid ${message.role === 'user' ? 'var(--cr-line-1)' : 'var(--cr-brand-line)'}`,
          color: message.role === 'user' ? 'var(--cr-fg-2)' : 'var(--cr-brand-500)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
      >
        {message.role === 'user' ? 'You' : 'AI'}
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
        <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontWeight: 700, textTransform: 'uppercase', color: 'var(--cr-fg-2)' }}>{message.role}</span>
          <span>·</span>
          <span>Line {message.line}</span>
        </div>

        {message.thinking && (
          <details 
            style={{ 
              marginBottom: 16, 
              background: 'var(--cr-ink-1)', 
              border: '1px solid var(--cr-line-1)', 
              borderRadius: 8,
              overflow: 'hidden'
            }}
          >
            <summary style={{ padding: '10px 14px', fontSize: 13, color: 'var(--cr-fg-3)', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="brain" size={14} style={{ color: 'var(--cr-brand-500)' }} />
              Thinking Process
            </summary>
            <div style={{ padding: '4px 14px 14px', fontSize: 13, color: 'var(--cr-fg-2)', whiteSpace: 'pre-wrap', lineHeight: 1.6, borderTop: '1px solid var(--cr-line-1)', paddingTop: 12, opacity: 0.85 }}>
              {message.thinking}
            </div>
          </details>
        )}

        <div style={{ fontSize: 14, color: 'var(--cr-fg-1)', lineHeight: 1.6 }}>{renderContent()}</div>
        
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {message.toolCalls.map((tc, i) => {
              const hasOldNew = tc.input.old_string !== undefined && tc.input.new_string !== undefined;
              const isWrite = tc.name.toLowerCase().includes('write') && tc.input.content !== undefined;
              const isReplace = tc.name.toLowerCase().includes('replace');
              const isEdit = ['insert', 'edit', 'patch', 'create'].some(k => tc.name.toLowerCase().includes(k)) || isReplace || hasOldNew || isWrite;
              const isBash = ['bash', 'shell', 'command'].some(k => tc.name.toLowerCase().includes(k));
              const filePath = tc.input.file_path || tc.input.path || 'file';
              
              let diffText = '';
              if (hasOldNew) {
                try {
                  const patch = diff.createPatch(
                    filePath,
                    tc.input.old_string,
                    tc.input.new_string
                  );
                  diffText = patch.split('\n').slice(4).join('\n');
                } catch (e) {
                  console.error('Diff failed', e);
                }
              }

              return (
                <div 
                  key={i} 
                  style={{ 
                    display: 'flex', 
                    gap: 12,
                    position: 'relative',
                    paddingLeft: 4
                  }}
                >
                  {/* Bullet / Line */}
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: isEdit ? 'var(--cr-ok-500)' : 'var(--cr-brand-500)', marginTop: 8, flexShrink: 0 }} />
                  
                  <details 
                    style={{ 
                      flex: 1,
                      background: 'var(--cr-ink-1)',
                      border: `1px solid ${isEdit ? 'var(--cr-ok-line)' : 'var(--cr-line-1)'}`,
                      borderRadius: 8,
                      overflow: 'hidden'
                    }}
                    open={isEdit}
                  >
                    <summary style={{ padding: '8px 12px', fontSize: 13, color: 'var(--cr-fg-1)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, listStyle: 'none' }}>
                      <Icon name={isBash ? "terminal" : isEdit ? "edit" : "zap"} size={14} style={{ color: isEdit ? 'var(--cr-ok-500)' : 'var(--cr-brand-500)' }} />
                      <span style={{ fontWeight: 600 }}>{tc.name}</span>
                      {isEdit && <Chip kind="ok" size="xs">{diffText ? 'Diff View' : isWrite ? 'File Create' : 'File Edit'}</Chip>}
                      <div style={{ flex: 1 }} />
                      <Icon name="chevronRight" size={12} style={{ opacity: 0.3 }} />
                    </summary>
                    
                    <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--cr-line-1)', paddingTop: 10 }}>
                      <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginBottom: 6, textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.02em' }}>Input</div>
                      
                      {isBash && tc.input.command ? (
                        <SyntaxHighlighter
                          language="bash"
                          style={vscDarkPlus}
                          customStyle={{ margin: 0, padding: '10px', borderRadius: '6px', fontSize: '12px' }}
                        >
                          {tc.input.command}
                        </SyntaxHighlighter>
                      ) : diffText ? (
                        <div style={{ marginBottom: 8 }}>
                           <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--cr-ok-500)', marginBottom: 8 }}>Patch: {filePath}</div>
                           <SyntaxHighlighter
                              language="diff"
                              style={vscDarkPlus}
                              customStyle={{ margin: 0, padding: '10px', borderRadius: '6px', fontSize: '12px', border: '1px solid var(--cr-ok-line)' }}
                            >
                              {diffText}
                            </SyntaxHighlighter>
                         </div>
                      ) : isWrite ? (
                         <div style={{ marginBottom: 8 }}>
                           <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--cr-ok-500)', marginBottom: 8 }}>Writing: {filePath}</div>
                           <SyntaxHighlighter
                              language={getLanguage(filePath)}
                              style={vscDarkPlus}
                              customStyle={{ margin: 0, padding: '10px', borderRadius: '6px', fontSize: '12px', border: '1px solid var(--cr-ok-line)' }}
                            >
                              {tc.input.content}
                            </SyntaxHighlighter>
                         </div>
                      ) : isEdit && (tc.input.path || tc.input.file_path) ? (
                         <div style={{ marginBottom: 8 }}>
                           <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--cr-ok-500)', marginBottom: 8 }}>File: {filePath}</div>
                           <pre style={{ margin: 0, padding: 10, background: 'var(--cr-ink-0)', borderRadius: 6, fontSize: 12, overflowX: 'auto', border: '1px solid var(--cr-ok-line)' }}>
                             <code>{JSON.stringify(tc.input, null, 2)}</code>
                           </pre>
                         </div>
                      ) : (
                        <pre style={{ margin: 0, padding: 10, background: 'var(--cr-ink-0)', borderRadius: 6, fontSize: 12, overflowX: 'auto' }}>
                          <code>{JSON.stringify(tc.input, null, 2)}</code>
                        </pre>
                      )}

                      {tc.result && (
                        <>
                          <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginBottom: 6, marginTop: 14, textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.02em' }}>Result</div>
                          <pre style={{ margin: 0, padding: 10, background: 'var(--cr-ink-0)', borderRadius: 6, fontSize: 12, overflowX: 'auto', opacity: 0.9 }}>
                            <code>{typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)}</code>
                          </pre>
                        </>
                      )}
                    </div>
                  </details>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function formatPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return path;
}
