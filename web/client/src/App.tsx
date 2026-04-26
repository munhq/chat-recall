/**
 * Main App component — v2 design system rebuild.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import ConversationList from './components/ConversationList';
import ConversationViewer from './components/ConversationViewer';
import MemoryExplorer from './components/MemoryExplorer';
import Dashboard from './components/Dashboard';
import {
  getStatus,
  getRecentSessions,
  getConversationWithSubagents,
  searchSessions,
  type SessionInfo,
  type SearchResult,
  type Subagent,
} from './services/api';

type ViewMode = 'search' | 'memory' | 'dashboard';

/**
 * Recursive tree node used by the project sidebar. One node renders as
 * one row; `children` nest below it. A node with `count > 0` represents
 * a project directly at that path; an inner folder may also have
 * `count > 0` if sessions exist exactly at that path.
 */
export interface ProjectTreeNode {
  name: string;       // display label (may include "/" from collapsed chains)
  fullPath: string;   // absolute path used for filtering
  count: number;      // sessions directly at this path
  totalCount: number; // count + sum of descendants
  children: ProjectTreeNode[];
}

// Mirror of server-side normalizeProjectPath. Kept local so the client
// has no cross-build dependency on the server package.
function normalizeProjectPath(p: string | null | undefined): string {
  if (!p) return '';
  let n = String(p).trim();
  if (!n) return '';
  n = n.replace(/\\/g, '/');
  n = n.replace(/\/+/g, '/');
  if (n.length > 1) n = n.replace(/\/+$/, '');
  return n;
}

interface TrieNode {
  name: string;
  fullPath: string;
  count: number;
  isProject: boolean;
  children: Map<string, TrieNode>;
}

function buildTrie(projects: Record<string, number>): TrieNode {
  const root: TrieNode = {
    name: '',
    fullPath: '',
    count: 0,
    isProject: false,
    children: new Map(),
  };
  for (const [rawPath, count] of Object.entries(projects)) {
    const path = normalizeProjectPath(rawPath);
    if (!path) continue;
    const segs = path.split('/').filter(Boolean);
    if (segs.length === 0) continue;
    let cur = root;
    let acc = '';
    for (const seg of segs) {
      acc = acc + '/' + seg;
      let child = cur.children.get(seg);
      if (!child) {
        child = { name: seg, fullPath: acc, count: 0, isProject: false, children: new Map() };
        cur.children.set(seg, child);
      }
      cur = child;
    }
    cur.count += count;
    cur.isProject = true;
  }
  return root;
}

/**
 * LCP-strip: walk down from the synthetic root while we have exactly one
 * child that is not itself a project. This strips shared structural
 * prefixes like /home/<user>/code without hardcoding any path.
 *
 * Returns the set of top-level nodes to render. If every project shares
 * a single deep path (one-project case), returns that project as a
 * single-element array.
 */
function findTopLevel(root: TrieNode): TrieNode[] {
  let cur = root;
  while (!cur.isProject && cur.children.size === 1) {
    cur = cur.children.values().next().value!;
  }
  if (cur.isProject) return [cur];
  return Array.from(cur.children.values());
}

/**
 * Convert a TrieNode subtree into a ProjectTreeNode, collapsing any
 * transparent chain (single child + no own sessions) into the display
 * name of its descendant — so /foo/bar/baz with no projects above baz
 * renders as a single "foo/bar/baz" leaf rather than three nested rows.
 */
function toTreeNode(node: TrieNode, namePrefix = ''): ProjectTreeNode {
  const myName = namePrefix ? namePrefix + '/' + node.name : node.name;

  if (node.children.size === 1 && !node.isProject) {
    const only = node.children.values().next().value!;
    return toTreeNode(only, myName);
  }

  // Folders first, then leaf discussions. Alphabetic within each group.
  const children = Array.from(node.children.values())
    .map((c) => toTreeNode(c))
    .sort(compareTreeNodes);

  const totalCount = node.count + children.reduce((s, c) => s + c.totalCount, 0);

  return {
    name: myName,
    fullPath: node.fullPath,
    count: node.count,
    totalCount,
    children,
  };
}

function compareTreeNodes(a: ProjectTreeNode, b: ProjectTreeNode): number {
  const aIsFolder = a.children.length > 0;
  const bIsFolder = b.children.length > 0;
  if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

export function buildProjectTree(projects: Record<string, number>): ProjectTreeNode[] {
  const trie = buildTrie(projects);
  return findTopLevel(trie)
    .map((n) => toTreeNode(n))
    .sort(compareTreeNodes);
}

export default function App() {
  const [view, setView] = useState<ViewMode>('search');
  const [toolFilter, setToolFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sort, setSort] = useState('recent');

  const searchRef = useRef<HTMLInputElement>(null);

  const [projectTree, setProjectTree] = useState<ProjectTreeNode[]>([]);
  const [totalProjectCount, setTotalProjectCount] = useState(0);
  const [recentSessions, setRecentSessions] = useState<SessionInfo[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  const [conversationLoading, setConversationLoading] = useState(false);

  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null);
  const [selectedSessionInfo, setSelectedSessionInfo] = useState<SessionInfo | null>(null);

  // Build the project tree from status. LCP-strip + collapse-transparent-chains
  // gives a sensible hierarchy on any OS without hardcoded path depths.
  useEffect(() => {
    getStatus()
      .then((stats) => {
        const tree = buildProjectTree(stats.projects);
        setProjectTree(tree);
        setTotalProjectCount(tree.reduce((s, n) => s + n.totalCount, 0));
      })
      .catch(console.error);
  }, []);

  // Keyboard shortcut for search (Cmd/Ctrl + K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Load recent sessions when filters change
  useEffect(() => {
    getRecentSessions(50, projectFilter || undefined, toolFilter === 'all' ? undefined : toolFilter)
      .then((sessions) => {
        setRecentSessions(sessions);
        setSearchResults([]);
      })
      .catch(console.error);
  }, [projectFilter, toolFilter]);

  const handleSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setSearchResults([]);
        return;
      }
      try {
        const results = await searchSessions(q, 50, projectFilter || undefined);
        setSearchResults(results);
      } catch (err) {
        console.error('Search failed:', err);
      }
    },
    [projectFilter]
  );

  // Debounced search when query changes
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim()) {
        handleSearch(query);
      } else {
        setSearchResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, handleSearch]);

  const handleSelectSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    setMessages([]);
    setSubagents([]);
    // Find session info
    const info = recentSessions.find((s) => s.sessionId === sessionId) || null;
    setSelectedSessionInfo(info);
    const result = searchResults.find((r) => r.sessionId === sessionId) || null;
    setSelectedResult(result);
  }, [recentSessions, searchResults]);

  const handleLoadFull = useCallback(async () => {
    if (!selectedSessionId) return;
    setConversationLoading(true);
    try {
      const { messages: msgs, subagents: subs } = await getConversationWithSubagents(selectedSessionId);
      setMessages(msgs);
      setSubagents(subs);
    } catch (err) {
      console.error('Failed to load conversation:', err);
    } finally {
      setConversationLoading(false);
    }
  }, [selectedSessionId]);

  const handleCloseConversation = useCallback(() => {
    setSelectedSessionId(null);
    setSelectedResult(null);
    setSelectedSessionInfo(null);
    setMessages([]);
    setSubagents([]);
  }, []);

  const handleMemorySessionClick = useCallback((sessionId: string) => {
    setView('search');
    handleSelectSession(sessionId);
  }, [handleSelectSession]);

  const displayedSessions: SessionInfo[] = useMemo(() => {
    if (searchResults.length > 0) {
      return searchResults.map((r) => ({
        sessionId: r.sessionId,
        projectPath: r.projectPath,
        modified: r.modified,
        firstPrompt: r.firstPrompt,
        summary: r.summary,
        tool: '',
        created: r.created,
        filePath: '',
        score: r.score,
      } as SessionInfo & { score?: number }));
    }
    return recentSessions;
  }, [searchResults, recentSessions]);

  return (
    <div className="app">
      <TopBar 
        view={view} 
        setView={setView} 
        query={query} 
        setQuery={setQuery} 
        searchRef={searchRef}
        onSearch={handleSearch}
      />
      {view === 'search' && (
        <div className="app-row" data-testid="search-layout">
          <Sidebar
            tree={projectTree}
            totalCount={totalProjectCount}
            selected={projectFilter}
            onSelect={setProjectFilter}
            toolFilter={toolFilter}
            setToolFilter={setToolFilter}
          />
          <ConversationList
            results={displayedSessions}
            selected={selectedSessionId}
            onSelect={handleSelectSession}
            sort={sort}
            setSort={setSort}
          />
          <ConversationViewer
            sessionId={selectedSessionId}
            messages={messages}
            subagents={subagents}
            loading={conversationLoading}
            onClose={handleCloseConversation}
            onLoadFull={handleLoadFull}
            searchResult={selectedResult}
            sessionInfo={selectedSessionInfo}
          />
        </div>
      )}
      {view === 'memory' && (
        <div className="app-row">
          <MemoryExplorer
            onSessionClick={handleMemorySessionClick}
          />
        </div>
      )}
      {view === 'dashboard' && (
        <div className="app-row">
          <Dashboard />
        </div>
      )}
    </div>
  );
}
