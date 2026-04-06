/**
 * Conversation viewer with Summary, First Prompt, and Full Conversation tabs.
 */

import React, { useState } from 'react';
import MessageRenderer from './MessageRenderer';
import JsonView from '@uiw/react-json-view';
import { darkTheme } from '@uiw/react-json-view/dark';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  Message, SearchResult, SessionInfo,
  RelatedItemsResponse, SessionMetadataResponse,
} from '../services/api';
import { getRawConversation, getSessionRelated, getSessionMetadata } from '../services/api';
import './ConversationViewer.css';

type ViewMode = 'summary' | 'firstPrompt' | 'full' | 'raw' | 'related';

interface ConversationViewerProps {
  sessionId: string | null;
  messages: Message[];
  loading: boolean;
  onClose: () => void;
  onLoadFull: () => void;
  searchResult: SearchResult | null;
  sessionInfo: SessionInfo | null;
}

export default function ConversationViewer({
  sessionId,
  messages,
  loading,
  onClose,
  onLoadFull,
  searchResult,
  sessionInfo,
}: ConversationViewerProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('summary');
  const [rawData, setRawData] = useState<any[]>([]);
  const [rawLoading, setRawLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyMessage, setCopyMessage] = useState('Copied to clipboard!');
  const [relatedData, setRelatedData] = useState<RelatedItemsResponse | null>(null);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [sessionMeta, setSessionMeta] = useState<SessionMetadataResponse | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);

  // Load metadata eagerly since summary is the default tab
  React.useEffect(() => {
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

  if (!sessionId) {
    return null;
  }

  const tool = sessionMeta?.tool || sessionInfo?.tool || 'claude';
  const summary = searchResult?.summary || sessionInfo?.summary
    || sessionInfo?.firstPrompt || sessionMeta?.contentPreview || sessionMeta?.slug || 'No summary available';
  const firstPrompt = searchResult?.firstPrompt || sessionInfo?.firstPrompt
    || sessionMeta?.contentPreview || 'No first prompt available';

  // For non-Claude sessions, auto-load the full conversation since there's no summary
  React.useEffect(() => {
    if (sessionId && tool !== 'claude' && messages.length === 0 && !loading) {
      onLoadFull();
    }
  }, [sessionId, tool]);

  const handleResume = () => {
    const command = `claude --resume ${sessionId}`;

    // Try modern clipboard API first
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(command).then(() => {
        setCopyMessage('✓ Resume command copied!');
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      }).catch((err) => {
        console.error('Clipboard error:', err);
        fallbackCopy(command);
      });
    } else {
      // Fallback for browsers without clipboard API
      fallbackCopy(command);
    }
  };

  const fallbackCopy = (text: string) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      setCopyMessage('✓ Copied to clipboard!');
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch (err) {
      alert('Failed to copy to clipboard. Text: ' + text);
      console.error('Copy failed:', err);
    }
    document.body.removeChild(textarea);
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

  const copyToClipboard = async (text: string) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        setCopyMessage('✓ Copied to clipboard!');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        // Fallback for browsers without clipboard API
        fallbackCopy(text);
      }
    } catch (err) {
      console.error('Clipboard error:', err);
      fallbackCopy(text);
    }
  };

  const formatDuration = (ms: number) => {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    const mins = Math.round(ms / 60_000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
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

  const typeIcons: Record<string, string> = {
    session: '💬', plan: '📋', task: '✅',
    claude_md: '📄', history: '🕐', paste: '📎',
  };

  return (
    <div className="conversation-viewer">
      {copied && (
        <div className="copy-toast">
          {copyMessage}
        </div>
      )}
      <div className="conversation-header">
        <h2>
          <code>{sessionMeta?.slug || sessionId.substring(0, 8)}...</code>
        </h2>
        <button onClick={onClose} className="close-button">
          ✕ Close
        </button>
      </div>

      {/* View mode buttons */}
      <div className="view-mode-buttons">
        <button
          className={`mode-button ${viewMode === 'summary' ? 'active' : ''}`}
          onClick={() => handleViewChange('summary')}
        >
          📝 Summary
        </button>
        <button
          className={`mode-button ${viewMode === 'firstPrompt' ? 'active' : ''}`}
          onClick={() => handleViewChange('firstPrompt')}
        >
          💬 First Prompt
        </button>
        <button
          className={`mode-button ${viewMode === 'full' ? 'active' : ''}`}
          onClick={() => handleViewChange('full')}
        >
          📄 Full Conversation
        </button>
        {tool === 'claude' && (
          <button
            className={`mode-button ${viewMode === 'raw' ? 'active' : ''}`}
            onClick={() => handleViewChange('raw')}
            disabled={rawLoading}
          >
            {rawLoading ? '⏳' : '🔍 Raw JSONL'}
          </button>
        )}
        <button
          className={`mode-button ${viewMode === 'related' ? 'active' : ''}`}
          onClick={() => handleViewChange('related')}
          disabled={relatedLoading}
        >
          {relatedLoading ? '...' : '🔗 Related'}
        </button>
        {tool === 'claude' && (
          <button
            className="resume-button"
            onClick={handleResume}
            title="Copy resume command to clipboard"
          >
            {copied ? '✓ Copied!' : '🔄 Resume'}
          </button>
        )}
        {tool && tool !== 'claude' && (
          <span className={`viewer-tool-badge tool-${tool}`}>{tool}</span>
        )}
      </div>

      {/* Summary view */}
      {viewMode === 'summary' && (
        <div className="view-content">
          {/* Session metadata badges */}
          {sessionMeta && (
            <div className="session-meta-panel">
              <div className="meta-badges">
                {sessionMeta.slug && (
                  <span className="meta-badge meta-slug">{sessionMeta.slug}</span>
                )}
                {sessionMeta.durationMs > 0 && (
                  <span className="meta-badge">⏱ {formatDuration(sessionMeta.durationMs)}</span>
                )}
                <span className="meta-badge">💬 {sessionMeta.messageCount} msgs</span>
                {sessionMeta.gitBranch && (
                  <span className="meta-badge meta-git">⎇ {sessionMeta.gitBranch}</span>
                )}
                {sessionMeta.estimatedCostUsd > 0 && (
                  <span className="meta-badge meta-cost">💰 {formatCost(sessionMeta.estimatedCostUsd)}</span>
                )}
                {sessionMeta.cacheSavingsUsd > 0.01 && (
                  <span className="meta-badge meta-savings">💾 saved {formatCost(sessionMeta.cacheSavingsUsd)}</span>
                )}
              </div>

              {/* Token usage breakdown (hide if no token data) */}
              {(sessionMeta.inputTokens > 0 || sessionMeta.outputTokens > 0) && (
                <div className="meta-token-row">
                  <span className="token-item">
                    <span className="token-label">Input</span>
                    <span className="token-value">{formatTokens(sessionMeta.inputTokens)}</span>
                  </span>
                  <span className="token-item">
                    <span className="token-label">Output</span>
                    <span className="token-value">{formatTokens(sessionMeta.outputTokens)}</span>
                  </span>
                  {sessionMeta.cacheReadTokens > 0 && (
                    <span className="token-item">
                      <span className="token-label">Cache Read</span>
                      <span className="token-value">{formatTokens(sessionMeta.cacheReadTokens)}</span>
                    </span>
                  )}
                  {sessionMeta.peakContextTokens > 0 && (
                    <span className="token-item">
                      <span className="token-label">Peak Ctx</span>
                      <span className="token-value">{formatTokens(sessionMeta.peakContextTokens)}</span>
                    </span>
                  )}
                </div>
              )}

              {/* Tools used */}
              {sessionMeta.toolsUsed.length > 0 && (
                <div className="meta-tools">
                  <span className="meta-tools-label">Tools:</span>
                  {sessionMeta.toolsUsed.map(tool => (
                    <span key={tool} className="tool-chip">{tool}</span>
                  ))}
                </div>
              )}

              {/* Models used */}
              {sessionMeta.modelsUsed.filter(m => m !== '<synthetic>').length > 0 && (
                <div className="meta-models">
                  <span className="meta-tools-label">Models:</span>
                  {sessionMeta.modelsUsed.filter(m => m !== '<synthetic>').map(m => (
                    <span key={m} className="model-chip">{m.replace('claude-', '').replace(/-\d+$/, '')}</span>
                  ))}
                </div>
              )}

              {/* Files modified */}
              {sessionMeta.filesModified.length > 0 && (
                <details className="meta-files">
                  <summary className="meta-files-summary">
                    📁 {sessionMeta.filesModified.length} file{sessionMeta.filesModified.length !== 1 ? 's' : ''} modified
                  </summary>
                  <ul className="meta-files-list">
                    {sessionMeta.filesModified.map(f => (
                      <li key={f}><code>{f}</code></li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {metaLoading && (
            <div className="meta-loading">Loading session details...</div>
          )}

          <div className="view-header">
            <h3>Summary</h3>
            <button onClick={() => copyToClipboard(summary)} className="copy-button">
              📋 Copy
            </button>
          </div>
          <div className="view-text markdown-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
          </div>
        </div>
      )}

      {/* First prompt view */}
      {viewMode === 'firstPrompt' && (
        <div className="view-content">
          <div className="view-header">
            <h3>First Prompt</h3>
            <button onClick={() => copyToClipboard(firstPrompt)} className="copy-button">
              📋 Copy
            </button>
          </div>
          <div className="view-text">
            <p>{firstPrompt}</p>
          </div>
        </div>
      )}

      {/* Full conversation view */}
      {viewMode === 'full' && (
        <div className="view-content">
          {loading && (
            <div className="loading">
              <div className="spinner"></div>
              <p>Loading conversation...</p>
            </div>
          )}

          {!loading && messages.length === 0 && (
            <div className="empty">No messages found</div>
          )}

          {!loading && messages.length > 0 && (
            <div className="messages">
              <div className="messages-header">
                <span>{messages.length} messages</span>
              </div>
              {messages.map((msg, idx) => (
                <MessageRenderer key={`${msg.line}-${idx}`} message={msg} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Raw JSONL view */}
      {viewMode === 'raw' && (
        <div className="view-content">
          {rawLoading ? (
            <div className="loading">
              <div className="spinner"></div>
              <p>Loading raw JSONL...</p>
            </div>
          ) : (
            <div className="raw-jsonl">
              <div className="raw-header">
                <span>Raw JSONL ({rawData.length} lines)</span>
              </div>
              <JsonView
                value={rawData}
                style={darkTheme}
                displayDataTypes={false}
                collapsed={2}
              />
            </div>
          )}
        </div>
      )}

      {/* Related memories view */}
      {viewMode === 'related' && (
        <div className="view-content">
          {relatedLoading ? (
            <div className="loading">
              <div className="spinner"></div>
              <p>Loading related items...</p>
            </div>
          ) : !relatedData ? (
            <div className="empty">
              <p>No related items found for this session.</p>
              <p style={{ fontSize: '0.85rem', color: '#6e7681' }}>
                Run <code>chat-recall memory index</code> to build the memory index.
              </p>
            </div>
          ) : (
            <div className="related-list">
              {/* Direct links (tasks, history) */}
              {relatedData.links.length > 0 && (
                <div className="related-group">
                  <h4 className="related-group-title">Linked Items</h4>
                  {relatedData.links.map((item) => (
                    <div key={`${item.sourceType}-${item.id}`} className="related-item">
                      <span className="related-icon">{typeIcons[item.sourceType] || '🔗'}</span>
                      <div className="related-info">
                        <div className="related-type">{item.sourceType}</div>
                        <div className="related-title">{item.title}</div>
                        {item.contentPreview && (
                          <div className="related-preview">{item.contentPreview}</div>
                        )}
                        <div className="related-meta">
                          {item.linkType} · {Math.round(item.confidence * 100)}%
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Project CLAUDE.md */}
              {relatedData.projectClaudeMd && (
                <div className="related-group">
                  <h4 className="related-group-title">Project Instructions</h4>
                  <div className="related-item">
                    <span className="related-icon">📄</span>
                    <div className="related-info">
                      <div className="related-title">{relatedData.projectClaudeMd.title}</div>
                      <div className="related-preview">{relatedData.projectClaudeMd.contentPreview}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Project plans */}
              {relatedData.projectPlans.length > 0 && (
                <div className="related-group">
                  <h4 className="related-group-title">Plans ({relatedData.projectPlans.length})</h4>
                  {relatedData.projectPlans.map((plan) => (
                    <div key={plan.id} className="related-item">
                      <span className="related-icon">📋</span>
                      <div className="related-info">
                        <div className="related-title">{plan.title}</div>
                        {plan.contentPreview && (
                          <div className="related-preview">{plan.contentPreview}</div>
                        )}
                        <div className="related-meta">
                          {new Date(plan.mtime).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Sibling sessions in same project */}
              {relatedData.siblingSessionsInProject.length > 0 && (
                <div className="related-group">
                  <h4 className="related-group-title">
                    Other Sessions in Project ({relatedData.siblingSessionsInProject.length})
                  </h4>
                  {relatedData.siblingSessionsInProject.map((sib) => (
                    <div key={sib.sessionId} className="related-item related-item-clickable">
                      <span className="related-icon">💬</span>
                      <div className="related-info">
                        <div className="related-title">
                          {sib.firstPrompt || sib.sessionId.slice(0, 8)}
                        </div>
                        {sib.summary && (
                          <div className="related-preview">{sib.summary.slice(0, 150)}</div>
                        )}
                        <div className="related-meta">
                          {sib.sessionId.slice(0, 8)}... · {new Date(sib.modified).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Empty state if nothing at all */}
              {relatedData.links.length === 0 &&
               !relatedData.projectClaudeMd &&
               relatedData.projectPlans.length === 0 &&
               relatedData.siblingSessionsInProject.length === 0 && (
                <div className="empty">
                  <p>No related items found for this session.</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
