/**
 * Main App component — v2 design system rebuild.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import ConversationList from './components/ConversationList';
import ConversationViewer from './components/ConversationViewer';
import MemoryExplorer from './components/MemoryExplorer';
import ToolkitExplorer from './components/ToolkitExplorer';
import Dashboard from './components/Dashboard';
import ActivityTimeline from './components/ActivityTimeline';
import SettingsPage from './components/SettingsPage';
import { SidebarExtrasProvider, useSidebarExtras } from './context/sidebar-extras';
import {
  getStatus,
  getRecentSessionsPage,
  getConversationWithSubagents,
  searchSessions,
  type SessionInfo,
  type SearchResult,
  type Subagent,
} from './services/api';

type ViewMode = 'search' | 'memory' | 'toolkit' | 'dashboard' | 'activity' | 'settings';

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
  return (
    <SidebarExtrasProvider>
      <AppInner />
    </SidebarExtrasProvider>
  );
}

function AppInner() {
  const sidebarExtras = useSidebarExtras();
  const [view, setView] = useState<ViewMode>('search');
  const [toolFilter, setToolFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sort, setSort] = useState('recent');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  const [projectTree, setProjectTree] = useState<ProjectTreeNode[]>([]);
  const [totalProjectCount, setTotalProjectCount] = useState(0);
  // When in Activity view, the tree shows only projects with edits in the
  // current window — fed by ActivityTimeline → onActiveProjects → here.
  // Reset to null when leaving the Activity view so the all-time tree
  // returns. `null` (not `{}`) distinguishes "haven't received an update
  // yet" from "received an empty set" (no recent activity).
  const [activeProjectsForView, setActiveProjectsForView] = useState<Record<string, number> | null>(null);
  const [recentSessions, setRecentSessions] = useState<SessionInfo[]>([]);
  // Pagination state — drives the "load more" trigger in ConversationList.
  const [recentTotal, setRecentTotal] = useState(0);
  const [recentHasMore, setRecentHasMore] = useState(false);
  const [recentLoadingMore, setRecentLoadingMore] = useState(false);
  // Distinct from `recentLoadingMore`: true while the FIRST page (or a
  // refetch after filter change) is in flight. Drives the skeleton
  // shimmer state in ConversationList — without it the list is blank
  // for the cold 1-2s walk and the user thinks the app broke.
  const [recentLoadingFirstPage, setRecentLoadingFirstPage] = useState(true);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  const [conversationLoading, setConversationLoading] = useState(false);

  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null);
  const [selectedSessionInfo, setSelectedSessionInfo] = useState<SessionInfo | null>(null);

  // Build the project tree from status. LCP-strip + collapse-transparent-chains
  // gives a sensible hierarchy on any OS without hardcoded path depths.
  // Static all-time tree from getStatus — used everywhere except Activity.
  const [allTimeTree, setAllTimeTree] = useState<ProjectTreeNode[]>([]);
  const [allTimeTotal, setAllTimeTotal] = useState(0);
  useEffect(() => {
    getStatus()
      .then((stats) => {
        const tree = buildProjectTree(stats.projects);
        setAllTimeTree(tree);
        setAllTimeTotal(tree.reduce((s, n) => s + n.totalCount, 0));
      })
      .catch(console.error);
  }, []);

  // Reset the active-window tree whenever the user leaves the Activity
  // view, so re-entering it re-fetches a fresh window.
  useEffect(() => {
    if (view !== 'activity') setActiveProjectsForView(null);
  }, [view]);

  // Pick which tree to show: window-scoped while in Activity, all-time
  // otherwise. The active tree's counts represent edits-in-window.
  useEffect(() => {
    if (view === 'activity' && activeProjectsForView) {
      const tree = buildProjectTree(activeProjectsForView);
      setProjectTree(tree);
      setTotalProjectCount(tree.reduce((s, n) => s + n.totalCount, 0));
    } else {
      setProjectTree(allTimeTree);
      setTotalProjectCount(allTimeTotal);
    }
  }, [view, activeProjectsForView, allTimeTree, allTimeTotal]);

  // Keyboard shortcut for search (Cmd/Ctrl + K) and Escape-to-close
  // for the mobile drawer (matches modal/dialog conventions).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Escape' && mobileSidebarOpen) {
        setMobileSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mobileSidebarOpen]);

  // Load first page of recent sessions when filters change.
  // Page size 20 fills the viewport. The user can scroll to trigger
  // `loadMoreRecent` for the next page (server-side pagination — no walk
  // for un-shown rows).
  // Page size: 20 fills the viewport. Server caches the index for 30s so
  // any subsequent page within that window is essentially free.
  const PAGE_SIZE = 20;
  // Eager prefetch: after the first page lands, kick off the next pages
  // automatically (without waiting for scroll) up to this cap. With the
  // server-side index cache + persistent badge cache, fetching pages
  // 2-5 costs ~50ms each, so we do them up-front. Keeps the user from
  // hitting "load more" mid-scroll. Cap at 5 pages × 20 = 100 rows so we
  // don't pull thousands into the DOM.
  const PREFETCH_PAGES = 4;
  useEffect(() => {
    let cancelled = false;
    setRecentLoadingFirstPage(true);

    const opts = {
      limit: PAGE_SIZE,
      projectFilter: projectFilter || undefined,
      toolFilter: toolFilter === 'all' ? undefined : toolFilter,
    };

    // Page 1 first — show as soon as it arrives.
    getRecentSessionsPage({ ...opts, offset: 0 })
      .then(async (page) => {
        if (cancelled) return;
        setRecentSessions(page.sessions);
        setRecentTotal(page.total);
        setRecentHasMore(page.hasMore);
        setSearchResults([]);
        setRecentLoadingFirstPage(false);

        // Prefetch the next pages eagerly so scrolling feels instant.
        // Each completes before the next so we don't slam the server with
        // parallel requests; the in-process index cache makes them fast.
        let offset = page.sessions.length;
        let hasMore = page.hasMore;
        for (let i = 0; i < PREFETCH_PAGES && hasMore && !cancelled; i++) {
          try {
            const next = await getRecentSessionsPage({ ...opts, offset });
            if (cancelled) return;
            // De-dupe by id — server-side mtime sort can shift slightly
            // between requests if a session was just modified.
            setRecentSessions((prev) => {
              const seen = new Set(prev.map((s) => s.sessionId));
              return [...prev, ...next.sessions.filter((s) => !seen.has(s.sessionId))];
            });
            setRecentTotal(next.total);
            setRecentHasMore(next.hasMore);
            offset += next.sessions.length;
            hasMore = next.hasMore;
            if (next.sessions.length === 0) break;
          } catch (err) {
            console.error('prefetch page failed:', err);
            break;
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error(err);
          setRecentLoadingFirstPage(false);
        }
      });

    return () => { cancelled = true; };
  }, [projectFilter, toolFilter]);

  // Load the next page of recent sessions. Driven by the
  // ConversationList's bottom-of-list intersection observer.
  const loadMoreRecent = useCallback(async () => {
    if (recentLoadingMore || !recentHasMore) return;
    setRecentLoadingMore(true);
    try {
      const page = await getRecentSessionsPage({
        limit: PAGE_SIZE,
        offset: recentSessions.length,
        projectFilter: projectFilter || undefined,
        toolFilter: toolFilter === 'all' ? undefined : toolFilter,
      });
      // Concat-only — never re-shuffle existing rows. If the index changed
      // server-side between page 1 and page 2 you may briefly see a
      // duplicate, but the dedupe-on-id below covers that.
      setRecentSessions((prev) => {
        const seen = new Set(prev.map(s => s.sessionId));
        return [...prev, ...page.sessions.filter(s => !seen.has(s.sessionId))];
      });
      setRecentHasMore(page.hasMore);
      setRecentTotal(page.total);
    } catch (err) {
      console.error('loadMoreRecent failed:', err);
    } finally {
      setRecentLoadingMore(false);
    }
  }, [recentLoadingMore, recentHasMore, recentSessions.length, projectFilter, toolFilter]);

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

  // Default sort follows search state: relevance when searching, recent when
  // browsing. Only flips on transition so the user can override mid-search
  // (clicking "Recent" while a query is active won't get clobbered until they
  // clear the query and start a new one).
  const prevHadQuery = useRef(false);
  useEffect(() => {
    const hasQuery = !!query.trim();
    if (hasQuery && !prevHadQuery.current) setSort('rel');
    else if (!hasQuery && prevHadQuery.current) setSort('recent');
    prevHadQuery.current = hasQuery;
  }, [query]);

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

  // Close the drawer whenever the user picks a project, switches views,
  // or otherwise navigates — otherwise the drawer stays open masking the
  // result of their action on mobile.
  const closeMobileSidebar = useCallback(() => setMobileSidebarOpen(false), []);
  const handleSidebarSelectProject = useCallback((p: string | null) => {
    setProjectFilter(p);
    setMobileSidebarOpen(false);
  }, []);
  const handleSidebarSelectTool = useCallback((t: string) => {
    setToolFilter(t);
    setMobileSidebarOpen(false);
  }, []);
  const handleSidebarSelectView = useCallback((v: ViewMode) => {
    setView(v);
    setMobileSidebarOpen(false);
  }, []);

  return (
    <div
      className="app"
      data-mobile-sidebar-open={mobileSidebarOpen ? 'true' : undefined}
      data-has-selection={view === 'search' && selectedSessionId ? 'true' : undefined}
    >
      <TopBar
        view={view}
        setView={setView}
        query={query}
        setQuery={setQuery}
        searchRef={searchRef}
        onSearch={handleSearch}
        onMobileMenu={() => setMobileSidebarOpen((v) => !v)}
        mobileSidebarOpen={mobileSidebarOpen}
      />
      {/*
       * Settings has its own full-width chrome. Every other view shares the
       * left sidebar (Source filter + Project tree) so the tool/project
       * filtering UX stays identical across Conversations / Memory /
       * Toolkit / Activity / Insights.
       */}
      {view === 'settings' ? (
        <div className="app-row">
          <SettingsPage onClose={() => setView('search')} />
        </div>
      ) : (
        <div className="app-row" data-testid="app-layout">
          <div
            className="cr-mobile-backdrop"
            onClick={closeMobileSidebar}
            aria-hidden="true"
          />
          <Sidebar
            tree={projectTree}
            totalCount={totalProjectCount}
            selected={projectFilter}
            onSelect={handleSidebarSelectProject}
            toolFilter={toolFilter}
            setToolFilter={handleSidebarSelectTool}
            /* Wrap each row's onClick so view-injected filters
             * (Memory's Type, Activity's Window, …) close the
             * mobile drawer just like the built-in rows do. */
            extraSections={sidebarExtras.map((sec) => ({
              ...sec,
              rows: sec.rows.map((row) => ({
                ...row,
                onClick: () => { row.onClick(); closeMobileSidebar(); },
              })),
            }))}
            view={view}
            setView={handleSidebarSelectView}
          />

          {view === 'search' && (
            <>
              <ConversationList
                results={displayedSessions}
                selected={selectedSessionId}
                onSelect={handleSelectSession}
                sort={sort}
                setSort={setSort}
                hasMore={!query.trim() && recentHasMore}
                loadingMore={recentLoadingMore}
                total={recentTotal}
                onLoadMore={loadMoreRecent}
                /* Skeletons only when there are no rows yet AND the first
                   page is still in flight; otherwise we'd flash skeletons
                   over an already-populated list during a refilter. */
                loading={recentLoadingFirstPage && !query.trim()}
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
            </>
          )}
          {view === 'memory' && (
            <MemoryExplorer
              onSessionClick={handleMemorySessionClick}
              toolFilter={toolFilter}
              projectFilter={projectFilter}
            />
          )}
          {view === 'toolkit' && (
            <ToolkitExplorer
              toolFilter={toolFilter}
            />
          )}
          {view === 'dashboard' && (
            <Dashboard
              onJumpToSession={handleMemorySessionClick}
              onJumpToSearch={(q) => { setQuery(q); setView('search'); }}
              toolFilter={toolFilter}
            />
          )}
          {view === 'activity' && (
            <ActivityTimeline
              onSessionClick={handleMemorySessionClick}
              toolFilter={toolFilter}
              projectFilter={projectFilter}
              onActiveProjects={setActiveProjectsForView}
            />
          )}
        </div>
      )}
    </div>
  );
}
