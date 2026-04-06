/**
 * Search bar component for conversation search and browsing.
 * Project selection is handled by the parent (ProjectSidebar).
 */

import React, { useState, useEffect } from 'react';
import type { SearchResult, SessionInfo } from '../services/api';
import { getRecentSessions } from '../services/api';
import './SearchBar.css';

function getShortSummary(summary: string, maxLength: number = 150): string {
  if (!summary) return '';

  const requestMatch = summary.match(/\*\*Request:\*\*\s*-?\s*([^\n*]+)/i);
  if (requestMatch && requestMatch[1]) {
    const request = requestMatch[1].trim();
    return request.length <= maxLength ? request : request.substring(0, maxLength) + '...';
  }

  const firstLine = summary.split('\n')[0].replace(/^\*\*[^*]+\*\*:?\s*-?\s*/, '');
  return firstLine.length <= maxLength ? firstLine : firstLine.substring(0, maxLength) + '...';
}

function formatPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return path;
}

interface SearchBarProps {
  projectFilter: string | null;
  toolFilter: string;
  onSearch: (query: string) => void;
  onResultClick: (sessionId: string) => void;
  results: SearchResult[];
  loading: boolean;
  selectedSessionId: string | null;
}

export default function SearchBar({
  projectFilter,
  toolFilter,
  onSearch,
  onResultClick,
  results,
  loading,
  selectedSessionId,
}: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [recentSessions, setRecentSessions] = useState<SessionInfo[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Reload recent sessions when project or tool filter changes
  useEffect(() => {
    setRecentLoading(true);
    setRecentError(null);
    getRecentSessions(50, projectFilter || undefined, toolFilter || undefined)
      .then(setRecentSessions)
      .catch((err) => setRecentError(err.message || 'Failed to load'))
      .finally(() => setRecentLoading(false));
  }, [projectFilter, toolFilter]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      onSearch(query.trim());
    }
  };

  const handleClear = () => {
    setQuery('');
    onSearch('');
  };

  // Filter results by date range
  const filteredResults = results.filter((r) => {
    if (projectFilter && !r.projectPath.includes(projectFilter)) return false;
    if (startDate || endDate) {
      const resultDate = new Date(r.modified);
      if (startDate && resultDate < new Date(startDate)) return false;
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        if (resultDate > end) return false;
      }
    }
    return true;
  });

  const showRecent = results.length === 0 && !loading;
  const showResults = results.length > 0;

  return (
    <div className="search-bar">
      <form onSubmit={handleSubmit} className="search-form">
        <div className="search-input-wrapper">
          <input
            type="text"
            placeholder={projectFilter ? `Search in ${formatPath(projectFilter)}...` : 'Search all conversations...'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="search-input"
            data-testid="search-input"
          />
          {query && (
            <button type="button" className="search-clear" onClick={handleClear} title="Clear search">
              ×
            </button>
          )}
        </div>
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="date-filter"
          title="From date"
        />
        <input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="date-filter"
          title="To date"
        />
        <button type="submit" disabled={loading || !query.trim()} className="search-button" data-testid="search-button">
          {loading ? '...' : 'Search'}
        </button>
      </form>

      {showRecent && (
        <div className="search-results" data-testid="recent-sessions">
          <div className="results-header">
            <span>
              {recentLoading
                ? 'Loading...'
                : recentError
                ? <span className="results-error">⚠ {recentError}</span>
                : `Recent (${recentSessions.length})`}
              {!recentLoading && !recentError && projectFilter && (
                <span className="results-project-label"> · {formatPath(projectFilter)}</span>
              )}
            </span>
          </div>
          <div className="results-list">
            {recentSessions.map((session) => (
              <div
                key={session.sessionId}
                className={`search-result ${selectedSessionId === session.sessionId ? 'selected' : ''}`}
                onClick={() => onResultClick(session.sessionId)}
                data-testid="session-item"
              >
                <div className="result-header">
                  <span className="result-project">
                    {session.tool && session.tool !== 'claude' && (
                      <span className={`tool-badge tool-${session.tool}`}>{session.tool}</span>
                    )}
                    {formatPath(session.projectPath)}
                  </span>
                  <span className="result-date">{new Date(session.modified).toLocaleDateString()}</span>
                </div>
                <div className="result-text">
                  {session.summary
                    ? getShortSummary(session.summary)
                    : session.firstPrompt?.substring(0, 150) +
                      (session.firstPrompt && session.firstPrompt.length > 150 ? '...' : '') ||
                      `Session ${session.sessionId.substring(0, 8)}...`}
                </div>
                <div className="result-meta">
                  <span>{new Date(session.modified).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showResults && (
        <div className="search-results" data-testid="search-results">
          <div className="results-header">
            <span>
              {filteredResults.length} result{filteredResults.length !== 1 ? 's' : ''}
              {results.length !== filteredResults.length && ` (filtered from ${results.length})`}
            </span>
            {filteredResults.length > 0 && (
              <button className="clear-results-btn" onClick={handleClear}>
                Clear
              </button>
            )}
          </div>
          <div className="results-list">
            {filteredResults.map((result, idx) => (
              <div
                key={result.sessionId}
                className={`search-result ${selectedSessionId === result.sessionId ? 'selected' : ''}`}
                onClick={() => onResultClick(result.sessionId)}
                data-testid="search-result-item"
              >
                <div className="result-header">
                  <span className="result-project">{formatPath(result.projectPath)}</span>
                  <span className="result-rank">#{idx + 1}</span>
                </div>
                <div className="result-text">
                  {result.summary
                    ? getShortSummary(result.summary)
                    : result.text.substring(0, 150) + (result.text.length > 150 ? '...' : '')}
                </div>
                <div className="result-meta">
                  <span>{new Date(result.modified).toLocaleDateString()}</span>
                  <span className="result-type">{result.chunkType}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
