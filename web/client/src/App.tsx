/**
 * Main App component - 3-column layout with project browser.
 */

import React, { useState } from 'react';
import SearchBar from './components/SearchBar';
import ConversationViewer from './components/ConversationViewer';
import StatusWidget from './components/StatusWidget';
import MemoryExplorer from './components/MemoryExplorer';
import Dashboard from './components/Dashboard';
import ProjectSidebar from './components/ProjectSidebar';
import ToolTabs from './components/ToolTabs';
import {
  searchSessions,
  getConversation,
  getRecentSessions,
  type SearchResult,
  type Message,
  type SessionInfo,
} from './services/api';
import './App.css';

type ViewMode = 'search' | 'memory' | 'dashboard';

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('search');
  const [toolFilter, setToolFilter] = useState('');
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null);
  const [selectedSessionInfo, setSelectedSessionInfo] = useState<SessionInfo | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationLoading, setConversationLoading] = useState(false);

  const handleSearch = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    try {
      const results = await searchSessions(query, 50, selectedProject || undefined);
      setSearchResults(results);
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setSearchLoading(false);
    }
  };

  const handleProjectSelect = (project: string | null) => {
    setSelectedProject(project);
    // Clear search results when switching projects
    setSearchResults([]);
    setSelectedSession(null);
    setSelectedResult(null);
    setSelectedSessionInfo(null);
    setMessages([]);
  };

  const handleResultClick = async (sessionId: string) => {
    const result = searchResults.find((r) => r.sessionId === sessionId);
    setSelectedSession(sessionId);
    setSelectedResult(result || null);
    setMessages([]);

    if (!result) {
      try {
        const recentSessions = await getRecentSessions(100);
        const sessionInfo = recentSessions.find((s) => s.sessionId === sessionId);
        setSelectedSessionInfo(sessionInfo || null);
      } catch (error) {
        console.error('Failed to load session info:', error);
      }
    } else {
      setSelectedSessionInfo(null);
    }
  };

  const handleLoadFull = async () => {
    if (!selectedSession) return;
    setConversationLoading(true);
    try {
      const msgs = await getConversation(selectedSession);
      setMessages(msgs);
    } catch (error) {
      console.error('Failed to load conversation:', error);
    } finally {
      setConversationLoading(false);
    }
  };

  const handleCloseConversation = () => {
    setSelectedSession(null);
    setSelectedResult(null);
    setSelectedSessionInfo(null);
    setMessages([]);
  };

  const handleMemorySessionClick = (sessionId: string) => {
    setViewMode('search');
    handleResultClick(sessionId);
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-top">
          <h1 className="app-title">Chat Recall</h1>
          <nav className="app-nav">
            <button
              className={`nav-button ${viewMode === 'search' ? 'active' : ''}`}
              onClick={() => setViewMode('search')}
              data-testid="nav-search"
            >
              Conversations
            </button>
            <button
              className={`nav-button ${viewMode === 'memory' ? 'active' : ''}`}
              onClick={() => setViewMode('memory')}
              data-testid="nav-memory"
            >
              Memory
            </button>
            <button
              className={`nav-button ${viewMode === 'dashboard' ? 'active' : ''}`}
              onClick={() => setViewMode('dashboard')}
              data-testid="nav-dashboard"
            >
              Dashboard
            </button>
          </nav>
          <StatusWidget />
        </div>
        <div className="app-header-filters">
          <ToolTabs value={toolFilter} onChange={setToolFilter} />
        </div>
      </header>

      {viewMode === 'search' ? (
        <div className="search-layout" data-testid="search-layout">
          {/* Column 1: Project browser */}
          <ProjectSidebar
            selectedProject={selectedProject}
            onProjectSelect={handleProjectSelect}
          />

          {/* Column 2: Conversation list + search */}
          <div className="conversations-column">
            <SearchBar
              projectFilter={selectedProject}
              toolFilter={toolFilter}
              onSearch={handleSearch}
              onResultClick={handleResultClick}
              results={searchResults}
              loading={searchLoading}
              selectedSessionId={selectedSession}
            />
          </div>

          {/* Column 3: Conversation detail */}
          <div className={`conversation-column ${selectedSession ? 'visible' : 'hidden'}`}>
            {selectedSession && (
              <ConversationViewer
                sessionId={selectedSession}
                messages={messages}
                loading={conversationLoading}
                onClose={handleCloseConversation}
                onLoadFull={handleLoadFull}
                searchResult={selectedResult}
                sessionInfo={selectedSessionInfo}
              />
            )}
            {!selectedSession && (
              <div className="no-conversation" data-testid="no-conversation">
                <p>Select a conversation to view it</p>
              </div>
            )}
          </div>
        </div>
      ) : viewMode === 'memory' ? (
        <div className="memory-layout">
          <MemoryExplorer toolFilter={toolFilter} onSessionClick={handleMemorySessionClick} />
        </div>
      ) : (
        <div className="dashboard-layout">
          <Dashboard toolFilter={toolFilter} />
        </div>
      )}
    </div>
  );
}
