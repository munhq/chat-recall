/**
 * Memory Explorer - Browse all memory types with tabs and detail views.
 */

import React, { useState, useEffect } from 'react';
import type { SourceType, MemoryMetadataRow, MemoryLinkRow, MemorySearchResult } from '../services/api';
import { browseMemory, getMemoryLinks, searchMemory, getMemoryStatus, reindexMemory, updateItemProjectPath, type MemoryStatus } from '../services/api';
import './MemoryExplorer.css';

/** Shorten an absolute path for display — replaces home dir with ~ */
function shortenPath(path: string): string {
  // Detect home dir from the path itself (works for any user)
  const homeMatch = path.match(/^(\/home\/[^/]+|\/root|\/Users\/[^/]+)/);
  if (homeMatch) {
    return path.replace(homeMatch[1], '~');
  }
  return path;
}

const SOURCE_TYPES: { type: SourceType; label: string; icon: string }[] = [
  { type: 'session', label: 'Sessions', icon: '💬' },
  { type: 'plan', label: 'Plans', icon: '📋' },
  { type: 'task', label: 'Tasks', icon: '✅' },
  { type: 'claude_md', label: 'CLAUDE.md', icon: '📄' },
  { type: 'history', label: 'History', icon: '🕐' },
  { type: 'paste', label: 'Pastes', icon: '📎' },
];

interface MemoryExplorerProps {
  toolFilter: string;
  onSessionClick?: (sessionId: string) => void;
}

/** Extract folder/path information for display */
function getFolderInfo(item: MemoryMetadataRow): { prefix?: string; info?: string; fullPath?: string } {
  const filePath = item.file_path || '';

  // For CLAUDE.md files - show project folder name
  if (item.source_type === 'claude_md') {
    const match = filePath.match(/\/([^/]+)\/CLAUDE\.md$/);
    if (match) {
      const projectName = match[1];
      const parentPath = filePath.replace(/\/[^/]+\/CLAUDE\.md$/, '');
      const workOrPersonal = parentPath.split('/').pop() || 'project';
      return {
        prefix: projectName,
        info: `${workOrPersonal} project`,
        fullPath: parentPath
      };
    }
  }

  // For plans - show project and if it's an agent plan
  if (item.source_type === 'plan') {
    const agentMatch = item.id.match(/^(.+)-agent-([a-f0-9]+)$/);
    const isAgentPlan = !!agentMatch;
    const parentPlan = agentMatch?.[1];

    // Extract project name from project_path if available
    let projectInfo = '';
    let projectDisplay = '';
    if (item.project_path) {
      const projectName = item.project_path.split('/').pop();
      projectInfo = projectName || '';
      // Show shortened path
      projectDisplay = shortenPath(item.project_path);
    } else {
      projectDisplay = '~/.claude/plans/';
    }

    if (isAgentPlan) {
      return {
        prefix: projectInfo ? `${projectInfo} (agent)` : `${parentPlan} (agent)`,
        info: projectInfo ? projectDisplay : '~/.claude/plans/',
        fullPath: item.project_path || filePath
      };
    }

    return {
      prefix: projectInfo,
      info: projectDisplay,
      fullPath: item.project_path || filePath
    };
  }

  // For tasks - show session folder
  if (item.source_type === 'task') {
    const sessionIdMatch = filePath.match(/tasks\/([^/]+)\//);
    if (sessionIdMatch) {
      const sessionId = sessionIdMatch[1].slice(0, 8);
      return {
        info: `session: ${sessionId}...`,
        fullPath: filePath
      };
    }
  }

  // For sessions - show project name from project_path
  if (item.source_type === 'session' && item.project_path) {
    const projectName = item.project_path.split('/').pop();
    return {
      info: projectName,
      fullPath: item.project_path
    };
  }

  return {};
}

export default function MemoryExplorer({ toolFilter, onSessionClick }: MemoryExplorerProps) {
  const [activeType, setActiveType] = useState<SourceType>('plan');
  const [items, setItems] = useState<MemoryMetadataRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedItem, setSelectedItem] = useState<MemoryMetadataRow | null>(null);
  const [links, setLinks] = useState<MemoryLinkRow[]>([]);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MemorySearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [reindexing, setReindexing] = useState<Set<SourceType>>(new Set());
  const [reindexMessage, setReindexMessage] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [availableProjects, setAvailableProjects] = useState<string[]>([]);
  const [editingProject, setEditingProject] = useState(false);
  const [editProjectValue, setEditProjectValue] = useState('');

  // Load status on mount
  useEffect(() => {
    getMemoryStatus().then(setStatus).catch(console.error);
  }, []);

  // Load items when type changes
  useEffect(() => {
    setLoading(true);
    setSelectedItem(null);
    setLinks([]);
    setProjectFilter('all');
    browseMemory(activeType, 500)
      .then((fetchedItems) => {
        setItems(fetchedItems);

        // Extract unique projects
        const projects = new Set<string>();
        fetchedItems.forEach(item => {
          if (item.project_path) {
            // Extract project name from path
            const projectName = item.project_path.split('/').pop();
            if (projectName) projects.add(projectName);
          }
        });

        // Add "Unknown project" option if there are items without projects
        const hasUnknown = fetchedItems.some(item => !item.project_path);
        if (hasUnknown) {
          projects.add('(unknown)');
        }

        setAvailableProjects(Array.from(projects).sort());
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [activeType]);

  // Filter items by selected project
  // Apply tool filter first, then project filter
  const toolFilteredItems = toolFilter
    ? items.filter(item => {
        try {
          const extra = JSON.parse(item.extra_json || '{}');
          return (extra.tool || 'claude') === toolFilter;
        } catch { return toolFilter === 'claude'; }
      })
    : items;

  const filteredItems = projectFilter === 'all'
    ? toolFilteredItems
    : projectFilter === '(unknown)'
    ? toolFilteredItems.filter(item => !item.project_path)
    : toolFilteredItems.filter(item => {
        if (!item.project_path) return false;
        const projectName = item.project_path.split('/').pop();
        return projectName === projectFilter;
      });

  // Load links when item is selected
  useEffect(() => {
    if (selectedItem) {
      getMemoryLinks(selectedItem.source_type, selectedItem.id)
        .then(setLinks)
        .catch(console.error);
    }
  }, [selectedItem]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setSearching(true);
    try {
      const results = await searchMemory(searchQuery, 20);
      setSearchResults(results);
    } catch (err) {
      console.error('Memory search failed:', err);
    } finally {
      setSearching(false);
    }
  };

  const getTypeCount = (type: SourceType): number => {
    if (!status?.bySourceType?.[type]) return 0;
    return status.bySourceType[type].items;
  };

  const handleProjectUpdate = async () => {
    if (!selectedItem) return;

    try {
      await updateItemProjectPath(
        selectedItem.source_type,
        selectedItem.id,
        editProjectValue
      );

      // Update local state
      selectedItem.project_path = editProjectValue;
      setEditingProject(false);
      setReindexMessage(`✅ Project updated for ${selectedItem.id.slice(0, 20)}`);
      setTimeout(() => setReindexMessage(null), 3000);

      // Reload items to refresh the list
      const newItems = await browseMemory(activeType, 100);
      setItems(newItems);
    } catch (err) {
      setReindexMessage(`❌ Failed to update: ${err}`);
      setTimeout(() => setReindexMessage(null), 5000);
    }
  };

  const handleReindex = async (type: SourceType, force = false) => {
    setReindexing(prev => new Set(prev).add(type));
    setReindexMessage(`Reindexing ${type}...`);

    try {
      const result = await reindexMemory([type], force);
      setReindexMessage(
        `✅ ${type}: ${result.itemsProcessed} items, ${result.chunksAdded} chunks` +
        (result.errors > 0 ? ` (${result.errors} errors)` : '')
      );

      // Reload items and status
      const newStatus = await getMemoryStatus();
      setStatus(newStatus);

      if (activeType === type) {
        const newItems = await browseMemory(type, 100);
        setItems(newItems);
      }

      // Clear message after 3 seconds
      setTimeout(() => setReindexMessage(null), 3000);
    } catch (err) {
      setReindexMessage(`❌ Failed to reindex ${type}: ${err}`);
      setTimeout(() => setReindexMessage(null), 5000);
    } finally {
      setReindexing(prev => {
        const next = new Set(prev);
        next.delete(type);
        return next;
      });
    }
  };

  return (
    <div className="memory-explorer">
      <div className="memory-header">
        <h2>Memory Explorer</h2>
        {status && (
          <div className="memory-stats">
            <span>{status.totalItems} items</span>
            <span>{status.totalChunks} chunks</span>
            <span>{status.linkCount} links</span>
          </div>
        )}
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="memory-search-form">
        <input
          type="text"
          placeholder="Search across all memory types..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="memory-search-input"
        />
        <button type="submit" disabled={searching} className="memory-search-button">
          {searching ? 'Searching...' : 'Search'}
        </button>
      </form>

      {/* Search results */}
      {searchResults.length > 0 && (
        <div className="memory-search-results">
          <div className="memory-section-header">
            <span>Search results ({searchResults.length})</span>
            <button onClick={() => setSearchResults([])} className="clear-button">Clear</button>
          </div>
          <div className="memory-list">
            {searchResults.map((r, i) => (
              <div
                key={`${r.sourceType}-${r.itemId}-${i}`}
                className="memory-item"
                onClick={() => {
                  if (r.sourceType === 'session' && onSessionClick) {
                    onSessionClick(r.itemId);
                  }
                }}
              >
                <div className="memory-item-header">
                  <span className={`source-badge source-${r.sourceType}`}>
                    {SOURCE_TYPES.find(t => t.type === r.sourceType)?.icon} {r.sourceType}
                  </span>
                  <span className="memory-item-score">
                    {Math.round(r.score * 100)}%
                  </span>
                </div>
                <div className="memory-item-title">{r.title}</div>
                <div className="memory-item-preview">
                  {r.text.slice(0, 200)}{r.text.length > 200 ? '...' : ''}
                </div>
                {r.projectPath && (
                  <div className="memory-item-meta">
                    {shortenPath(r.projectPath)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reindex message */}
      {reindexMessage && (
        <div className="reindex-message">
          {reindexMessage}
        </div>
      )}

      {/* Type tabs */}
      <div className="memory-tabs">
        {SOURCE_TYPES.map(({ type, label, icon }) => (
          <div key={type} className="memory-tab-container">
            <button
              className={`memory-tab ${activeType === type ? 'active' : ''}`}
              onClick={() => setActiveType(type)}
            >
              {icon} {label}
              <span className="tab-count">{getTypeCount(type)}</span>
            </button>
            <button
              className="reindex-button"
              onClick={(e) => {
                e.stopPropagation();
                handleReindex(type, false);
              }}
              disabled={reindexing.has(type)}
              title={`Reindex ${type} (incremental)`}
            >
              {reindexing.has(type) ? '⏳' : '🔄'}
            </button>
          </div>
        ))}
      </div>


      {/* Project filter (for types that have projects) */}
      {(activeType === 'plan' || activeType === 'claude_md' || activeType === 'session') && availableProjects.length > 0 && (
        <div className="project-filter">
          <label htmlFor="project-select">
            📁 Filter by project:
          </label>
          <select
            id="project-select"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="project-select"
          >
            <option value="all">All projects ({items.length})</option>
            {availableProjects.map(project => {
              const count = project === '(unknown)'
                ? items.filter(item => !item.project_path).length
                : items.filter(item => {
                    const itemProject = item.project_path?.split('/').pop();
                    return itemProject === project;
                  }).length;
              return (
                <option key={project} value={project}>
                  {project} ({count})
                </option>
              );
            })}
          </select>
        </div>
      )}

      {/* Content area */}
      <div className="memory-content">
        {/* Items list */}
        <div className="memory-list-panel">
          {loading ? (
            <div className="memory-loading">Loading...</div>
          ) : items.length === 0 ? (
            <div className="memory-empty">
              No {activeType} items indexed yet.
              <br />
              Run <code>chat-recall memory index</code> to index.
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="memory-empty">
              No items match the selected project filter.
            </div>
          ) : (
            <div className="memory-list">
              {filteredItems.map((item) => {
                // Extract folder info for better display
                const folderInfo = getFolderInfo(item);

                return (
                  <div
                    key={`${item.source_type}-${item.id}`}
                    className={`memory-item ${selectedItem?.id === item.id ? 'selected' : ''}`}
                    onClick={() => setSelectedItem(item)}
                  >
                    <div className="memory-item-title">
                      {folderInfo.prefix && (
                        <span className="folder-badge" title={folderInfo.fullPath}>
                          📁 {folderInfo.prefix}
                        </span>
                      )}
                      {item.title}
                    </div>
                    <div className="memory-item-preview">
                      {item.content_preview?.slice(0, 150)}{(item.content_preview?.length || 0) > 150 ? '...' : ''}
                    </div>
                    <div className="memory-item-meta">
                      {new Date(item.mtime).toLocaleDateString()}
                      {folderInfo.info && (
                        <span className="folder-meta"> | {folderInfo.info}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedItem && (
          <div className="memory-detail-panel">
            <h3>{selectedItem.title}</h3>
            <div className="detail-meta">
              <span><strong>Type:</strong> {selectedItem.source_type}</span>
              <span><strong>ID:</strong> {selectedItem.id.slice(0, 20)}{selectedItem.id.length > 20 ? '...' : ''}</span>
              <span><strong>Modified:</strong> {new Date(selectedItem.mtime).toLocaleString()}</span>
              {selectedItem.file_path && (
                <span><strong>File:</strong> <code>{selectedItem.file_path}</code></span>
              )}
              {selectedItem.source_type === 'claude_md' && selectedItem.project_path && (
                <span><strong>Project Dir:</strong> <code>{selectedItem.project_path}</code></span>
              )}
              {selectedItem.source_type === 'plan' && (
                <>
                  {selectedItem.id.includes('-agent-') ? (
                    <span><strong>Type:</strong> Agent plan (sub-plan)</span>
                  ) : (
                    <span><strong>Type:</strong> Main plan</span>
                  )}
                  <span><strong>Location:</strong> ~/.claude/plans/</span>
                  <div className="project-edit-section">
                    <strong>Project:</strong>{' '}
                    {editingProject ? (
                      <div className="project-edit-controls">
                        <input
                          type="text"
                          value={editProjectValue}
                          onChange={(e) => setEditProjectValue(e.target.value)}
                          placeholder="/path/to/your/project"
                          className="project-edit-input"
                        />
                        <button onClick={handleProjectUpdate} className="project-save-btn">
                          ✓ Save
                        </button>
                        <button onClick={() => setEditingProject(false)} className="project-cancel-btn">
                          ✕ Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="project-display">
                        <code>{selectedItem.project_path || '(not set)'}</code>
                        <button
                          onClick={() => {
                            setEditingProject(true);
                            setEditProjectValue(selectedItem.project_path || '');
                          }}
                          className="project-edit-btn"
                          title="Edit project path"
                        >
                          ✏️ Edit
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
              {selectedItem.source_type === 'task' && (
                <span><strong>Location:</strong> ~/.claude/tasks/{selectedItem.id}/</span>
              )}
            </div>

            {selectedItem.content_preview && (
              <div className="detail-preview">
                <h4>Preview</h4>
                <pre>{selectedItem.content_preview}</pre>
              </div>
            )}

            {selectedItem.source_type === 'session' && onSessionClick && (
              <button
                className="detail-action-button"
                onClick={() => onSessionClick(selectedItem.id)}
              >
                View Conversation
              </button>
            )}

            {/* Links */}
            {links.length > 0 && (
              <div className="detail-links">
                <h4>Related ({links.length})</h4>
                {links.map((link) => {
                  const isOutgoing = link.source_id === selectedItem.id;
                  const otherType = isOutgoing ? link.target_type : link.source_type;
                  const otherId = isOutgoing ? link.target_id : link.source_id;
                  const confidence = Math.round(link.confidence * 100);

                  return (
                    <div key={link.id} className="link-item">
                      <span className={`source-badge source-${otherType}`}>
                        {SOURCE_TYPES.find(t => t.type === otherType)?.icon} {otherType}
                      </span>
                      <span className="link-id">{otherId.slice(0, 16)}...</span>
                      <span className="link-type">{link.link_type}</span>
                      <span className="link-confidence">{confidence}%</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
