/**
 * Main App component — v2 design system rebuild.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import TopBar from './components/TopBar';
import SystemHealth from './components/SystemHealth';
import Sidebar from './components/Sidebar';
import ConversationList from './components/ConversationList';
import ConversationViewer from './components/ConversationViewer';
import MemoryExplorer, { MemoryDetail } from './components/MemoryExplorer';
import ToolkitExplorer from './components/ToolkitExplorer';
import Dashboard from './components/Dashboard';
import ActivityTimeline from './components/ActivityTimeline';
import SecurityExplorer from './components/SecurityExplorer';
import CodeExplorer from './components/CodeExplorer';
import CommandCenter from './components/CommandCenter';
import ProjectWorkspace from './components/ProjectWorkspace';
import KnowledgeGraph from './components/KnowledgeGraph';
import { SegmentedControl, Card } from './components/primitives';
import SettingsPage from './components/SettingsPage';
import AccountPage, { SubscribeScreen, ConfirmEmailScreen } from './components/AccountPage';
import TeamView from './components/TeamView';
import TeamTasks from './components/TeamTasks';
import ConnectTokenPage from './components/ConnectTokenPage';
import SecuritySummaryBanner from './components/SecuritySummaryBanner';
import TrialBanner from './components/TrialBanner';
import AdminPage from './components/AdminPage';
import ProjectsDashboard from './components/ProjectsDashboard';
import { SidebarExtrasProvider, useSidebarExtras } from './context/sidebar-extras';
import { isCloud } from './services/auth';
import { completedCheckoutSessionId } from './utils/checkout';
import {
  getStatus,
  getRecentSessionsPage,
  getConversationWithSubagents,
  searchSessions,
  getProjectTree,
  getMemoryItem,
  getCapabilities,
  getEntitlement,
  getMe,
  setActiveTeam,
  getActiveTeam,
  type ServerCapabilities,
  type SessionInfo,
  type SearchResult,
  type MemoryHit,
  type MemoryMetadataRow,
  type Subagent,
  type ProjectTreeApiNode,
} from './services/api';

type ViewMode = 'home' | 'projects' | 'search' | 'memory' | 'tasks' | 'toolkit' | 'security' | 'health' | 'settings' | 'account' | 'connect' | 'admin' | 'team';

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
  /** Newest session mtime (ms) under this node — powers the "Recent" group. */
  lastMtime?: number;
  /** Filesystem path (for path-substring scoping of memory search/browse). */
  projectPath?: string;
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
    lastMtime: n.lastMtime,
    projectPath: n.projectPath,
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

/** Walk the tree to find a node's filesystem path for a given project_id.
 *  Memory search/browse filter on project_path (a substring), not project_id,
 *  so scoping needs the path, not the id the sidebar carries. */
function findProjectPath(tree: ProjectTreeNode[], projectId: string | null): string | undefined {
  if (!projectId) return undefined;
  for (const n of tree) {
    if (n.fullPath === projectId) return n.projectPath;
    const inChild = findProjectPath(n.children, projectId);
    if (inChild) return inChild;
  }
  return undefined;
}



/** Views that may be addressed via the ?view= deep link. */
const URL_VIEWS = new Set<ViewMode>(['home', 'projects', 'search', 'memory', 'tasks', 'toolkit', 'security', 'account', 'settings', 'connect', 'team']);

/**
 * Initial view from the URL. Reading it during state init (not in an effect)
 * means the very first render is already on the right view — otherwise the
 * "keep ?view= current" writer effect races the URL reader and snaps a
 * deep-linked ?view=dashboard back to home.
 */
function initialViewFromUrl(): ViewMode {
  try {
    const v = new URLSearchParams(window.location.search).get('view') as ViewMode | null;
    if (v && URL_VIEWS.has(v)) return v;
  } catch { /* SSR / bad URL — fall through */ }
  return 'home';
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
  const [view, setView] = useState<ViewMode>(initialViewFromUrl);
  const [homeSubTab, setHomeSubTab] = useState<'dashboard' | 'insights'>('dashboard');
  // Memory now hosts the two "how you think" corpora: the knowledge GRAPH
  // (temporal facts — previously invisible) and NOTES (plans/tasks/diary/etc).
  // Toolkit is its own top-level view now (no longer buried here).
  const [memorySub, setMemorySub] = useState<'graph' | 'notes'>('graph');
  // Deployment capabilities — server mode / SaaS disables the FS-backed
  // views (activity, toolkit, settings, projects). Defaults to everything-on
  // until /api/capabilities answers, so local mode renders unchanged.
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  // Whether to OFFER the admin console at all. Defaults false so the entry
  // never flashes for the ~everyone who is not an operator.
  const [isOperator, setIsOperator] = useState(false);
  useEffect(() => { void getCapabilities().then(setCapabilities); }, []);
  // Cloud multi-team: the server needs `x-team` to resolve a >1-team user to a
  // tenant (else every data route 400s). Pick the first membership once so the
  // whole app (search/memory/activity/tasks/shares) resolves consistently; the
  // Team view can switch it later. No-op on self-host (no teams).
  useEffect(() => {
    if (!capabilities?.features.teams) return;
    // Reconcile the stored active team against actual memberships every load: a
    // stale slug (removed from that team) would otherwise 403 every data route.
    // Keep a still-valid selection; else fall back to the first membership.
    void getMe().then((me) => {
      const slugs = me.teams.map((t) => t.team_slug);
      const cur = getActiveTeam();
      if (!cur || !slugs.includes(cur)) setActiveTeam(me.teams[0]?.team_slug ?? null);
      setIsOperator(me.isOperator === true);
    }).catch(() => { setIsOperator(false); });
  }, [capabilities]);
  // The TENANT's features, as opposed to the DEPLOYMENT's capabilities. null while
  // unknown, which must mean "don't hide anything yet" — hiding on an unanswered
  // request would flicker tabs away from a paying user on every load.
  const [tenantFeatures, setTenantFeatures] = useState<Set<string> | null>(null);
  // Who am I, and who can I assign to? The board needs both. Members come from
  // the team endpoint, which a Solo tenant cannot call — so it stays empty there
  // and the assignee list correctly offers nobody.
  const [mySub, setMySub] = useState<string | null>(null);
  /** Empty on Solo, and correctly so: /api/activity is team-gated, and with no
   *  teammates the assignee list should offer nobody. The Team view supplies a
   *  real list when it renders the same board. */
  const taskMembers: Array<{ sub: string; email: string | null; role: string }> = [];
  useEffect(() => {
    if (!isCloud()) return;
    void getMe()
      .then((m) => { setMySub(m?.user?.sub ?? null); })
      .catch(() => { /* the board still works unassigned */ });
  }, []);
  const enabledViews = useMemo<Set<ViewMode>>(() => {
    const f = capabilities?.features;
    // Optimistic default while /api/capabilities is in flight — it must be a
    // SUPERSET of every real deployment's views, or deep links to a missing
    // entry get snapped to ?view=search before the server can answer
    // ('account' was absent → ?view=account never worked as a link).
    // 'admin' is deliberately NOT in this pre-answer superset. Every other view
    // failing open is harmless — the panel renders and fills in. Admin is the one
    // that cannot: a deep link or bookmark to ?view=admin mounted the panel
    // before isOperator resolved, so a non-operator got a request they could not
    // satisfy. It is added below, once capabilities say who they are.
    if (!f) return new Set<ViewMode>(['home', 'projects', 'search', 'memory', 'tasks', 'toolkit', 'security', 'health', 'settings', 'account', 'connect', 'team']);
    const out = new Set<ViewMode>();
    out.add('home');    // command center is always available
    out.add('connect'); // installer's token page — must never be capability-gated
    // System health is never gated. "Is my collector working?" is the question
    // a broken deployment asks, and gating it behind a feature flag would hide
    // the diagnosis exactly when it is needed.
    out.add('health');
    // Operators only. It used to be added unconditionally, on the reasoning
    // that the server checks a key anyway — but in cloud mode requireAdmin()
    // never reads x-admin-key, so a non-operator got a panel, a 403, and a
    // prompt for a key that would have been ignored. Showing a door that
    // cannot open is worse than showing no door.
    if (isOperator) out.add('admin');
    if (f.codeIntel || f.conversations) out.add('projects');  // the project workspace spine
    if (f.conversations) out.add('search');
    if (f.memory) out.add('memory');
    // Deployment capability AND tenant entitlement — the free plan does not
    // include the toolkit, and this tab was the one paid surface still gated on
    // the deployment alone, so a free tenant got a door that 402s.
    if (f.toolkit && (tenantFeatures === null || tenantFeatures.has('toolkit'))) out.add('toolkit');
    // Gated on the TENANT's plan, not just the deployment, for the same reason
    // the Team tab is: showing a door that 402s is worse than showing no door.
    // Optimistic while the entitlement is in flight — the server refuses either
    // way, so a flicker costs more than a moment of hope.
    if (tenantFeatures === null || tenantFeatures.has('tasks')) out.add('tasks');
    if (f.security) out.add('security');
    if (f.settings) out.add('settings');
    if (f.account) out.add('account');
    // Deployment capability AND tenant entitlement. /api/capabilities is pre-auth,
    // so f.teams only says the build supports teams — it cannot know whether THIS
    // account bought them. Without the second half the Team tab rendered for
    // everyone and then 402'd, which is the "door that cannot open" this same
    // function refuses to show for the admin view.
    //
    // A null tenantFeatures means the answer has not arrived: show the tab rather
    // than flicker it away from someone who has paid. The server refuses either
    // way, so being optimistic here costs nothing.
    if (f.teams && (tenantFeatures === null || tenantFeatures.has('team'))) out.add('team');
    return out;
  }, [capabilities, isOperator, tenantFeatures]);

  // Analytics & Insights is a paid surface too — same optimistic-while-unknown
  // rule as the tabs above. It is a sub-tab of Home rather than a view, so it
  // needs its own gate; without one a free tenant kept a door that 402s.
  const insightsAllowed = tenantFeatures === null || tenantFeatures.has('insights');
  useEffect(() => {
    if (!insightsAllowed && homeSubTab === 'insights') setHomeSubTab('dashboard');
  }, [insightsAllowed, homeSubTab]);

  // Entitlement gate (cloud only). 'loading' until we know; 'subscribe' shows the
  // full-screen trial gate; 'ok' renders the app. No gate when billing is off
  // (Stripe not configured) or on self-host. A late 402 from any data call
  // (lapsed mid-session) flips us back to 'subscribe'.
  const [gate, setGate] = useState<'loading' | 'ok' | 'subscribe' | 'confirm-email'>(isCloud() ? 'loading' : 'ok');
  // True while the URL still carries a completed Stripe Checkout redirect. Read
  // once from the initial URL so a later state change cannot revoke it.
  const [justPaid] = useState<boolean>(() => {
    try {
      // Scoped to the account view on purpose. The licence panel renders nowhere
      // else, so this is the only place the override buys anything — and left
      // unscoped, any ?checkout=success URL waved a lapsed tenant past the
      // paywall into the rest of the shell.
      if (new URLSearchParams(window.location.search).get('view') !== 'account') return false;
      return !!completedCheckoutSessionId();
    } catch { return false; }
  });
  useEffect(() => {
    if (!isCloud()) return;
    getEntitlement()
      .then((e) => {
        if (Array.isArray(e.features)) setTenantFeatures(new Set(e.features));
        // NEVER CONFIRMED → its own full page, not the dashboard.
        //
        // status 'none' means no entitlement row was ever written, which happens
        // for exactly one reason: the address is unconfirmed, so ensureTrial
        // withheld the grant. EVERY new signup is in this state for as long as it
        // takes to reach an inbox — and since a lapsed/unentitled account now has
        // its reads refused, the dashboard behind this renders empty. The user
        // saw a blank page with a 12px warning strip and no idea what to do.
        //
        // One action is available to them and it is not on this page, so the page
        // should say so and nothing else.
        if (e.status === 'none' && e.entitled === false) { setGate('confirm-email'); return; }
        // FREE IS THE FLOOR. A tenant whose entitlement resolved — active,
        // trialing, lapsed, canceled — renders the app: the server serves a
        // lapsed tenant the free plan (windowed search, metered sync) rather
        // than refusing, so a full-screen paywall here would lock people out of
        // data the server would happily return. The tenant's feature list
        // (above) hides the paid tabs, and TrialBanner states the free plan as
        // an offer. Only a visitor with NO workspace yet meets the gate — that
        // is first-run onboarding, handled in the catch below.
        setGate('ok');
        // A full meter is only ever 402'd to the CLI's device-token calls, so
        // the browser would never see the limitReached payload — derive it from
        // the same numbers the gate enforces with and raise the notice locally.
        if (e.usage && e.limits) {
          const overQuota = e.limits.syncBytesPerMonth != null && e.usage.monthBytes >= e.limits.syncBytesPerMonth;
          const overCap = e.limits.syncStorageBytes != null && e.usage.storedBytes >= e.limits.syncStorageBytes;
          if (overQuota || overCap) {
            window.dispatchEvent(new CustomEvent('cr:sync-limit', {
              detail: {
                kind: overCap ? 'sync_storage' : 'sync_quota',
                used: overCap ? e.usage.storedBytes : e.usage.monthBytes,
                limit: overCap ? e.limits.syncStorageBytes : e.limits.syncBytesPerMonth,
                error: '',
              },
            }));
          }
        }
      })
      // "no team yet" → first-run onboarding via the Subscribe screen. Any other
      // error → don't lock the user out; the server keeps enforcing its gates.
      .catch((err) => setGate(/no team/i.test(String(err?.message || err)) ? 'subscribe' : 'ok'));
  }, []);
  useEffect(() => {
    // Verify before locking the shell, rather than trusting the refusal that
    // raised the event. api.ts already filters feature-level and limit-level
    // 402s out, but this is the decision that replaces the entire app with a
    // paywall, so it asks the authoritative endpoint first. Any tenant whose
    // entitlement RESOLVES keeps the app — a lapsed tenant is on the free plan,
    // not locked out — so the gate falls only for a visitor with no workspace.
    const onPay = () => {
      getEntitlement()
        .then((e) => {
          if (Array.isArray(e.features)) setTenantFeatures(new Set(e.features));
        })
        .catch((err) => {
          if (/no team/i.test(String(err?.message || err))) setGate('subscribe');
        });
    };
    window.addEventListener('cr:payment-required', onPay);
    return () => window.removeEventListener('cr:payment-required', onPay);
  }, []);
  // A write refused for a missing email confirmation. Its own surface: the fix
  // is a link in an inbox, and before this it fell into the paywall path —
  // which no longer renders for resolvable tenants — and vanished silently.
  const [confirmEmailNotice, setConfirmEmailNotice] = useState<string | null>(null);
  useEffect(() => {
    const onConfirm = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setConfirmEmailNotice(typeof detail === 'string' && detail ? detail : 'Confirm your email address to start your trial.');
    };
    window.addEventListener('cr:confirm-email', onConfirm);
    return () => window.removeEventListener('cr:confirm-email', onConfirm);
  }, []);
  // If the current view got disabled by a late capabilities answer, fall
  // back to Conversations instead of rendering a dead panel.
  useEffect(() => {
    if (!enabledViews.has(view)) setView('search');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledViews]);
  // toolFilter / projectFilter are URL-backed so a filtered view is shareable
  // and survives refresh + back/forward (e.g. ?project=git:…&tool=claude).
  // Read during init so the first data fetch already uses them.
  const [toolFilter, setToolFilter] = useState<string>(() => {
    try { return new URLSearchParams(window.location.search).get('tool') || 'all'; } catch { return 'all'; }
  });
  const [projectFilter, setProjectFilter] = useState<string | null>(() => {
    try { return new URLSearchParams(window.location.search).get('project'); } catch { return null; }
  });
  const [query, setQuery] = useState('');
  // When the user clicks a Command Center metric (Critical findings / Hotspots),
  // the projects list opens sorted to surface that metric — carrying the intent
  // of the click instead of dumping them on an unsorted repo grid.
  const [projectsEmphasis, setProjectsEmphasis] = useState<'critical' | 'hotspots' | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectionNonce, setSelectionNonce] = useState(0);
  const [sort, setSort] = useState('recent');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  const [projectTree, setProjectTree] = useState<ProjectTreeNode[]>([]);
  const [totalProjectCount, setTotalProjectCount] = useState(0);
  // Session to scope the Security dashboard to when opened via a conversation's
  // "Manage ›" button — shows just that conversation's leaked secrets.
  const [securityFocusSession, setSecurityFocusSession] = useState<string | null>(null);
  // When in Activity view, the tree shows only projects with edits in the
  // current window — fed by ActivityTimeline → onActiveProjects → here.
  // Reset to null when leaving the Activity view so the all-time tree
  // returns. `null` (not `{}`) distinguishes "haven't received an update
  // yet" from "received an empty set" (no recent activity).
  const [activeProjectsForView, setActiveProjectsForView] = useState<Record<string, number> | null>(null);
  const [recentSessions, setRecentSessions] = useState<SessionInfo[]>([]);
  // Pagination state — drives the "load more" trigger in ConversationList.
  const [recentTotal, setRecentTotal] = useState(0);
  const [recentWindow, setRecentWindow] = useState<{ days: number; lockedOlder: number } | null>(null);
  const [recentHasMore, setRecentHasMore] = useState(false);
  const [recentLoadingMore, setRecentLoadingMore] = useState(false);
  // Distinct from `recentLoadingMore`: true while the FIRST page (or a
  // refetch after filter change) is in flight. Drives the skeleton
  // shimmer state in ConversationList — without it the list is blank
  // for the cold 1-2s walk and the user thinks the app broke.
  const [recentLoadingFirstPage, setRecentLoadingFirstPage] = useState(true);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [memoryResults, setMemoryResults] = useState<MemoryHit[]>([]);
  // Free-plan window metadata from the LAST search response: how many trailing
  // days the server searched, and how many matches sit outside that window
  // (stored and locked). Null while no windowed answer has arrived — the
  // results list then says nothing about a window.
  const [searchWindow, setSearchWindow] = useState<{ days: number; lockedOlder: number | null } | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [conversationTotal, setConversationTotal] = useState(0);
  const [conversationHasMore, setConversationHasMore] = useState(false);
  /** Server rows consumed so far. Never `messages.length` — see ConversationPage.nextOffset. */
  const [conversationOffset, setConversationOffset] = useState(0);
  const [conversationLoadingMore, setConversationLoadingMore] = useState(false);
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
  // Whether the first project-tree fetch has resolved — so the Projects picker
  // can show "Loading…" instead of a false "No projects indexed" while the
  // tree is still in flight (or after a failed fetch).
  const [treeLoaded, setTreeLoaded] = useState(false);
  const [indexHealth, setIndexHealth] = useState<{ vectorOk: boolean; vectorError: string | null } | null>(null);
  // Bumped by the topbar "Refresh" button to force an immediate re-fetch of
  // sessions, project tree, and status without waiting for the 30s poll.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const handleRefreshAll = useCallback(() => setRefreshNonce((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      Promise.all([getProjectTree(), getStatus()])
        .then(([tree, stats]) => {
          if (cancelled) return;
          const nodes = projectTreeFromApi(tree.nodes);
          setAllTimeTree(nodes);
          setAllTimeTotal(tree.totalCount);
          setTreeLoaded(true);
          setIndexHealth({
            vectorOk: stats.vectorOk !== false,
            vectorError: stats.vectorError ?? null,
          });
        })
        .catch((e) => { console.error(e); if (!cancelled) setTreeLoaded(true); });
    };
    refresh();
    // Poll every 30s so a freshly-indexed project surfaces without a manual
    // reload, and the vector-health banner clears once it self-heals.
    const id = setInterval(refresh, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [refreshNonce]);

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
    if (view !== 'projects') setActiveProjectsForView(null);
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
        // The feed is windowed server-side for free tenants. Without carrying
        // that into the list, the truncation reads as data loss — the user
        // scrolls, hits the end after N days, and nothing says why.
        setRecentWindow(typeof page.windowDays === 'number'
          ? { days: page.windowDays, lockedOlder: page.lockedOlder ?? 0 }
          : null);
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
  }, [projectFilter, toolFilter, refreshNonce]);

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
    // `explicit` = the user committed to the search (Enter / Search button) vs.
    // the debounced type-ahead. Type-ahead stays FTS-only (free, no embed);
    // an explicit search also runs the semantic tier (one remote embed, cached)
    // and RRF-fuses it in. This is what keeps keystrokes from each embedding.
    async (q: string, explicit = false) => {
      if (!q.trim()) {
        setSearchResults([]);
        setMemoryResults([]);
        setSearchWindow(null);
        return;
      }
      if (looksLikeSessionId(q)) { openById(q); return; }
      // A search always lands you in the conversations/search view. Without this,
      // typing from Projects/Overview fetched results into state that only the
      // search view renders — so it looked like the search box did nothing.
      setView('search');
      try {
        const { sessions: hits, memory, windowDays, lockedOlder } = await searchSessions(q, 50, projectFilter || undefined, explicit);
        setSearchResults(hits);
        setMemoryResults(memory);
        setSearchWindow(windowDays != null ? { days: windowDays, lockedOlder } : null);
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
        setSearchWindow(null);
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
      setConversationOffset(0);
      setConversationHasMore(false);
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
    setConversationOffset(0);
    setConversationHasMore(false);
    // Find session info
    const info = recentSessions.find((s) => s.sessionId === sessionId) || null;
    setSelectedSessionInfo(info);
    const result = searchResults.find((r) => r.sessionId === sessionId) || null;
    setSelectedResult(result);
  }, [recentSessions, searchResults, memoryResults]);

  // ── Open-by-id ──────────────────────────────────────────────────
  // A pasted session id IS source-qualified: bare UUID → Claude,
  // `gemini_…` / `opencode_…` / `codex_…` / `agy_…` / `cursor_…` → that tool. Supported via
  // (a) the ?session=<id> URL param (deep link) and (b) pasting the id
  // into the search box and pressing Enter.
  const SESSION_ID_RE = /^(gemini_|opencode_|codex_|agy_|cursor_)?[0-9a-f-]{8,}.*$/i;
  const looksLikeSessionId = (s: string) =>
    /^(gemini_|opencode_|codex_|agy_|cursor_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim()) ||
    /^(gemini_|opencode_|codex_|agy_|cursor_)\S{8,}$/i.test(s.trim());
  const openById = useCallback((id: string) => {
    setView('search');
    handleSelectSession(id.trim()); // writes ?session= itself
  }, [handleSelectSession]);

  // Open a related item from the conversation viewer's Related tab. Sessions
  // route to the transcript viewer; every other source type (plan, task,
  // claude_md, …) opens in the memory-item viewer, mirroring how a memory
  // search hit is opened.
  const openMemoryByTypeId = useCallback((sourceType: string, id: string) => {
    if (sourceType === 'session') { openById(id); return; }
    setView('search');
    setSelectedSessionId(null);
    setSelectedSessionInfo(null);
    setSelectedResult(null);
    setMessages([]);
    setSubagents([]);
    setConversationOffset(0);
    setConversationHasMore(false);
    setSelectedMemoryItem(null);
    getMemoryItem(sourceType, id)
      .then(setSelectedMemoryItem)
      .catch((err) => console.error('Failed to load related item:', err));
  }, [openById]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('view');
    if (v && ['home', 'projects', 'search', 'memory', 'toolkit', 'security', 'settings', 'account'].includes(v)) setView(v as ViewMode);
    const id = params.get('session');
    if (id && looksLikeSessionId(id)) handleSelectSession(id);
    // Back/forward restore the full navigational state recorded in that URL
    // snapshot — view, project, tool and the open session — so the back button
    // actually walks where you've been, not just the conversation selection.
    const onPop = () => {
      const p = new URLSearchParams(window.location.search);
      const pv = p.get('view');
      if (pv && URL_VIEWS.has(pv as ViewMode)) setView(pv as ViewMode);
      setProjectFilter(p.get('project'));
      setToolFilter(p.get('tool') || 'all');
      const sid = p.get('session');
      if (sid && looksLikeSessionId(sid)) handleSelectSession(sid);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Keep ?project= / ?tool= current. replaceState — filters are incidental, not
  // history-worthy. Default values (no project, tool=all) drop the param for
  // clean URLs.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      let changed = false;
      if ((url.searchParams.get('project') || null) !== projectFilter) {
        if (projectFilter) url.searchParams.set('project', projectFilter);
        else url.searchParams.delete('project');
        changed = true;
      }
      if ((url.searchParams.get('tool') || 'all') !== toolFilter) {
        if (toolFilter && toolFilter !== 'all') url.searchParams.set('tool', toolFilter);
        else url.searchParams.delete('tool');
        changed = true;
      }
      if (changed) window.history.replaceState(window.history.state, '', url);
    } catch { /* best-effort */ }
  }, [projectFilter, toolFilter]);
  // Keep ?view= current (replace, not push — tab switches aren't history).
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      let changed = false;
      if (url.searchParams.get('view') !== view) { url.searchParams.set('view', view); changed = true; }
      // The selected session belongs only to the Conversations view — drop it
      // from the URL anywhere else so clicking Projects doesn't leave a stale
      // ?session=… (and a reload there doesn't reopen a conversation).
      if (view !== 'search' && url.searchParams.has('session')) { url.searchParams.delete('session'); changed = true; }
      if (changed) window.history.replaceState(window.history.state, '', url);
    } catch { /* best-effort */ }
  }, [view]);
  // Selection is scoped to Conversations; clear it when navigating away so the
  // viewer doesn't linger and returning starts clean.
  useEffect(() => {
    if (view !== 'search') { setSelectedSessionId(null); setSelectedMemoryItem(null); }
  }, [view]);
  void SESSION_ID_RE;


  const handleLoadMoreMessages = useCallback(async () => {
    if (!selectedSessionId || !conversationHasMore || conversationLoadingMore) return;
    setConversationLoadingMore(true);
    try {
      const { getConversationPage } = await import('./services/api');
      const page = await getConversationPage(selectedSessionId, conversationOffset);
      setMessages((prev) => [...prev, ...page.messages]);
      setConversationTotal(page.total);
      setConversationHasMore(page.hasMore);
      setConversationOffset(page.nextOffset);
    } catch (err) {
      console.error('load more messages failed:', err);
    } finally {
      setConversationLoadingMore(false);
    }
  }, [selectedSessionId, conversationHasMore, conversationLoadingMore, conversationOffset]);

  /** Walk to the END of the session, appending each page as it lands. This is
   *  what every whole-session view needs: with one page loaded, the transcript
   *  stops mid-session and the last message shown is not the last message. */
  const handleLoadAllMessages = useCallback(async () => {
    if (!selectedSessionId || !conversationHasMore || conversationLoadingMore) return;
    setConversationLoadingMore(true);
    try {
      const { loadRestOfConversation } = await import('./services/api');
      const r = await loadRestOfConversation(selectedSessionId, conversationOffset, (page) => {
        setMessages((prev) => [...prev, ...page.messages]);
        setConversationTotal(page.total);
      });
      setConversationHasMore(r.hasMore);
      setConversationOffset(r.nextOffset);
    } catch (err) {
      console.error('load all messages failed:', err);
    } finally {
      setConversationLoadingMore(false);
    }
  }, [selectedSessionId, conversationHasMore, conversationLoadingMore, conversationOffset]);

  const handleLoadFull = useCallback(async () => {
    if (!selectedSessionId) return;
    setConversationLoading(true);
    try {
      const { messages: msgs, subagents: subs, total, hasMore, nextOffset } = await getConversationWithSubagents(selectedSessionId);
      setMessages(msgs);
      setSubagents(subs);
      setConversationTotal(total ?? msgs.length);
      setConversationHasMore(!!hasMore);
      setConversationOffset(nextOffset);
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
    setConversationOffset(0);
    setConversationHasMore(false);
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
    return <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', color: 'var(--cr-fg-3)' }}>Loading…</div>;
  }
  // Never meet someone who has JUST paid with "your subscription has ended".
  //
  // The entitlement that lifts this gate is written by the same Stripe webhook
  // that issues a self-host licence serial, and the buyer is redirected back
  // here the instant checkout completes — often before either has landed. The
  // paywall would then replace the whole shell, hiding the licence panel that is
  // the only reason they returned, and a reload loses the session_id for good.
  //
  // A checkout=success redirect is proof of payment on its own, so it wins.
  if (gate === 'confirm-email') return <ConfirmEmailScreen />;
  if (gate === 'subscribe' && !justPaid) return <SubscribeScreen />;

  // The installer's token page renders chrome-free: the user is mid-command in
  // a terminal — no sidebar, no tabs, just the token. (Auto-creates the
  // workspace itself, so it must come after the entitlement gate only.)
  if (view === 'connect') return <ConnectTokenPage />;

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
        onRefresh={handleRefreshAll}
      />

      {view !== 'settings' && view !== 'account' && (
        <TrialBanner onSubscribe={() => setView('account')} windowDays={searchWindow?.days} />
      )}

      {enabledViews.has('security') && view !== 'settings' && view !== 'account' && (
        <SecuritySummaryBanner onReview={() => setView('security')} />
      )}

      {confirmEmailNotice && (
        <div
          role="status"
          data-testid="confirm-email-banner"
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
            flexWrap: 'wrap',
            minWidth: 0,
          }}
        >
          <strong style={{ letterSpacing: '0.04em' }}>CONFIRM YOUR EMAIL</strong>
          <span style={{ color: 'var(--cr-fg-2)' }}>{confirmEmailNotice}</span>
          <button
            onClick={() => setConfirmEmailNotice(null)}
            style={{
              marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--cr-fg-3)', fontSize: 12,
            }}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
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
            // This banner is a direct child of .app, so the .app-row > *
            // min-width:0 guard does not reach it. Without wrapping, the nowrap
            // error span below forces the whole shell wider than the screen.
            flexWrap: 'wrap',
            minWidth: 0,
          }}
        >
          <strong style={{ letterSpacing: '0.04em' }}>SEMANTIC SEARCH UNAVAILABLE</strong>
          <span style={{ color: 'var(--cr-fg-2)' }}>
            Using keyword (full-text) search. Usually means pgvector isn't installed on the database, or no embedder is configured (Settings → Search). Reload to retry.
          </span>
          {indexHealth.vectorError && (
            <span
              title={indexHealth.vectorError}
              style={{
                fontFamily: 'var(--cr-font-mono, ui-monospace, monospace)',
                color: 'var(--cr-fg-3)',
                fontSize: 11,
                marginLeft: 'auto',
                // minWidth:0 lets the ellipsis do its job instead of the nowrap
                // text setting a min-content floor for the whole banner.
                minWidth: 0,
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
          {/* Full-width scroll pane (matches Home/Team): scrollbar sits at the
              viewport edge; AccountPage's centered column stays centered inside. */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <AccountPage onClose={() => setView('search')} />
          </div>
        </div>
      ) : view === 'admin' ? (
        <div className="app-row">
          <AdminPage onClose={() => setView('search')} />
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
                loading={recentLoadingFirstPage && !query.trim()}
                windowDays={query.trim() ? searchWindow?.days ?? null : recentWindow?.days ?? null}
                lockedOlder={query.trim() ? searchWindow?.lockedOlder ?? null : recentWindow?.lockedOlder ?? null}
                onUnlock={() => setView('account')}
              />
              {selectedMemoryItem ? (
                <div style={{ overflowY: 'auto', height: '100%', flex: 1 }}>
                  <MemoryDetail item={selectedMemoryItem} onSessionClick={handleSelectSession} onOpenItem={openMemoryByTypeId} />
                </div>
              ) : (
                <ConversationViewer
                  selectionNonce={selectionNonce}
                  totalMessages={conversationTotal}
                  hasMoreMessages={conversationHasMore}
                  onLoadMoreMessages={handleLoadMoreMessages}
                  onLoadAllMessages={handleLoadAllMessages}
                  loadingMoreMessages={conversationLoadingMore}
                  sessionId={selectedSessionId}
                  messages={messages}
                  subagents={subagents}
                  loading={conversationLoading}
                  onClose={handleCloseConversation}
                  onLoadFull={handleLoadFull}
                  searchResult={selectedResult}
                  query={query}
                  sessionInfo={selectedSessionInfo}
                  initialTab={viewerInitialTab}
                  onManageSecurity={() => { setSecurityFocusSession(selectedSessionId); setView('security'); }}
                  onOpenSession={openById}
                  onOpenItem={openMemoryByTypeId}
                />
              )}
            </>
          )}
          {view === 'memory' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ padding: '12px 16px 0' }}>
                <SegmentedControl
                  value={memorySub}
                  onChange={(v) => setMemorySub(v as 'graph' | 'notes')}
                  options={[{ value: 'graph', label: 'Knowledge graph' }, { value: 'notes', label: 'Notes & plans' }]}
                />
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                {memorySub === 'graph' ? (
                  <KnowledgeGraph />
                ) : (
                  <MemoryExplorer onSessionClick={handleMemorySessionClick} toolFilter={toolFilter} projectFilter={projectFilter} projectPathFilter={findProjectPath(projectTree, projectFilter)} />
                )}
              </div>
            </div>
          )}
          {view === 'tasks' && (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '18px 24px 28px' }}>
              {/* members is empty for a Solo tenant, which is correct: with no
                  teammates the assignee list offers only "Unassigned", and
                  assigning to someone else is what needs a team plan anyway. */}
              <TeamTasks members={taskMembers} mySub={mySub} />
            </div>
          )}

          {view === 'toolkit' && (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <ToolkitExplorer toolFilter={toolFilter} />
            </div>
          )}
          {view === 'team' && (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <TeamView onOpenProject={(pid) => { setProjectFilter(pid); setToolFilter('all'); setView('projects'); }} />
            </div>
          )}
          {view === 'projects' && (
            projectFilter ? (
              <ProjectWorkspace
                projectId={projectFilter}
                projectName={findProjectName(projectTree, projectFilter) || projectFilter}
                toolFilter={toolFilter}
                onOpenSession={(sid) => handleMemorySessionClick(sid)}
                onBack={() => { setProjectFilter(null); setView('projects'); }}
              />
            ) : (
              <ProjectsDashboard
                tree={projectTree}
                loaded={treeLoaded}
                onPick={(id) => { setProjectFilter(id); setToolFilter('all'); setProjectsEmphasis(null); }}
                toolFilter={toolFilter}
                onSessionClick={handleActivitySessionClick}
                onActiveProjects={setActiveProjectsForView}
                emphasis={projectsEmphasis}
                onClearEmphasis={() => setProjectsEmphasis(null)}
              />
            )
          )}
          {view === 'health' && (
            /* Needs the same scroll container every sibling view has. Rendered
               bare, it was a flex child of a clipped column, so anything past
               the fold had nowhere to go — invisible on a desktop tall enough
               to fit both sections, and unreachable on a phone. */
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <SystemHealth />
            </div>
          )}
          {view === 'security' && (
            <SecurityExplorer
              onSessionClick={(sid) => handleMemorySessionClick(sid, { initialTab: 'security' })}
              focusSession={securityFocusSession}
            />
          )}
          {view === 'home' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ padding: '12px 16px 0', borderBottom: '1px solid var(--cr-line-1)', background: 'var(--cr-ink-1)' }}>
                <SegmentedControl
                  value={homeSubTab}
                  onChange={(v) => setHomeSubTab(v as 'dashboard' | 'insights')}
                  options={[
                    { value: 'dashboard', label: 'Command Center' },
                    ...(insightsAllowed ? [{ value: 'insights', label: 'Analytics & Insights' }] : []),
                  ]}
                />
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                {homeSubTab === 'dashboard' ? (
                  <CommandCenter
                    setView={(v) => {
                      if (v === 'dashboard') {
                        if (insightsAllowed) setHomeSubTab('insights');
                      } else {
                        setView(v as ViewMode);
                      }
                    }}
                    onOpenProject={(id) => { setProjectFilter(id); setToolFilter('all'); setView('projects'); }}
                    onFocusProjects={(emphasis) => { setProjectsEmphasis(emphasis); setProjectFilter(null); setToolFilter('all'); setView('projects'); }}
                    cloud={capabilities?.edition === 'cloud'}
                  />
                ) : (
                  <Dashboard
                    onJumpToSession={handleMemorySessionClick}
                    onJumpToSearch={(q) => { setQuery(q); setView('search'); }}
                    toolFilter={toolFilter}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

