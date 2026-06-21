/**
 * Main App component — v2 design system rebuild.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import ConversationList from './components/ConversationList';
import ConversationViewer from './components/ConversationViewer';
import MemoryExplorer, { MemoryDetail } from './components/MemoryExplorer';
import ToolkitExplorer from './components/ToolkitExplorer';
import Dashboard from './components/Dashboard';
import ActivityTimeline from './components/ActivityTimeline';
import SecurityExplorer from './components/SecurityExplorer';
import SettingsPage from './components/SettingsPage';
import AccountPage, { SubscribeScreen } from './components/AccountPage';
import SecuritySummaryBanner from './components/SecuritySummaryBanner';
import ProjectMainPane from './components/ProjectMainPane';
import { SidebarExtrasProvider, useSidebarExtras } from './context/sidebar-extras';
import { isCloud } from './services/auth';
import {
  getStatus,
  getRecentSessionsPage,
  getConversationWithSubagents,
  searchSessions,
  getProjectTree,
  getMemoryItem,
  getCapabilities,
  getEntitlement,
  type ServerCapabilities,
  type SessionInfo,
  type SearchResult,
  type MemoryHit,
  type MemoryMetadataRow,
  type Subagent,
  type ProjectTreeApiNode,
} from './services/api';

type ViewMode = 'search' | 'memory' | 'toolkit' | 'dashboard' | 'activity' | 'security' | 'settings' | 'account';

/**
 * Recursive tree node used by the project sidebar. One node renders as
 * one row; `children` nest below it. A node with `count > 0` represents
 * a project directly at that path; an inner folder may also have
 * `count > 0` if sessions exist exactly at that path.
 */
/**
 * Sidebar tree node. `fullPath` is the filter key — it's now a
 * `project_id` (e.g. `git:github.com/me/repo`, `ws:personal`,
 * `untracked:all`) rather than a filesystem path. Kept under the
 * `fullPath` name so the existing Sidebar/onSelect plumbing keeps
 * working without churning every prop.
 */
export interface ProjectTreeNode {
  name: string;
  fullPath: string;
  count: number;
  totalCount: number;
  children: ProjectTreeNode[];
  /** True when this node groups other projects (visual hint, not selectable). */
  workspace?: boolean;
  /** True when the underlying folder no longer exists on disk. */
  orphan?: boolean;
  /** Resolver source tag for icon/coloring (git-remote, auto-workspace, path, …). */
  source?: string;
}

/**
 * Convert the server's /api/projects/tree response into the client's
 * ProjectTreeNode shape. The server already does grouping (workspaces →
 * projects → untracked footer) and orphan detection; we only adapt the
 * keys (id/count/totalCount/children) and keep nesting as-is.
 */
function nodeFromApi(n: ProjectTreeApiNode): ProjectTreeNode {
  return {
    name: n.name,
    fullPath: n.id,
    count: n.count,
    totalCount: n.totalCount,
    children: (n.children || []).map(nodeFromApi),
    workspace: !!n.workspace,
    orphan: !!n.orphan,
    source: n.source,
  };
}

/** Public: convert API tree response → client tree. */
export function projectTreeFromApi(nodes: ProjectTreeApiNode[]): ProjectTreeNode[] {
  return nodes.map(nodeFromApi);
}

/** Walk the tree to find a node's display name for a given project_id. */
function findProjectName(tree: ProjectTreeNode[], projectId: string | null): string | undefined {
  if (!projectId) return undefined;
  for (const n of tree) {
    if (n.fullPath === projectId) return n.name;
    const inChild = findProjectName(n.children, projectId);
    if (inChild) return inChild;
  }
  return undefined;
}

/**
 * Decide whether the search view wraps in a ProjectMainPane (with the
 * `Conversations | Dossier | Activity` tab strip) or renders the
 * conversation list + viewer bare.
 *
 * Wrap when a real project is selected — i.e. a project_id (`git:*`,
 * `git-local:*`, `ws:*`, user-declared). Skip wrapping for `untracked:`
 * footer node, raw `path:` rows, and the "All Projects" deselected
 * state — those don't have a dossier worth showing.
 */
function renderSearchView(opts: {
  projectFilter: string | null;
  projectDisplayName?: string;
  conversationList: React.ReactNode;
  conversationViewer: React.ReactNode;
  activityPane: React.ReactNode;
}): React.ReactNode {
  const id = opts.projectFilter;
  const eligible = !!id && /^(git:|git-local:|ws:|user:)/.test(id) || (!!id && !id.startsWith('untracked:') && !id.startsWith('path:') && !id.startsWith('ignored:'));

  if (!id || !eligible) {
    return <>{opts.conversationList}{opts.conversationViewer}</>;
  }

  return (
    <ProjectMainPane
      projectId={id}
      displayName={opts.projectDisplayName}
      renderConversations={() => (
        <>{opts.conversationList}{opts.conversationViewer}</>
      )}
      renderActivity={() => opts.activityPane}
    />
  );
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
  // Deployment capabilities — server mode / SaaS disables the FS-backed
  // views (activity, toolkit, settings, projects). Defaults to everything-on
  // until /api/capabilities answers, so local mode renders unchanged.
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  useEffect(() => { void getCapabilities().then(setCapabilities); }, []);
  const enabledViews = useMemo<Set<ViewMode>>(() => {
    const f = capabilities?.features;
    if (!f) return new Set<ViewMode>(['search', 'memory', 'toolkit', 'dashboard', 'activity', 'security', 'settings']);
    const out = new Set<ViewMode>();
    if (f.conversations) out.add('search');
    if (f.activity) out.add('activity');
    if (f.memory) out.add('memory');
    if (f.toolkit) out.add('toolkit');
    if (f.analytics) out.add('dashboard');
    if (f.security) out.add('security');
    if (f.settings) out.add('settings');
    if (f.account) out.add('account');
    return out;
  }, [capabilities]);

  // Entitlement gate (cloud only). 'loading' until we know; 'subscribe' shows the
  // full-screen trial gate; 'ok' renders the app. No gate when billing is off
  // (Stripe not configured) or on self-host. A late 402 from any data call
  // (lapsed mid-session) flips us back to 'subscribe'.
  const [gate, setGate] = useState<'loading' | 'ok' | 'subscribe'>(isCloud() ? 'loading' : 'ok');
  useEffect(() => {
    if (!isCloud()) return;
    getEntitlement()
      .then((e) => {
        if (!e.billingEnabled) return setGate('ok');
        setGate(e.status === 'active' || e.status === 'trialing' ? 'ok' : 'subscribe');
      })
      // "no team yet" → first-run onboarding via the Subscribe screen. Any other
      // error → don't lock the user out; the server's 402 still enforces payment.
      .catch((err) => setGate(/no team/i.test(String(err?.message || err)) ? 'subscribe' : 'ok'));
  }, []);
  useEffect(() => {
    const onPay = () => setGate('subscribe');
    window.addEventListener('cr:payment-required', onPay);
    return () => window.removeEventListener('cr:payment-required', onPay);
  }, []);
  // If the current view got disabled by a late capabilities answer, fall
  // back to Conversations instead of rendering a dead panel.
  useEffect(() => {
    if (!enabledViews.has(view)) setView('search');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledViews]);
  const [toolFilter, setToolFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectionNonce, setSelectionNonce] = useState(0);
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
  const [memoryResults, setMemoryResults] = useState<MemoryHit[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [conversationTotal, setConversationTotal] = useState(0);
  const [conversationHasMore, setConversationHasMore] = useState(false);
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  const [conversationLoading, setConversationLoading] = useState(false);

  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null);
  // Set when a non-session search hit (history/paste/plan/…) is opened in the
  // memory-item viewer instead of the conversation viewer.
  const [selectedMemoryItem, setSelectedMemoryItem] = useState<MemoryMetadataRow | null>(null);
  const [selectedSessionInfo, setSelectedSessionInfo] = useState<SessionInfo | null>(null);

  // The project tree now comes from /api/projects/tree (project_id-grouped,
  // workspace-aware, orphan-flagged). The legacy filesystem-trie was
  // replaced because (a) it bucketed PR-bot worktrees and /tmp scratch
  // sessions as first-class projects and (b) used path-prefix filtering
  // that no longer matches the server's project_id contract.
  // getStatus still drives the vector/lance health banner — its
  // `projects` field is unused now.
  const [allTimeTree, setAllTimeTree] = useState<ProjectTreeNode[]>([]);
  const [allTimeTotal, setAllTimeTotal] = useState(0);
  const [indexHealth, setIndexHealth] = useState<{ vectorOk: boolean; vectorError: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      Promise.all([getProjectTree(), getStatus()])
        .then(([tree, stats]) => {
          if (cancelled) return;
          const nodes = projectTreeFromApi(tree.nodes);
          setAllTimeTree(nodes);
          setAllTimeTotal(tree.totalCount);
          setIndexHealth({
            vectorOk: stats.vectorOk !== false,
            vectorError: stats.vectorError ?? null,
          });
        })
        .catch(console.error);
    };
    refresh();
    // Poll every 30s so a freshly-indexed project surfaces without a manual
    // reload, and the vector-health banner clears once it self-heals.
    const id = setInterval(refresh, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Sidebar now shows the same project-id tree in every view. The Activity
  // pane filters its own content by recent window; we no longer rebuild a
  // separate window-scoped sidebar tree (the old path-keyed builder is gone
  // along with path-prefix filtering).
  useEffect(() => {
    setProjectTree(allTimeTree);
    setTotalProjectCount(allTimeTotal);
  }, [allTimeTree, allTimeTotal]);

  // Keep the activity setter alive for downstream pass-through to
  // ActivityTimeline; the value is no longer used to rebuild the tree.
  useEffect(() => {
    if (view !== 'activity') setActiveProjectsForView(null);
  }, [view]);

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
        setMemoryResults([]);
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
        setMemoryResults([]);
        return;
      }
      if (looksLikeSessionId(q)) { openById(q); return; }
      try {
        const { sessions: hits, memory } = await searchSessions(q, 50, projectFilter || undefined);
        setSearchResults(hits);
        setMemoryResults(memory);
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
        setMemoryResults([]);
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
    // Non-session search hits (history / paste / plan / task / claude_md /
    // diary) carry a memory itemId, not a conversation id — routing them to
    // the session viewer 404s. Open them in the memory-item viewer instead.
    const mem = memoryResults.find((m) => m.itemId === sessionId && m.sourceType !== 'session');
    if (mem) {
      setSelectedSessionId(null);
      setSelectedSessionInfo(null);
      setSelectedResult(null);
      setMessages([]);
      setSubagents([]);
      setSelectedMemoryItem(null);
      getMemoryItem(mem.sourceType, mem.itemId)
        .then(setSelectedMemoryItem)
        .catch((err) => console.error('Failed to load memory item:', err));
      return;
    }

    setSelectedMemoryItem(null);
    setSelectedSessionId(sessionId);
    setSelectionNonce((n) => n + 1);
    // The URL always names what you're looking at — every conversation is
    // a shareable link, and back/forward walk your selection history.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get('session') !== sessionId) {
        url.searchParams.set('session', sessionId);
        window.history.pushState({ session: sessionId }, '', url);
      }
    } catch { /* URL state is best-effort */ }
    setMessages([]);
    setSubagents([]);
    // Find session info
    const info = recentSessions.find((s) => s.sessionId === sessionId) || null;
    setSelectedSessionInfo(info);
    const result = searchResults.find((r) => r.sessionId === sessionId) || null;
    setSelectedResult(result);
  }, [recentSessions, searchResults, memoryResults]);

  // ── Open-by-id ──────────────────────────────────────────────────
  // A pasted session id IS source-qualified: bare UUID → Claude,
  // `gemini_…` / `opencode_…` / `codex_…` → that tool. Supported via
  // (a) the ?session=<id> URL param (deep link) and (b) pasting the id
  // into the search box and pressing Enter.
  const SESSION_ID_RE = /^(gemini_|opencode_|codex_)?[0-9a-f-]{8,}.*$/i;
  const looksLikeSessionId = (s: string) =>
    /^(gemini_|opencode_|codex_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim()) ||
    /^(gemini_|opencode_|codex_)\S{8,}$/i.test(s.trim());
  const openById = useCallback((id: string) => {
    setView('search');
    handleSelectSession(id.trim()); // writes ?session= itself
  }, [handleSelectSession]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('view');
    if (v && ['search', 'activity', 'memory', 'insights', 'security'].includes(v)) setView(v as ViewMode);
    const id = params.get('session');
    if (id && looksLikeSessionId(id)) handleSelectSession(id);
    // Back/forward restore the selection they recorded.
    const onPop = () => {
      const sid = new URLSearchParams(window.location.search).get('session');
      if (sid && looksLikeSessionId(sid)) handleSelectSession(sid);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Keep ?view= current (replace, not push — tab switches aren't history).
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get('view') !== view) {
        url.searchParams.set('view', view);
        window.history.replaceState(window.history.state, '', url);
      }
    } catch { /* best-effort */ }
  }, [view]);
  void SESSION_ID_RE;


  const handleLoadMoreMessages = useCallback(async () => {
    if (!selectedSessionId || !conversationHasMore) return;
    try {
      const { getConversationPage } = await import('./services/api');
      const page = await getConversationPage(selectedSessionId, messages.length);
      setMessages((prev) => [...prev, ...page.messages]);
      setConversationTotal(page.total);
      setConversationHasMore(page.hasMore);
    } catch (err) {
      console.error('load more messages failed:', err);
    }
  }, [selectedSessionId, conversationHasMore, messages.length]);

  const handleLoadFull = useCallback(async () => {
    if (!selectedSessionId) return;
    setConversationLoading(true);
    try {
      const { messages: msgs, subagents: subs, total, hasMore } = await getConversationWithSubagents(selectedSessionId);
      setMessages(msgs);
      setSubagents(subs);
      setConversationTotal(total ?? msgs.length);
      setConversationHasMore(!!hasMore);
    } catch (err) {
      console.error('Failed to load conversation:', err);
    } finally {
      setConversationLoading(false);
    }
  }, [selectedSessionId]);

  const handleCloseConversation = useCallback(() => {
    setSelectedSessionId(null);
    setSelectedMemoryItem(null);
    setSelectedResult(null);
    setSelectedSessionInfo(null);
    setMessages([]);
    setSubagents([]);
  }, []);

  // Tracks the *intent* of how the user reached the conversation
  // viewer, so the viewer can land on the most-relevant tab. Coming
  // from Activity, they were just looking at file edits — landing on
  // Diff matches that mental model. From Search, they want Full.
  const [viewerInitialTab, setViewerInitialTab] = useState<string | undefined>(undefined);

  const handleMemorySessionClick = useCallback((sessionId: string, opts?: { initialTab?: string }) => {
    setView('search');
    setViewerInitialTab(opts?.initialTab);
    handleSelectSession(sessionId);
  }, [handleSelectSession]);

  const handleActivitySessionClick = useCallback((sessionId: string) => {
    handleMemorySessionClick(sessionId, { initialTab: 'diff' });
  }, [handleMemorySessionClick]);

  const displayedSessions: SessionInfo[] = useMemo(() => {
    if (searchResults.length === 0 && memoryResults.length === 0) {
      return recentSessions;
    }

    const q = query.trim();

    const sessionRows: SessionInfo[] = searchResults.map((r) => ({
      sessionId: r.sessionId,
      projectPath: r.projectPath,
      modified: r.modified,
      firstPrompt: r.firstPrompt,
      summary: r.summary,
      tool: '',
      created: r.created,
      filePath: '',
      score: r.score,
      matchedChunks: r.matchedChunks,
      query: q,
      sourceType: 'session',
    } as SessionInfo));

    // Non-session memory hits: paste / plan / claude_md / task / history / diary.
    // We synthesize SessionInfo rows for them so they slot into the same list.
    // Source type is preserved so the row can render a distinct badge and the
    // click handler can route to the right viewer.
    const seenSessions = new Set(sessionRows.map(r => r.sessionId));
    const memoryRows: SessionInfo[] = memoryResults
      .filter(m => m.sourceType !== 'session' || !seenSessions.has(m.itemId))
      .map((m) => {
        const mtimeIso = m.mtime ? new Date(m.mtime).toISOString() : '';
        return {
          sessionId: m.itemId,
          projectPath: m.projectPath,
          modified: mtimeIso,
          created: mtimeIso,
          filePath: m.filePath,
          firstPrompt: m.title,
          summary: undefined,
          tool: '',
          score: m.score,
          matchedChunks: m.matchedChunks,
          query: q,
          sourceType: m.sourceType,
        } as SessionInfo;
      });

    return [...sessionRows, ...memoryRows];
  }, [searchResults, memoryResults, recentSessions, query]);

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

  // Entitlement gate: block the whole shell until subscribed (cloud + billing on).
  if (gate === 'loading') {
    return <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--cr-fg-3)' }}>Loading…</div>;
  }
  if (gate === 'subscribe') return <SubscribeScreen />;

  return (
    <div
      className="app"
      data-mobile-sidebar-open={mobileSidebarOpen ? 'true' : undefined}
      data-has-selection={view === 'search' && (selectedSessionId || selectedMemoryItem) ? 'true' : undefined}
    >
      <TopBar
        view={view}
        setView={setView}
        enabledViews={enabledViews}
        query={query}
        setQuery={setQuery}
        searchRef={searchRef}
        onSearch={handleSearch}
        onMobileMenu={() => setMobileSidebarOpen((v) => !v)}
        mobileSidebarOpen={mobileSidebarOpen}
      />

      {enabledViews.has('security') && view !== 'settings' && view !== 'account' && (
        <SecuritySummaryBanner onReview={() => setView('security')} />
      )}

      {indexHealth && indexHealth.vectorOk === false && (
        <div
          role="status"
          data-testid="index-health-banner"
          style={{
            background: 'var(--cr-warn-surf)',
            color: 'var(--cr-warn-500)',
            borderBottom: '1px solid var(--cr-warn-line)',
            padding: '6px 14px',
            fontSize: 12,
            lineHeight: 1.4,
            display: 'flex',
            gap: 12,
            alignItems: 'center',
          }}
        >
          <strong style={{ letterSpacing: '0.04em' }}>VECTOR INDEX DEGRADED</strong>
          <span style={{ color: 'var(--cr-fg-2)' }}>
            Falling back to keyword (FTS5) search. Auto-indexer will recover on next compaction; reload to retry.
          </span>
          {indexHealth.vectorError && (
            <span
              title={indexHealth.vectorError}
              style={{
                fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)',
                color: 'var(--cr-fg-3)',
                fontSize: 11,
                marginLeft: 'auto',
                maxWidth: 480,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {indexHealth.vectorError}
            </span>
          )}
        </div>
      )}
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
      ) : view === 'account' ? (
        <div className="app-row">
          <AccountPage onClose={() => setView('search')} />
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
            enabledViews={enabledViews}
          />

          {view === 'search' && (
            renderSearchView({
              projectFilter,
              projectDisplayName: findProjectName(projectTree, projectFilter),
              conversationList: (
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
                  loading={recentLoadingFirstPage && !query.trim()}
                />
              ),
              conversationViewer: selectedMemoryItem ? (
                <div style={{ overflowY: 'auto', height: '100%' }}>
                  <MemoryDetail item={selectedMemoryItem} onSessionClick={handleSelectSession} />
                </div>
              ) : (
                <ConversationViewer
                  selectionNonce={selectionNonce}
                  totalMessages={conversationTotal}
                  hasMoreMessages={conversationHasMore}
                  onLoadMoreMessages={handleLoadMoreMessages}
                  sessionId={selectedSessionId}
                  messages={messages}
                  subagents={subagents}
                  loading={conversationLoading}
                  onClose={handleCloseConversation}
                  onLoadFull={handleLoadFull}
                  searchResult={selectedResult}
                  sessionInfo={selectedSessionInfo}
                  initialTab={viewerInitialTab}
                />
              ),
              activityPane: (
                <ActivityTimeline
                  onSessionClick={handleActivitySessionClick}
                  toolFilter={toolFilter}
                  projectFilter={projectFilter}
                  onActiveProjects={setActiveProjectsForView}
                />
              ),
            })
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
              onSessionClick={handleActivitySessionClick}
              toolFilter={toolFilter}
              projectFilter={projectFilter}
              onActiveProjects={setActiveProjectsForView}
            />
          )}
          {view === 'security' && (
            <SecurityExplorer
              onSessionClick={(sid) => handleMemorySessionClick(sid, { initialTab: 'security' })}
            />
          )}
        </div>
      )}
    </div>
  );
}
