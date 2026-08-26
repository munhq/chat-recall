import React, { useState, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { useUrlState } from '../services/url-state';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import * as diff from 'diff';
import { Icon, Button, Chip, ToolBadge, SegmentedControl, Card } from './primitives';
import type {
  Message,
  SearchResult,
  SessionInfo,
  Subagent,
  RelatedItemsResponse,
  SessionMetadataResponse,
  SessionDiffResponse,
  SessionCommitsResponse,
  SessionOutcomeResponse,
  SessionSecretsResponse,
  PromptMarker,
  RelatedItem,
  MemoryMetadataRow,
} from '../services/api';
import {
  getSessionRelated,
  getSessionMetadata,
  getSessionDiff,
  getSessionCommits,
  getSessionOutcome,
  getSessionSecrets,
  regenerateSummary,
  renameConversation,
  deleteConversation,
} from '../services/api';
import { stripInjectedBanners, summaryTitle } from '../utils/clean';
import SessionTrace from './SessionTrace';
import { MemoryDetail } from './MemoryExplorer';
// ONE implementation of the resume command, shared with the CLI and the MCP
// server. This file used to carry its own copy, and the two could drift.
import { resumeCommandFor } from '@chat-recall/engine/core/resume-command.js';

type ViewMode = 'summary' | 'insights' | 'metrics' | 'firstPrompt' | 'full' | 'trace' | 'related' | 'diff' | 'commits' | 'outcome' | 'security' | 'plans';
type MessageFilter = 'all' | 'user' | 'assistant' | 'thinking' | 'tools' | 'edits';

interface ConversationViewerProps {
  /** True total on the server (may exceed messages.length when paginated). */
  totalMessages?: number;
  hasMoreMessages?: boolean;
  /** Load ONE more page. */
  onLoadMoreMessages?: () => void;
  /** Page to the END of the session. Whole-session views need this: with a
   *  single page loaded, the last message on screen is not the last message
   *  of the session, and every count derived from it covers the window only. */
  onLoadAllMessages?: () => void;
  loadingMoreMessages?: boolean;
  /** Incremented by the parent on EVERY selection — even re-selecting the
   *  same session. Forces a refetch so a long-lived tab can never serve
   *  hours-old in-memory messages for a session whose data has changed. */
  selectionNonce?: number;
  sessionId: string | null;
  messages: Message[];
  subagents?: Subagent[];
  loading: boolean;
  onClose: () => void;
  onLoadFull: () => void;
  searchResult: SearchResult | null;
  /** The search query that surfaced this session, so the transcript can
   *  highlight the literal term occurrences (keyword matches). */
  query?: string;
  sessionInfo: SessionInfo | null;
  /**
   * Optional hint from the caller about which tab to land on.
   * Activity → 'diff' (the user just clicked a row of file edits);
   * Search → undefined (defaults to 'full' = the chat itself).
   */
  initialTab?: string;
  /** Open the top-level Security dashboard scoped to this conversation's leaked
   *  secrets so they can be rotated/dismissed. */
  onManageSecurity?: () => void;
  /** Open another session by id (Related tab → sibling sessions). */
  onOpenSession?: (id: string) => void;
  /** Open a related memory item by (sourceType, id) — Related tab links/plans. */
  onOpenItem?: (sourceType: string, id: string) => void;
}

// Map a search hit's top matched snippet back to the transcript message that
// contains it, so opening a result jumps to those exact lines (not the
// Overview). Whitespace-normalized substring match; tries each matched chunk
// best-score-first and returns the first message line that contains one.
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
function findMatchedLine(messages: Message[], chunks: Array<{ text: string }>): number | null {
  const haystack = messages.map((m) => ({ line: m.line, norm: m.content ? normalizeForMatch(m.content) : '' }));
  for (const c of chunks) {
    const needle = normalizeForMatch(c.text || '').slice(0, 60);
    if (needle.length < 12) continue;
    const hit = haystack.find((m) => m.norm && m.norm.includes(needle));
    if (hit) return hit.line;
  }
  return null;
}

// Highlight literal query-term occurrences in a transcript message. Returns a
// react-markdown rehype plugin (or null when there's nothing to mark) that walks
// the rendered HTML tree and wraps matches in <mark class="cr-hl">. It runs on
// the HAST (post-markdown) tree — never the raw source — so it can't corrupt
// markdown, and it skips `code`/`pre` so code stays verbatim. Literal terms
// only: a pure-semantic hit with no literal occurrence simply gets no marks
// (the jump-to-matched-line already lands the reader on the relevant message).
function makeTermHighlighter(query: string | undefined) {
  const terms = (query || '').split(/\s+/).filter((t) => t.length >= 2);
  if (!terms.length) return null;
  const escaped = terms.sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  // react-markdown rehypePlugins entry: a plugin () => transformer(tree).
  return () => (tree: any) => {
    const visit = (node: any) => {
      if (!node || !Array.isArray(node.children)) return;
      const out: any[] = [];
      for (const child of node.children) {
        if (child.type === 'element') {
          if (child.tagName !== 'code' && child.tagName !== 'pre') visit(child);
          out.push(child);
          continue;
        }
        if (child.type !== 'text') { out.push(child); continue; }
        const v: string = child.value;
        re.lastIndex = 0;
        if (!re.test(v)) { out.push(child); continue; }
        re.lastIndex = 0;
        let last = 0; let m: RegExpExecArray | null;
        while ((m = re.exec(v)) !== null) {
          if (m.index > last) out.push({ type: 'text', value: v.slice(last, m.index) });
          out.push({ type: 'element', tagName: 'mark', properties: { className: ['cr-hl'] }, children: [{ type: 'text', value: m[0] }] });
          last = m.index + m[0].length;
          if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
        }
        if (last < v.length) out.push({ type: 'text', value: v.slice(last) });
      }
      node.children = out;
    };
    visit(tree);
  };
}

export default function ConversationViewer({
  sessionId,
  selectionNonce,
  totalMessages,
  hasMoreMessages,
  onLoadMoreMessages,
  onLoadAllMessages,
  loadingMoreMessages,
  messages,
  subagents = [],
  loading,
  onClose,
  onLoadFull,
  searchResult,
  query,
  sessionInfo,
  initialTab,
  onManageSecurity,
  onOpenSession,
  onOpenItem,
}: ConversationViewerProps) {
  // Default to the actual conversation messages, not the Gemini summary.
  // Caller can override (e.g. Activity passes 'diff' since the user just
  // clicked a row of file edits and expects to see the changes).
  // Tab is URL-backed (?tab=) so a specific lens on a session is shareable
  // ("this session → Diff"). replaceState keeps tab flips out of history;
  // the param clears when the viewer unmounts.
  const VIEWER_TABS = ['summary', 'insights', 'metrics', 'outcome', 'firstPrompt', 'full', 'trace', 'diff', 'commits', 'security', 'related', 'plans'];
  // Default to Overview — the at-a-glance dashboard (work done, activity,
  // arc, context, cost). Recap (Delivered/Not done/Frustrations) and Summary
  // are one click away.
  const [viewModeRaw, setViewModeRaw] = useUrlState('tab', 'metrics', {
    valid: (v) => VIEWER_TABS.includes(v),
    clearOnUnmount: true,
  });
  const viewMode = viewModeRaw as ViewMode;
  const setViewMode = setViewModeRaw as (v: ViewMode) => void;

  // When the caller hints at a tab (Activity → diff, Security → security),
  // that explicit intent wins over whatever the URL had.
  useEffect(() => {
    if (initialTab) setViewMode(initialTab as ViewMode);
  }, [sessionId, initialTab]); // eslint-disable-line react-hooks/exhaustive-deps
  const [filter, setFilter] = useState<MessageFilter>('all');
  // Line to scroll to + flash in the transcript (set when a Session-arc bar is
  // clicked, so it jumps to that exact prompt).
  const [scrollToLine, setScrollToLine] = useState<number | null>(null);
  // When a target line is set and the transcript is showing, scroll to that
  // message and let it flash. Messages may still be streaming in, so retry
  // briefly until the element exists.
  useEffect(() => {
    if (viewMode !== 'full' || scrollToLine == null) return;
    let tries = 0;
    const t = setInterval(() => {
      const el = document.querySelector(`[data-line="${scrollToLine}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        clearInterval(t);
        setTimeout(() => setScrollToLine(null), 2600);
      } else if (++tries > 24) {
        clearInterval(t);
      }
    }, 150);
    return () => clearInterval(t);
  }, [viewMode, scrollToLine, messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Search → jump to the matching lines ─────────────────────────────
  // A session opened from a search hit lands on the transcript at the matched
  // lines, not the Overview. Route the tab once per selection (guarded by
  // searchJumpedNonce so later navigation is free), then scroll to the snippet
  // once the messages load. These hooks MUST sit above the early return below
  // so the hook order is stable whether or not a session is selected.
  const [pendingSearchJump, setPendingSearchJump] = useState(false);
  const searchJumpedNonce = React.useRef<number | null>(null);
  useEffect(() => {
    const chunks = searchResult?.matchedChunks;
    if (!chunks || chunks.length === 0) return;
    if (searchJumpedNonce.current === selectionNonce) return;
    searchJumpedNonce.current = selectionNonce ?? null;
    setFilter('all');
    setViewMode('full');            // show the transcript…
    if (messages.length === 0) onLoadFull(); // …and load it if not already in
    setPendingSearchJump(true);
  }, [selectionNonce, searchResult]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pendingSearchJump) return;
    const chunks = searchResult?.matchedChunks;
    if (!chunks || messages.length === 0) return;
    const line = findMatchedLine(messages, chunks);
    if (line != null) {
      setScrollToLine(line);
      setPendingSearchJump(false);
    } else if (!hasMoreMessages) {
      // Matched a summary/title chunk with no message line — stay at the top of
      // the transcript rather than jumping nowhere.
      setPendingSearchJump(false);
    }
  }, [pendingSearchJump, messages, searchResult, hasMoreMessages]); // eslint-disable-line react-hooks/exhaustive-deps

  const [copied, setCopied] = useState(false);
  const [deleteState, setDeleteState] = useState<'idle' | 'confirm' | 'deleting'>('idle');

  /** Delete this conversation everywhere, then leave the view — staying on a
   *  session that no longer exists would show a stale page and a 404 on reload. */
  async function handleDelete() {
    // `sessionId` is nullable for the empty state. The control is gated on it
    // below, so this cannot fire with null — but the check is what tells the
    // compiler that, and it is cheaper than a non-null assertion that would
    // still be a lie if the gate ever moved.
    if (!sessionId) return;
    setDeleteState('deleting');
    try {
      await deleteConversation(sessionId);
      onClose();
    } catch (e) {
      setDeleteState('idle');
      // eslint-disable-next-line no-alert -- the viewer has no toast surface; a
      // silent failure on a delete is worse than a browser dialog.
      alert(e instanceof Error ? e.message : 'Could not delete this conversation');
    }
  }
  const [relatedData, setRelatedData] = useState<RelatedItemsResponse | null>(null);
  const [relatedLoading, setRelatedLoading] = useState(false);
  // Plan opened for full-content reading in the Plans tab (overlay).
  const [openPlan, setOpenPlan] = useState<RelatedItem | null>(null);
  const [sessionMeta, setSessionMeta] = useState<SessionMetadataResponse | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [diffData, setDiffData] = useState<SessionDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [commitsData, setCommitsData] = useState<SessionCommitsResponse | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [outcomeData, setOutcomeData] = useState<SessionOutcomeResponse | null>(null);
  const [outcomeLoading, setOutcomeLoading] = useState(false);
  const [outcomeError, setOutcomeError] = useState<string | null>(null);
  const [secretsData, setSecretsData] = useState<SessionSecretsResponse | null>(null);
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  // Inline conversation-rename (Claude Code's /rename equivalent).
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);
  // Set after a successful rename so the header updates instantly without
  // waiting for a metadata refetch. `undefined` = no local edit this session.
  const [userTitleOverride, setUserTitleOverride] = useState<string | null | undefined>(undefined);

  // Reset cross-section state when session changes AND immediately
  // refetch for whatever tab is currently active. Without the refetch,
  // switching sessions while parked on the Outcome (or Diff / Commits)
  // tab leaves the panel empty until the user manually re-clicks the
  // tab — which they shouldn't have to do.
  useEffect(() => {
    if (!sessionId) return;
    setDiffData(null); setDiffError(null);
    setCommitsData(null); setCommitsError(null);
    setOutcomeData(null); setOutcomeError(null);
    setSecretsData(null); setSecretsError(null);
    setSessionMeta(null);
    setRelatedData(null); setOpenPlan(null);
    setEditingTitle(false); setUserTitleOverride(undefined);

    // Always fetch session metadata up-front so the header title
    // resolves regardless of which tab is open. When you click into a
    // session from Activity (or any context that doesn't pre-populate
    // sessionInfo), the title was falling through every check and
    // landing on "Untitled session" because firstPrompt/projectPath
    // were unavailable until you clicked Summary. This decouples the
    // header from the tab the user happens to start on.
    setMetaLoading(true);
    getSessionMetadata(sessionId)
      .then(setSessionMeta)
      .catch(() => {})
      .finally(() => setMetaLoading(false));

    // Always pre-fetch secrets so the Security tab can show a count
    // badge before the user clicks. Cheap query (single SQL) — fires
    // alongside metadata, no perceivable cost.
    setSecretsLoading(true);
    getSessionSecrets(sessionId)
      .then(setSecretsData)
      .catch(() => {})
      .finally(() => setSecretsLoading(false));

    // Pre-fetch related items so the Plans tab can appear (with a count) before
    // the user clicks — same rationale as the secrets pre-fetch above.
    setRelatedLoading(true);
    getSessionRelated(sessionId)
      .then(setRelatedData)
      .catch(() => {})
      .finally(() => setRelatedLoading(false));

    // Re-fire the fetch for the currently-active tab so the new session's
    // data populates without requiring a second user click.
    if (viewMode === 'outcome' || viewMode === 'summary' || viewMode === 'insights' || viewMode === 'metrics') {
      // Summary (status), Insights (panel), Metrics (duration) all need outcome.
      setOutcomeLoading(true);
      getSessionOutcome(sessionId)
        .then(setOutcomeData)
        .catch(err => setOutcomeError(err instanceof Error ? err.message : 'Failed to load outcome'))
        .finally(() => setOutcomeLoading(false));
    } else if (viewMode === 'diff') {
      setDiffLoading(true);
      getSessionDiff(sessionId)
        .then(setDiffData)
        .catch(err => setDiffError(err instanceof Error ? err.message : 'Failed to load diff'))
        .finally(() => setDiffLoading(false));
    } else if (viewMode === 'commits') {
      setCommitsLoading(true);
      getSessionCommits(sessionId)
        .then(setCommitsData)
        .catch(err => setCommitsError(err instanceof Error ? err.message : 'Failed to load commits'))
        .finally(() => setCommitsLoading(false));
    }
    // viewMode is intentionally NOT in the dep array — we react to
    // sessionId changes only. Tab clicks already fire their own fetches
    // via handleViewModeChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Fetch the active lazy tab's data when the SELECTED TAB changes (keyed on
  // viewMode) — not only on session change or tab CLICK. Navigating in from
  // Activity (or any ?tab= deep link) flips the tab to 'diff'/'commits'/… via
  // initialTab/URL *after* the session-change effect above already ran, so that
  // effect fetched the previous tab and Diff stayed empty until a manual
  // refresh. This closes that gap. Guards (`!data && !loading && !error`) dedupe
  // against the session-change effect and handleViewChange, and let a
  // `_computing` result re-poll (it nulls the data, re-triggering this).
  useEffect(() => {
    if (!sessionId) return;
    if (viewMode === 'diff' && !diffData && !diffLoading && !diffError) {
      setDiffLoading(true);
      getSessionDiff(sessionId)
        .then((d) => { setDiffData(d); if (d._computing) setTimeout(() => setDiffData(null), 2000); })
        .catch((err) => setDiffError(err instanceof Error ? err.message : 'Failed to load diff'))
        .finally(() => setDiffLoading(false));
    } else if (viewMode === 'commits' && !commitsData && !commitsLoading && !commitsError) {
      setCommitsLoading(true);
      getSessionCommits(sessionId)
        .then((d) => { setCommitsData(d); if (d._computing) setTimeout(() => setCommitsData(null), 2000); })
        .catch((err) => setCommitsError(err instanceof Error ? err.message : 'Failed to load commits'))
        .finally(() => setCommitsLoading(false));
    } else if ((viewMode === 'outcome' || viewMode === 'summary' || viewMode === 'insights' || viewMode === 'metrics') && !outcomeData && !outcomeLoading && !outcomeError) {
      setOutcomeLoading(true);
      getSessionOutcome(sessionId)
        .then((d) => { setOutcomeData(d); if (d._computing) setTimeout(() => setOutcomeData(null), 2000); })
        .catch((err) => setOutcomeError(err instanceof Error ? err.message : 'Failed to load outcome'))
        .finally(() => setOutcomeLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, viewMode, diffData, commitsData, outcomeData]);

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

  // Auto-load the full conversation once per (session, mode) pair.
  // We track which (sessionId, viewMode) we've already triggered a load
  // for in a ref. Without this, sessions whose parent JSONL is an empty
  // stub (new-format Claude sessions where everything lives in
  // <id>/subagents/*) loop forever: messages.length stays 0 after every
  // load → effect re-fires → onLoadFull → no new messages → repeat.
  const autoLoadedFor = React.useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!sessionId) return;
    const derivedTool = sessionMeta?.tool || sessionInfo?.tool || 'claude';
    const shouldAutoLoad = derivedTool !== 'claude' || viewMode === 'full' || viewMode === 'trace' || viewMode === 'metrics';
    if (!shouldAutoLoad) return;
    const key = `${sessionId}:${viewMode}`;
    if (autoLoadedFor.current.has(key)) return;
    if (messages.length > 0 || loading) return;
    autoLoadedFor.current.add(key);
    onLoadFull();
  }, [sessionId, sessionMeta?.tool, sessionInfo?.tool, messages.length, loading, onLoadFull, viewMode]);

  // When the user picks a different session the cache resets so the next
  // session can auto-load too.
  useEffect(() => {
    autoLoadedFor.current.clear();
  }, [sessionId, selectionNonce]);

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

  // A paginated load holds a WINDOW of the session, not the session. Every
  // count on screen, and the last message rendered, describe that window —
  // so say so. Presenting `Showing 25 of 1148` for a 500-message window reads
  // as "this session has 25 user messages" when the real answer is unknown
  // until the rest is loaded.
  //
  // `messagesLoaded` counts what survived the client-side command-noise filter,
  // so `remainingMessages` is a close estimate rather than an exact figure.
  const sessionTotal = Math.max(totalMessages ?? 0, messages.length);
  const isWindowed = !!hasMoreMessages && messages.length < sessionTotal;
  const remainingMessages = Math.max(sessionTotal - messages.length, 0);

  // ── Early return ──

  if (!sessionId) {
    return (
      <div
        className="conversation-column"
        data-empty="true"
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

  // One-line title from a summary/prompt — delegates to the canonical
  // cleaner in utils/clean.ts (markdown stripping + placeholder rejection,
  // shared with the list and the code drawer).
  function extractTitle(text: string | undefined): string {
    return summaryTitle(text, 80);
  }
  // Title fallback chain. Always falls back to the project's last segment
  // (e.g. "chat-recall") rather than the opaque session UUID — a path is
  // useful context, the UUID alone is just visual noise.
  const projectFallback = (() => {
    // SessionMetadataResponse uses a different shape; only sessionInfo has
    // projectPath, but searchResult also exposes it.
    const path = sessionInfo?.projectPath || searchResult?.projectPath || '';
    if (!path) return '';
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : '';
  })();
  // A user-assigned name (Claude Code's /rename equivalent) always wins over
  // the auto-derived title. `userTitleOverride` reflects an edit made in this
  // tab before metadata refetches; `undefined` means "no local edit".
  const userTitle =
    (userTitleOverride !== undefined ? userTitleOverride : undefined) ??
    sessionMeta?.userTitle ??
    (sessionInfo?.userTitle ?? null);
  // The tool's own native title (Claude ai-title, OpenCode session.title) sits
  // below a user name but above the AI summary / first prompt.
  const toolTitle = (sessionMeta?.toolTitle ?? sessionInfo?.toolTitle ?? null);
  const autoTitle =
    (toolTitle && toolTitle.trim()) ||
    extractTitle(sessionInfo?.summary) ||
    extractTitle(searchResult?.summary) ||
    extractTitle(sessionInfo?.firstPrompt) ||
    extractTitle(searchResult?.firstPrompt) ||
    extractTitle(firstPrompt) ||
    extractTitle(summary) ||
    sessionMeta?.slug ||
    projectFallback ||
    'Untitled session';
  const title = (userTitle && userTitle.trim()) || autoTitle;

  const saveTitle = async () => {
    if (!sessionId || savingTitle) return;
    setSavingTitle(true);
    try {
      const r = await renameConversation(sessionId, titleDraft.trim());
      setUserTitleOverride(r.userTitle);
      setEditingTitle(false);
    } catch (e) {
      console.error('rename failed', e);
    } finally {
      setSavingTitle(false);
    }
  };

  const handleResume = () => {
    const command = resumeCommandFor(sessionId, tool);
    if (!command) return;
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
    // Full transcript + Generic both need the messages (Generic counts tool
    // calls from them for the activity chart).
    if ((mode === 'full' || mode === 'metrics') && messages.length === 0) {
      onLoadFull();
    }
    if ((mode === 'related' || mode === 'plans') && !relatedData) {
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
    // Summary (status line), Insights (full panel), and Metrics (duration +
    // commit counts) all read the outcome — load it for any of them.
    if ((mode === 'summary' || mode === 'insights' || mode === 'metrics') && (!outcomeData || outcomeData._computing) && !outcomeLoading) {
      setOutcomeLoading(true);
      setOutcomeError(null);
      getSessionOutcome(sessionId)
        .then((d) => {
          setOutcomeData(d);
          if (d._computing) setTimeout(() => { setOutcomeData(null); }, 2000);
        })
        .catch(err => setOutcomeError(err instanceof Error ? err.message : 'Failed to load outcome'))
        .finally(() => setOutcomeLoading(false));
    }
    if (mode === 'metrics' && !sessionMeta) {
      setMetaLoading(true);
      getSessionMetadata(sessionId).then(setSessionMeta).catch(() => {}).finally(() => setMetaLoading(false));
    }
    if (mode === 'diff' && (!diffData || diffData._computing) && !diffLoading) {
      setDiffLoading(true);
      setDiffError(null);
      getSessionDiff(sessionId)
        .then((d) => {
          setDiffData(d);
          // Server still computing — re-fetch in 2s. The precompute
          // worker fills the cache within tens of seconds; polling at
          // 2s gives a snappy resolution without hammering the server.
          if (d._computing) setTimeout(() => { if (mode === 'diff') setDiffData(null); }, 2000);
        })
        .catch(err => setDiffError(err instanceof Error ? err.message : 'Failed to load diff'))
        .finally(() => setDiffLoading(false));
    }
    if (mode === 'commits' && (!commitsData || commitsData._computing) && !commitsLoading) {
      setCommitsLoading(true);
      setCommitsError(null);
      getSessionCommits(sessionId)
        .then((d) => {
          setCommitsData(d);
          if (d._computing) setTimeout(() => { if (mode === 'commits') setCommitsData(null); }, 2000);
        })
        .catch(err => setCommitsError(err instanceof Error ? err.message : 'Failed to load commits'))
        .finally(() => setCommitsLoading(false));
    }
    if (mode === 'outcome' && (!outcomeData || outcomeData._computing) && !outcomeLoading) {
      setOutcomeLoading(true);
      setOutcomeError(null);
      getSessionOutcome(sessionId)
        .then((d) => {
          setOutcomeData(d);
          if (d._computing) setTimeout(() => { if (mode === 'outcome') setOutcomeData(null); }, 2000);
        })
        .catch(err => setOutcomeError(err instanceof Error ? err.message : 'Failed to load outcome'))
        .finally(() => setOutcomeLoading(false));
    }
    setViewMode(mode);
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
            icon="chevronLeft"
            onClick={onClose}
            data-testid="close-conversation"
          >
            Back
          </Button>
          <div style={{ flex: 1 }} />
          {/* Delete lives beside Resume, not in a menu, and it is the only
              ghost-red control on the screen. Removing ONE conversation had no
              UI at all: the endpoint existed and the CLI used it, so a person in
              the dashboard either dropped to a terminal or deleted the whole
              project — which is the wrong thing done because it was the only
              thing reachable. */}
          {sessionId && (deleteState === 'idle' ? (
            <Button
              variant="ghost"
              size="sm"
              icon="trash"
              onClick={() => setDeleteState('confirm')}
              data-testid="delete-conversation"
            >
              Delete
            </Button>
          ) : deleteState === 'confirm' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* The warning is one sentence and it says the two things that are
                  actually in doubt: it cannot be undone, and their own transcript
                  is not being touched. */}
              <span style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>
                Delete permanently? Your local transcript is untouched.
              </span>
              <Button variant="ghost" size="sm" onClick={() => setDeleteState('idle')}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={handleDelete} data-testid="confirm-delete-conversation">
                Delete
              </Button>
            </div>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>Deleting…</span>
          ))}
          {resumeCommandFor(sessionId, tool) && (
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

        {/* Title — with inline rename (Claude Code's /rename equivalent). */}
        {editingTitle ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              placeholder="Name this conversation…"
              maxLength={200}
              style={{
                flex: 1,
                fontSize: 18,
                fontWeight: 600,
                padding: '4px 8px',
                background: 'var(--cr-ink-1)',
                color: 'var(--cr-fg-1)',
                border: '1px solid var(--cr-line-2)',
                borderRadius: 6,
              }}
            />
            <Button onClick={() => void saveTitle()} disabled={savingTitle}>
              {savingTitle ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="ghost" onClick={() => setEditingTitle(false)} disabled={savingTitle}>
              Cancel
            </Button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <h1
              style={{
                fontSize: 18,
                fontWeight: 600,
                letterSpacing: '-0.01em',
                color: 'var(--cr-fg-1)',
                margin: 0,
                wordBreak: 'break-word',
              }}
            >
              {title}
            </h1>
            {sessionId && (
              <button
                type="button"
                title={userTitle ? 'Rename conversation' : 'Name this conversation'}
                onClick={() => { setTitleDraft(userTitle?.trim() || ''); setEditingTitle(true); }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: userTitle ? 'var(--cr-accent, #6ea8fe)' : 'var(--cr-fg-3)',
                  padding: 2,
                  display: 'inline-flex',
                  alignItems: 'center',
                  flexShrink: 0,
                }}
              >
                <Icon name="tag" size={15} />
              </button>
            )}
          </div>
        )}

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
          {/* Only the at-a-glance context chips stay in the header. Git branch
              is quick orientation; cost/savings are one-glance money. Tokens
              and the tools-used list moved to the Metrics tab — they were
              noise up here. */}
          {sessionMeta?.gitBranch && <Chip kind="ok" icon="check">{sessionMeta.gitBranch}</Chip>}
          {sessionMeta?.estimatedCostUsd && sessionMeta.estimatedCostUsd > 0 && (
            <Chip kind="warn">{formatCost(sessionMeta.estimatedCostUsd)}</Chip>
          )}
          {sessionMeta?.cacheSavingsUsd && sessionMeta.cacheSavingsUsd > 0.01 && (
            <Chip kind="ok">saved {formatCost(sessionMeta.cacheSavingsUsd)}</Chip>
          )}
        </div>

        {/* View tabs — each one job. Summary: the AI narrative, readable.
            Insights: the extractions (decisions, blockers, friction). Metrics:
            the numbers + tools/edits. Transcript: the conversation. Changes:
            diff/files/commits. Security appears ONLY when this session actually
            leaked secrets — otherwise it's not a tab. */}
        {(() => {
          const primaryOf = (m: ViewMode): string =>
            (m === 'summary') ? 'summary'
            : (m === 'insights' || m === 'outcome') ? 'insights'
            : (m === 'metrics') ? 'metrics'
            : (m === 'full' || m === 'firstPrompt' || m === 'trace') ? 'transcript'
            : (m === 'diff' || m === 'commits') ? 'changes'
            : m; // 'security' | 'plans'
          const primary = primaryOf(viewMode);
          const findingCount = (() => {
            if (!secretsData) return 0;
            const seen = new Set<string>();
            for (const det of Object.keys(secretsData.byDetector)) {
              for (const f of secretsData.byDetector[det]) seen.add(`${det}|${f.rule}|${f.line}`);
            }
            return seen.size;
          })();
          const planCount = (relatedData?.sessionPlans?.length ?? 0) + (relatedData?.projectPlans?.length ?? 0);
          // Sibling sessions + cross-memory links are unique to the Related view
          // (plans get their own tab). Without a tab this content was unreachable.
          const relatedCount = (relatedData?.siblingSessionsInProject?.length ?? 0) + (relatedData?.links?.length ?? 0);
          const tabs = [
            // Overview leads — the at-a-glance dashboard (default). Recap
            // (Delivered/Not done/Frustrations) and Summary follow.
            { value: 'metrics', label: 'Overview', icon: 'chart' },
            { value: 'insights', label: 'Recap', icon: 'sparkle' },
            { value: 'summary', label: 'Summary', icon: 'file' },
            { value: 'transcript', label: 'Transcript', icon: 'message' },
            { value: 'changes', label: 'Changes', icon: 'terminal' },
            // Plans is conditional: a tab only when this conversation has (or its
            // project has) plans. Linked plans lead; project plans follow.
            ...(planCount > 0 ? [{ value: 'plans', label: `Plans · ${planCount}`, icon: 'file' }] : []),
            // Related is conditional: sibling sessions / cross-memory links.
            ...(relatedCount > 0 ? [{ value: 'related', label: 'Related', icon: 'grid' }] : []),
            // Security is conditional: a tab only when there's something to see.
            ...(findingCount > 0 ? [{ value: 'security', label: `Security · ${findingCount}`, icon: 'check' }] : []),
          ];
          const toMode = (p: string): ViewMode =>
            p === 'transcript' ? 'full' : p === 'changes' ? 'diff' : (p as ViewMode);
          return (
            <>
              <div className="cr-segmented-scroll" style={{ marginBottom: primary === 'changes' ? 10 : 20 }}>
                <SegmentedControl
                  value={primary}
                  onChange={(p) => handleViewChange(toMode(p))}
                  options={tabs}
                />
              </div>
              {primary === 'changes' && (
                <div className="cr-segmented-scroll" style={{ marginBottom: 20 }}>
                  <SegmentedControl
                    value={viewMode}
                    onChange={(m) => handleViewChange(m as ViewMode)}
                    options={[
                      { value: 'diff', label: 'Diff', icon: 'terminal' },
                      { value: 'commits', label: 'Commits', icon: 'sparkle' },
                    ]}
                  />
                </div>
              )}
            </>
          );
        })()}

        {/* Content */}
        {viewMode === 'summary' && (
          <>
            {/* One compact outcome line — status + one-sentence reason. The full
                breakdown (decisions/blockers/markers) lives in Insights so the
                AI narrative below is the star of this tab, not buried under it. */}
            {outcomeData && outcomeData.status && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
                <StatusChip status={outcomeData.status} />
                {outcomeData.reason && (
                  <span style={{ fontSize: 13, color: 'var(--cr-fg-2)' }}>{outcomeData.reason}</span>
                )}
              </div>
            )}
            <StructuredSummary
              summary={summary}
              loading={metaLoading}
              sessionId={sessionId}
            />
          </>
        )}

        {viewMode === 'insights' && (
          <OutcomePanel data={outcomeData} loading={outcomeLoading} error={outcomeError} />
        )}

        {viewMode === 'metrics' && (
          <MetricsPanel
            meta={sessionMeta}
            outcome={outcomeData}
            messages={messages}
            windowed={isWindowed}
            loadedCount={messages.length}
            sessionTotal={sessionTotal}
            onLoadAll={onLoadAllMessages ?? onLoadMoreMessages}
            loadingMore={!!loadingMoreMessages}
            loading={metaLoading}
            onOpenTab={handleViewChange}
            onOpenTools={() => { setFilter('tools'); handleViewChange('full'); }}
            onOpenPrompt={(line) => { setFilter('all'); setScrollToLine(line); handleViewChange('full'); }}
          />
        )}

        {viewMode === 'firstPrompt' && (
          <StructuredFirstPrompt firstPrompt={firstPrompt} />
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
                  {isWindowed ? (
                    <>
                      Showing {filteredMessages.length} of {messages.length} loaded
                      <span style={{ color: 'var(--cr-warn-500)' }}> · {sessionTotal} in session</span>
                    </>
                  ) : (
                    <>Showing {filteredMessages.length} of {sessionTotal} messages</>
                  )}
                  {isWindowed && (onLoadAllMessages || onLoadMoreMessages) && (
                    <button
                      onClick={onLoadAllMessages ?? onLoadMoreMessages}
                      disabled={!!loadingMoreMessages}
                      style={{ marginLeft: 8, fontSize: 11, padding: '1px 8px', borderRadius: 4,
                               border: '1px solid var(--cr-line-1)', background: 'var(--cr-ink-2)',
                               color: 'var(--cr-fg-2)', cursor: loadingMoreMessages ? 'default' : 'pointer',
                               opacity: loadingMoreMessages ? 0.6 : 1 }}
                    >
                      {loadingMoreMessages ? 'loading…' : `load remaining ${remainingMessages}`}
                    </button>
                  )}
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
                <MessageBlock key={`${msg.line}-${idx}`} message={msg} highlight={scrollToLine != null && msg.line === scrollToLine} query={query} />
              ))}

            {/* The window ends here, the session does not. Without this the
                transcript looks finished and the last message on screen reads
                as the last thing that happened. */}
            {!loading && isWindowed && filteredMessages.length > 0 && (
              <div
                style={{
                  marginTop: 16,
                  padding: '14px 16px',
                  border: '1px dashed var(--cr-warn-line)',
                  borderRadius: 'var(--cr-radius-md)',
                  background: 'var(--cr-ink-1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--cr-fg-2)' }}>
                  <strong style={{ color: 'var(--cr-warn-500)' }}>This is not the end of the session.</strong>{' '}
                  {messages.length} of {sessionTotal} messages are loaded — about {remainingMessages} more follow.
                </div>
                {(onLoadAllMessages || onLoadMoreMessages) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!!loadingMoreMessages}
                    onClick={onLoadAllMessages ?? onLoadMoreMessages}
                  >
                    {loadingMoreMessages ? 'Loading…' : 'Load the rest'}
                  </Button>
                )}
              </div>
            )}

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
                        <MessageBlock key={`${sa.id}-${msg.line}-${idx}`} message={msg} query={query} />
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}

        {viewMode === 'trace' && (
          <div style={{ padding: '4px 2px' }}>
            {/* The trace walks the loaded messages, so a window makes it stop
                mid-session. Name that before the user reads the last row as
                the end of the work. */}
            {isWindowed && (
              <div
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
                  marginBottom: 14, padding: '10px 14px', borderRadius: 'var(--cr-radius-md)',
                  border: '1px dashed var(--cr-line-1)', background: 'var(--cr-ink-1)',
                  fontSize: 12, color: 'var(--cr-fg-2)',
                }}
              >
                <span>
                  <strong style={{ color: 'var(--cr-warn-500)' }}>Partial trace.</strong>{' '}
                  {messages.length} of {sessionTotal} messages loaded — the trace ends where the window does.
                </span>
                {(onLoadAllMessages || onLoadMoreMessages) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!!loadingMoreMessages}
                    onClick={onLoadAllMessages ?? onLoadMoreMessages}
                  >
                    {loadingMoreMessages ? 'Loading…' : 'Load the rest'}
                  </Button>
                )}
              </div>
            )}
            <SessionTrace messages={messages} subagents={subagents} />
          </div>
        )}

        {viewMode === 'plans' && (() => {
          const sessionPlans = relatedData?.sessionPlans ?? [];
          const projectPlans = relatedData?.projectPlans ?? [];
          const PlanCard = ({ plan }: { plan: RelatedItem }) => (
            <Card interactive style={{ padding: 14, cursor: 'pointer' }} onClick={() => setOpenPlan(plan)}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--cr-fg-1)', marginBottom: 6 }}>{plan.title}</div>
              {plan.contentPreview && (
                <div style={{ fontSize: 13, color: 'var(--cr-fg-2)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {plan.contentPreview}
                </div>
              )}
            </Card>
          );
          return (
            <div>
              {relatedLoading && !relatedData ? (
                <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>Loading plans...</div>
              ) : sessionPlans.length === 0 && projectPlans.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>No plans for this conversation or project.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                  {sessionPlans.length > 0 && (
                    <div>
                      <h3 style={{ marginBottom: 4, fontSize: 14 }}>This conversation's plan{sessionPlans.length > 1 ? 's' : ''}</h3>
                      <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginBottom: 12 }}>Written in this session.</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: 12 }}>
                        {sessionPlans.map((plan) => <PlanCard key={plan.id} plan={plan} />)}
                      </div>
                    </div>
                  )}
                  {projectPlans.length > 0 && (
                    <div>
                      <h3 style={{ marginBottom: 4, fontSize: 14 }}>Other plans in this project</h3>
                      <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', marginBottom: 12 }}>Not tied to this conversation, but in the same project.</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: 12 }}>
                        {projectPlans.map((plan) => <PlanCard key={plan.id} plan={plan} />)}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {openPlan && (
                <div
                  onClick={() => setOpenPlan(null)}
                  style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', overflowY: 'auto', padding: 'clamp(12px, 5vw, 40px) clamp(12px, 4vw, 20px)' }}
                >
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{ background: 'var(--cr-ink-0)', border: '1px solid var(--cr-line-1)', borderRadius: 12, maxWidth: 940, width: '100%', position: 'relative', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}
                  >
                    <Button
                      variant="ghost"
                      onClick={() => setOpenPlan(null)}
                      style={{ position: 'absolute', top: 12, right: 12, zIndex: 1 }}
                    >
                      <Icon name="x" /> Close
                    </Button>
                    <MemoryDetail
                      item={{
                        id: openPlan.id,
                        source_type: openPlan.sourceType,
                        title: openPlan.title,
                        project_path: openPlan.projectPath,
                        content_preview: openPlan.contentPreview,
                        file_path: '',
                        mtime: openPlan.mtime,
                        indexed_at: openPlan.mtime,
                        extra_json: '',
                      } as MemoryMetadataRow}
                      onSessionClick={onOpenSession}
                      onOpenItem={onOpenItem}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })()}

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
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: 12 }}>
                      {relatedData.links.map((item) => (
                        <Card
                          key={`${item.sourceType}-${item.id}`}
                          interactive
                          onClick={() => (item.sourceType === 'session' ? onOpenSession?.(item.id) : onOpenItem?.(item.sourceType, item.id))}
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
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: 12 }}>
                      {relatedData.projectPlans.map((plan) => (
                        <Card
                          key={plan.id}
                          interactive
                          onClick={() => onOpenItem?.(plan.sourceType, plan.id)}
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
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: 12 }}>
                      {relatedData.siblingSessionsInProject.map((sib) => (
                        <Card
                          key={sib.sessionId}
                          interactive
                          onClick={() => onOpenSession?.(sib.sessionId)}
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

        {viewMode === 'outcome' && (
          <OutcomePanel data={outcomeData} loading={outcomeLoading} error={outcomeError} />
        )}

        {viewMode === 'diff' && (
          <DiffPanel data={diffData} loading={diffLoading} error={diffError} />
        )}

        {viewMode === 'commits' && (
          <CommitsPanel data={commitsData} loading={commitsLoading} error={commitsError} />
        )}

        {viewMode === 'security' && (
          <SecurityPanel data={secretsData} loading={secretsLoading} error={secretsError}
            onJumpToLine={(line) => { setFilter('all'); setScrollToLine(line); handleViewChange('full'); }}
            onManage={onManageSecurity} />
        )}
      </div>
    </div>
  );
}

/**
 * SecurityPanel: surfaces secret detector findings for the current
 * session. Findings come from the `secret_findings` SQLite table which
 * stores ONLY redacted previews — no raw key material is ever
 * transported to the browser. Each row shows detector + named rule +
 * line + masked tail (last 4 chars only) so a reviewer can locate the
 * leak in the source without leaking it again into a UI screenshot.
 *
 * Detector agreement is the trust signal: when more than one detector
 * flags the same line, the finding is high-confidence (likely a real
 * leak); a single-detector hit is "review me" territory.
 */
function SecurityPanel({
  data, loading, error, onJumpToLine, onManage,
}: { data: SessionSecretsResponse | null; loading: boolean; error: string | null; onJumpToLine: (line: number) => void; onManage?: () => void }) {
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  if (loading) return <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>Scanning for secrets…</div>;
  if (error) return <div style={{ padding: 20, color: 'var(--cr-err-500)' }}>Failed to load findings: {error}</div>;
  if (!data) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>No scan data yet for this session.</div>;
  if (data.total === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>
        <Icon name="check" size={28} style={{ opacity: 0.4, marginBottom: 12, color: 'var(--cr-ok-500)' }} />
        <div style={{ fontSize: 14, marginBottom: 6 }}>No secrets detected</div>
        <div style={{ fontSize: 12 }}>gitleaks + trufflehog ran against this session and found nothing.</div>
      </div>
    );
  }

  // Dedupe (detector, rule, line) — the scanner currently inserts the
  // same match multiple times (chunker replays / repeated lines).
  // Then aggregate by `line` so the same line gets one row even if
  // multiple detectors name the same finding differently
  // (gitleaks: `aws-access-token`, trufflehog: `AWS`).
  const seen = new Set<string>();
  // Track max cross-session count per line so we surface the BIGGEST
  // blast radius for any preview on that line — that's the trust
  // signal that matters ("this same key appears in 116 other chats").
  const lineMap = new Map<number, { line: number; detectors: Set<string>; rules: Set<string>; previews: Set<string>; maxCross: number }>();
  for (const detector of Object.keys(data.byDetector)) {
    for (const f of data.byDetector[detector]) {
      const dedupeKey = `${detector}|${f.rule}|${f.line}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      let entry = lineMap.get(f.line);
      if (!entry) {
        entry = { line: f.line, detectors: new Set(), rules: new Set(), previews: new Set(), maxCross: 0 };
        lineMap.set(f.line, entry);
      }
      entry.detectors.add(detector);
      entry.rules.add(`${detector}:${f.rule}`);
      entry.previews.add(f.preview);
      const cross = f.crossSessionCount || 0;
      if (cross > entry.maxCross) entry.maxCross = cross;
    }
  }
  const rows = [...lineMap.values()].sort((a, b) =>
    b.detectors.size - a.detectors.size ||
    a.line - b.line
  );
  const uniqueTotal = seen.size;

  // Per-detector unique counts (after dedup) for the header chips.
  const detectorCounts: Record<string, number> = {};
  for (const k of seen) {
    const d = k.split('|')[0];
    detectorCounts[d] = (detectorCounts[d] || 0) + 1;
  }

  return (
    <div data-testid="conversation-security" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Real findings (gitleaks + trufflehog, run at sync). The action is
          always the same: rotate the exposed credential. */}
      <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cr-err-500)', fontWeight: 600, display: 'flex', gap: 10, alignItems: 'baseline' }}>
        <span>Leaked secrets</span>
        <span style={{ color: 'var(--cr-fg-3)' }}>{uniqueTotal}</span>
        {Object.entries(detectorCounts).map(([d, n]) => (
          <span key={d} style={{ color: 'var(--cr-fg-3)', fontWeight: 500, letterSpacing: 0, textTransform: 'none' }}>{d} {n}</span>
        ))}
      </div>
      <div style={{ padding: '10px 12px', background: 'var(--cr-err-surf, #2a1215)', border: '1px solid var(--cr-err-500)', borderRadius: 'var(--cr-radius-md)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12.5, color: 'var(--cr-fg-2)', lineHeight: 1.5, flex: 1, minWidth: 220 }}>
          <b>These are real, detected here.</b> Rotate each exposed credential at its source (revoke + reissue) — then it no longer matters that it's in an old transcript. Previews show the last 4 chars only; the raw secret was redacted before sync.
        </div>
        {/* Turn the findings into a task list an AI agent can act on — paste
            into Claude Code and let it locate + rotate each one. Never includes
            the raw secret (only type, masked tail, and where it surfaced). */}
        <button
          onClick={() => {
            const tasks = rows.map((r, i) => {
              const rule = [...r.rules].join(', ');
              const tail = [...r.previews][0] || '';
              const cross = r.maxCross > 0 ? ` — also leaked in ${r.maxCross} other session(s)` : '';
              return `${i + 1}. ${rule} (ends …${tail.replace(/[*]/g, '').slice(-4)}) — surfaced at transcript line ${r.line}${cross}`;
            }).join('\n');
            const prompt = `These credentials leaked in one of my AI coding sessions. For EACH: find where the credential actually lives (env file, config, secret manager, CI/CD variable), revoke it at the source, issue a replacement, update every reference, and confirm the old value no longer works. Do not print the new secret back into chat.\n\nLeaked (${rows.length}):\n${tasks}`;
            navigator.clipboard.writeText(prompt).then(() => { setCopiedPrompt(true); setTimeout(() => setCopiedPrompt(false), 1800); });
          }}
          title="Copy a rotation task list to paste into Claude Code (no raw secrets)"
          style={{ background: 'transparent', border: '1px solid var(--cr-err-500)', color: 'var(--cr-err-500)', borderRadius: 6, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
          {copiedPrompt ? 'Copied ✓' : 'Copy fix prompt'}
        </button>
        {onManage && (
          <button onClick={onManage} title="Open the Security dashboard scoped to this conversation's secrets"
            style={{ background: 'var(--cr-err-500)', border: 'none', color: 'var(--cr-on-danger)', borderRadius: 6, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
            Rotate &amp; manage →
          </button>
        )}
      </div>

      {rows.map(row => {
        const agreement = row.detectors.size;
        const tone = agreement >= 2 ? 'err' : 'warn';
        return (
          <div key={row.line} style={{ padding: '12px 14px', background: 'var(--cr-ink-1)', borderLeft: `3px solid var(--cr-${tone === 'err' ? 'err' : 'warn'}-500)`, borderRadius: '0 8px 8px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Chip kind={tone} size="sm">
                {agreement === 1 ? '1 detector' : `${agreement} detectors agree`}
              </Chip>
              {row.maxCross > 0 && (
                // Cross-session blast radius — same redacted key appears
                // in N other sessions, each one a parallel leak vector.
                <Chip kind={row.maxCross >= 10 ? 'err' : 'warn'} size="sm">
                  ⚠ also in {row.maxCross} other session{row.maxCross === 1 ? '' : 's'}
                </Chip>
              )}
              {[...row.rules].map((r) => (
                <span key={r} style={{ fontSize: 11.5, color: 'var(--cr-fg-2)', fontFamily: 'var(--cr-font-mono)' }}>{r}</span>
              ))}
              <span style={{ flex: 1 }} />
              <button onClick={() => onJumpToLine(row.line)} title={`Jump to line ${row.line} in the transcript`}
                style={{ background: 'transparent', border: '1px solid var(--cr-line-2)', color: 'var(--cr-fg-2)', borderRadius: 6, padding: '3px 9px', fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit' }}>
                line {row.line} ›
              </button>
            </div>
            <div style={{ marginTop: 8, fontSize: 12, fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-3)', wordBreak: 'break-all' }}>
              {[...row.previews].join('  ·  ')}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Files tab: shows the list of files this session touched, grouped by extension.
 * Reads sessionMeta.filesModified — populated during indexing from JSONL tool calls.
 * If the session was indexed before file metadata started being captured, the panel
 * shows a hint to re-index.
 */

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

function MessageBlock({ message, highlight, query }: { message: Message; highlight?: boolean; query?: string }) {
  // Rehype plugin that <mark>s literal query-term occurrences in this message's
  // rendered markdown. Memoized on the query so it isn't rebuilt per render.
  const hlPlugin = useMemo(() => makeTermHighlighter(query), [query]);
  const renderContent = () => {
    if (!message.content) return null;
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={hlPlugin ? [hlPlugin] : []}
        components={{
          // Same look as the results-list <mark> (ConversationList) for consistency.
          mark: ({ children }) => (
            <mark style={{ background: 'var(--cr-warn-surf, #553)', color: 'var(--cr-warn-500, #fc6)', padding: '0 2px', borderRadius: 2 }}>
              {children}
            </mark>
          ),
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            if (match && String(children).includes('\n')) {
              return (
                <SyntaxHighlighter
                  language={match[1]}
                  style={vscDarkPlus}
                  customStyle={{ margin: '0.5rem 0', borderRadius: '6px', maxWidth: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehaviorX: 'contain' }}
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
      data-line={message.line}
      style={{
        marginBottom: 40, display: 'flex', gap: 16,
        // Flash the jumped-to prompt so the eye lands on it.
        ...(highlight ? {
          scrollMarginTop: 80,
          background: 'var(--cr-brand-surf, rgba(240,165,58,0.10))',
          boxShadow: '0 0 0 2px var(--cr-brand-500)',
          borderRadius: 'var(--cr-radius-md, 8px)',
          padding: 12, margin: '-12px -12px 28px',
          transition: 'background 0.4s, box-shadow 0.4s',
        } : {}),
      }}
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
                      {isEdit && <Chip kind="ok" size="sm">{diffText ? 'Diff View' : isWrite ? 'File Create' : 'File Edit'}</Chip>}
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
                           <pre style={{ margin: 0, padding: 10, background: 'var(--cr-ink-0)', borderRadius: 6, fontSize: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehaviorX: 'contain', border: '1px solid var(--cr-ok-line)' }}>
                             <code>{JSON.stringify(tc.input, null, 2)}</code>
                           </pre>
                         </div>
                      ) : (
                        <pre style={{ margin: 0, padding: 10, background: 'var(--cr-ink-0)', borderRadius: 6, fontSize: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehaviorX: 'contain' }}>
                          <code>{JSON.stringify(tc.input, null, 2)}</code>
                        </pre>
                      )}

                      {tc.result && (
                        <>
                          <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginBottom: 6, marginTop: 14, textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.02em' }}>Result</div>
                          <pre style={{ margin: 0, padding: 10, background: 'var(--cr-ink-0)', borderRadius: 6, fontSize: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehaviorX: 'contain', opacity: 0.9 }}>
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

// ────────────────────────────── Outcome / Diff / Commits panels ──────────────────────────────
// Three new tabs added on top of the original viewer:
//   - Outcome: shipped/interrupted/abandoned status, decisions, blockers,
//     last-claim-vs-reaction, prompt marker counts.
//   - Diff: per-file unified diff replayed from Edit/Write tool calls.
//   - Commits: git commits across all repos this session touched.
//
// All three call the dedicated HTTP routes added to the conversations router
// and are loaded lazily on first switch (see handleViewChange).

function StatusChip({ status }: { status: SessionOutcomeResponse['status'] }) {
  const map: Record<SessionOutcomeResponse['status'], { label: string; kind: Parameters<typeof Chip>[0]['kind']; icon?: string }> = {
    shipped: { label: 'Shipped', kind: 'ok', icon: 'check' },
    interrupted: { label: 'Interrupted', kind: 'warn' },
    abandoned: { label: 'Abandoned', kind: 'err' },
    in_progress: { label: 'In progress', kind: 'info' },
    unknown: { label: 'Unknown', kind: 'neutral' },
  };
  const m = map[status] || map.unknown;
  return <Chip kind={m.kind} icon={m.icon}>{m.label}</Chip>;
}

const MARKER_STYLES: Record<PromptMarker, { label: string; kind: Parameters<typeof Chip>[0]['kind']; symbol: string }> = {
  interrupt: { label: 'interrupt', kind: 'warn', symbol: '⏸' },
  frustrated: { label: 'frustrated', kind: 'err', symbol: '⚠' },
  correction: { label: 'correction', kind: 'warn', symbol: '↩' },
  approval: { label: 'approval', kind: 'ok', symbol: '✓' },
  question: { label: 'question', kind: 'info', symbol: '?' },
  directive: { label: 'directive', kind: 'neutral', symbol: '▸' },
  clarification_request: { label: 'clarify', kind: 'info', symbol: '◇' },
};

function MarkerChip({ marker }: { marker: PromptMarker }) {
  const m = MARKER_STYLES[marker];
  if (!m) return null;
  return <Chip kind={m.kind} size="sm">{m.symbol} {m.label}</Chip>;
}

/* ────────────────────────────── Metrics ────────────────────────────── */

/** The numbers behind a session: cost + tokens, size (messages/duration/files/
 *  commits), and the tools it called. All the quantitative stuff that used to
 *  clutter the header now lives on its own tab. */
/** Humanize a tool id for display. Raw MCP ids like
 *  `mcp__chat-recall__recall_smart_resume` are unreadable — show a clean
 *  "smart resume" (full id in the tooltip). Built-ins pass through. */
function prettyToolName(raw: string): string {
  if (raw.startsWith('mcp__')) {
    const parts = raw.slice(5).split('__');
    const tool = (parts[1] || parts[0] || raw).replace(/^recall_/, '').replace(/_/g, ' ');
    return tool || raw;
  }
  return raw;
}

/**
 * Metrics = the session at a glance. Not a bare number grid — it answers the
 * questions you actually ask: did it ship, how big/expensive was it, was it
 * painful (friction), did it leave red flags (blockers, leaked secrets)? The
 * quantitative stats sit next to the qualitative signals pulled from the
 * outcome + security scan, each deep-linking to the tab with the detail.
 */
function MetricsPanel({
  meta, outcome, messages, windowed, loadedCount, sessionTotal, onLoadAll, loadingMore,
  loading, onOpenTab, onOpenTools, onOpenPrompt,
}: {
  meta: SessionMetadataResponse | null;
  outcome: SessionOutcomeResponse | null;
  messages: Message[];
  /** True when `messages` is a page of the session rather than all of it. The
   *  tool counts and prompt jumps below are derived from `messages`, so they
   *  describe the loaded window and must be labelled as such. */
  windowed?: boolean;
  loadedCount?: number;
  sessionTotal?: number;
  onLoadAll?: () => void;
  loadingMore?: boolean;
  loading: boolean;
  onOpenTab: (m: ViewMode) => void;
  onOpenTools: () => void;
  onOpenPrompt: (line: number) => void;
}) {
  if (loading && !meta) return <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>Loading…</div>;
  if (!meta) return <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>No data for this session.</div>;

  const fmtN = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
  const fmtCost = (n: number | null) => n == null ? '—' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
  const dur = meta.durationMs > 0
    ? (meta.durationMs >= 3600_000 ? `${(meta.durationMs / 3600_000).toFixed(1)}h` : `${Math.round(meta.durationMs / 60000)} min`)
    : '—';

  const filesAdded = outcome?.totalLinesAdded ?? 0;
  const filesRemoved = outcome?.totalLinesRemoved ?? 0;

  // Tool activity — counted from the transcript. This is where "what happened"
  // lives: web fetches, edits, reads, bash, MCP calls, each with a magnitude.
  // We also estimate the TOKEN WEIGHT each tool pulled in, from the size of its
  // input+result text (~4 chars/token) — so you can see which tools ate the
  // context (a Read of a huge file, a WebFetch, a noisy Bash), not just how
  // often they ran.
  const toolCounts = new Map<string, number>();
  const toolTokens = new Map<string, number>();
  let toolErrors = 0;
  for (const m of messages) {
    for (const tc of m.toolCalls || []) {
      toolCounts.set(tc.name, (toolCounts.get(tc.name) || 0) + 1);
      if (tc.isError) toolErrors++;
      let bytes = 0;
      try { bytes = JSON.stringify(tc.input ?? '').length + JSON.stringify(tc.result ?? '').length; } catch { /* circular — skip */ }
      toolTokens.set(tc.name, (toolTokens.get(tc.name) || 0) + Math.round(bytes / 4));
    }
  }
  const tools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
  const toolTotal = tools.reduce((s, [, n]) => s + n, 0);
  const maxTool = Math.max(1, ...tools.map(([, n]) => n));
  const toolsByTokens = [...toolTokens.entries()].filter(([, t]) => t > 0).sort((a, b) => b[1] - a[1]);
  const maxToolTokens = Math.max(1, ...toolsByTokens.map(([, t]) => t));

  // The outcome's prompts don't carry transcript line numbers, so map each
  // prompt back to its user message by text — that message's line is the jump
  // target for the Session-arc bars.
  const userMsgs = messages.filter(m => m.role === 'user' && m.content);
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const lineForPrompt = (text: string): number | undefined => {
    const key = norm(text).slice(0, 30);
    if (key.length < 6) return undefined;
    return userMsgs.find(u => norm(u.content).includes(key))?.line;
  };

  // Color a tool by the KIND of work it does — shared by both tool charts.
  // Normalized (lowercased, separators stripped) so it recognizes every
  // tool's verbs, not just Claude's: Antigravity (write_to_file,
  // replace_file_content, run_command, view_file), Gemini (write_file,
  // read_many_files), Codex (apply_patch, shell), etc. Without this, non-Claude
  // tool names fell through to the generic color and the Overview couldn't show
  // what type of requests a session was made of.
  const toolKindColor = (name: string): string => {
    if (name.startsWith('mcp__')) return 'var(--cr-brand-500)';
    const n = name.toLowerCase().replace(/[_-]/g, '');
    if (/(webfetch|websearch|readwebpage|browse|fetchurl)/.test(n)) return 'var(--cr-info-500)';
    if (/(edit|write|replace|applypatch|createfile|patch)/.test(n)) return 'var(--cr-ok-500)';
    if (/(bash|shell|runcommand|runterminal|terminal|exec|command)/.test(n)) return 'var(--cr-warn-500)';
    if (/(read|view|glob|grep|^ls$|listdir|listdirectory|search|findfile|cat)/.test(n)) return 'var(--cr-fg-3)';
    if (/(task|agent|subagent)/.test(n)) return 'var(--cr-tool-claude, #c98bff)';
    return 'var(--cr-fg-2)';
  };

  // Shared section caption + stat cell, so every block on this tab reads with
  // the same rhythm (uppercase caption → aligned content).
  const cap: React.CSSProperties = { fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cr-fg-3)', fontWeight: 600, margin: '0 0 12px' };
  const StatInline = ({ label, value, sub, tone, onClick }: { label: string; value: string; sub?: React.ReactNode; tone?: string; onClick?: () => void }) => (
    <div onClick={onClick} style={{ cursor: onClick ? 'pointer' : 'default' }} title={onClick ? 'Open detail' : undefined}>
      <div style={{ fontSize: 21, fontWeight: 700, color: tone || 'var(--cr-fg-1)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--cr-fg-3)', letterSpacing: '0.02em', marginTop: 3 }}>
        {label}{sub ? <> · {sub}</> : null}{onClick ? ' ›' : ''}
      </div>
    </div>
  );

  return (
    <div data-testid="conversation-metrics" style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
      {/* Transcript-derived numbers below (tool activity, tokens by tool, the
          session arc jumps) count only the messages that are loaded. Say which
          figures are partial instead of letting a window pass for a session. */}
      {windowed && (
        <div
          data-testid="metrics-window-notice"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
            padding: '10px 14px', borderRadius: 'var(--cr-radius-md)',
            border: '1px dashed var(--cr-line-1)', background: 'var(--cr-ink-1)',
            fontSize: 12, color: 'var(--cr-fg-2)',
          }}
        >
          <span>
            <strong style={{ color: 'var(--cr-warn-500)' }}>Partial.</strong>{' '}
            Tool activity and token-by-tool cover the {loadedCount ?? 0} messages loaded, not all {sessionTotal ?? 0}.
            Cost, tokens and duration come from the server and are complete.
          </span>
          {onLoadAll && (
            <Button variant="secondary" size="sm" disabled={loadingMore} onClick={onLoadAll}>
              {loadingMore ? 'Loading…' : 'Load the rest'}
            </Button>
          )}
        </div>
      )}

      {/* Outcome headline — the one-line answer to "how did it end". */}
      {outcome?.status && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <StatusChip status={outcome.status} />
          {outcome.reason && <span style={{ fontSize: 13, color: 'var(--cr-fg-2)' }}>{outcome.reason}</span>}
        </div>
      )}

      {/* Work done — same caption + aligned grid as every other section, so it
          no longer reads as a stray header. Files/Commits/Tool calls drill in. */}
      <div>
        <div style={cap}>Work done</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(108px, 1fr))', gap: '16px 20px' }}>
          <StatInline label="messages" value={fmtN(meta.messageCount || 0)} />
          <StatInline label="duration" value={dur} />
          <StatInline label="files" value={String(outcome?.fileCount ?? meta.filesModified?.length ?? 0)}
            sub={(filesAdded || filesRemoved) ? <><span style={{ color: 'var(--cr-ok-500)' }}>+{filesAdded.toLocaleString()}</span> <span style={{ color: 'var(--cr-err-500)' }}>−{filesRemoved.toLocaleString()}</span></> : undefined}
            onClick={() => onOpenTab('diff')} />
          <StatInline label="commits" value={String(outcome?.commits?.totalCommits ?? 0)}
            sub={outcome?.commits?.repos?.length ? `${outcome.commits.repos.length} repo(s)` : undefined}
            onClick={() => onOpenTab('commits')} />
          {toolTotal > 0 && <StatInline label="tool calls" value={fmtN(toolTotal)}
            sub={toolErrors > 0 ? <span style={{ color: 'var(--cr-err-500)' }}>{toolErrors} failed</span> : undefined}
            onClick={onOpenTools} />}
        </div>
      </div>

      {/* Context window — a single value against its ceiling. A gauge is the
          right form; it makes "you blew past the window" visible instead of a
          bare 293.7k that means nothing without the limit. */}
      {(meta.peakContextTokens || 0) > 0 && (() => {
        const CTX = 200_000; // Claude context window (approx); the insight is the ratio.
        const peak = meta.peakContextTokens;
        const pct = peak / CTX;
        const over = pct > 1;
        const near = pct > 0.85;
        const color = over ? 'var(--cr-err-500)' : near ? 'var(--cr-warn-500)' : 'var(--cr-brand-500)';
        return (
          <div>
            <div style={cap}>Context window</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
              <span style={{ color: 'var(--cr-fg-2)' }}>peak {fmtN(peak)} <span style={{ color: 'var(--cr-fg-3)' }}>/ 200k</span></span>
              <span style={{ color, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(pct * 100)}%{over ? ' · over window' : ''}
              </span>
            </div>
            <div style={{ position: 'relative', height: 8, borderRadius: 4, background: 'var(--cr-ink-2)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(pct, 1) * 100}%`, height: '100%', background: color, borderRadius: 4 }} />
            </div>
          </div>
        );
      })()}

      {/* Session arc — the emotional shape of the session over time. One bar
          per prompt, height by intensity, colored by its strongest marker.
          A red spike three-quarters through = where it went sideways. */}
      {outcome?.prompts && outcome.prompts.length > 1 && (() => {
        const markerColor = (ms: PromptMarker[]) =>
          ms.includes('frustrated') ? 'var(--cr-err-500)'
          : (ms.includes('correction') || ms.includes('interrupt')) ? 'var(--cr-warn-500)'
          : ms.includes('approval') ? 'var(--cr-ok-500)'
          : (ms.includes('question') || ms.includes('clarification_request')) ? 'var(--cr-info-500)'
          : 'var(--cr-fg-3)';
        return (
          <div>
            <div style={cap}>Session arc · {outcome.prompts.length} prompts</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 52, background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-md)', padding: '8px 10px' }}>
              {outcome.prompts.map((p, i) => {
                const strong = p.markers.some(m => m === 'frustrated' || m === 'correction' || m === 'interrupt');
                const h = 25 + Math.min(p.intensity || (p.markers.length ? 2 : 1), 5) / 5 * 75;
                const jumpLine = typeof p.line === 'number' ? p.line : lineForPrompt(p.text);
                const jumpable = typeof jumpLine === 'number';
                return (
                  <div key={i}
                    onClick={jumpable ? () => onOpenPrompt(jumpLine as number) : undefined}
                    title={`#${i + 1} · ${p.markers.join(', ') || 'neutral'}\n${p.text.slice(0, 160)}${jumpable ? '\n\nClick to jump to this prompt in the transcript' : ''}`}
                    style={{ flex: 1, minWidth: 3, maxWidth: 22, height: `${h}%`, background: markerColor(p.markers), borderRadius: 2, opacity: strong || p.markers.includes('approval') ? 1 : 0.45, cursor: jumpable ? 'pointer' : 'default' }} />
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginTop: 4 }}>Each bar is a prompt, tallest = most intense · red = frustrated, green = approval · click a bar to jump to it ›</div>
          </div>
        );
      })()}

      {/* Prompt markers — categorical counts as a proper bar chart (not lopsided:
          each marker type is its own bar). Colored by sentiment, worst first. */}
      {outcome?.promptMarkers && outcome.promptMarkers.total > 0 && (() => {
        const KIND: Record<string, string> = { err: 'var(--cr-err-500)', warn: 'var(--cr-warn-500)', ok: 'var(--cr-ok-500)', info: 'var(--cr-info-500)', neutral: 'var(--cr-fg-3)' };
        const keys = (['frustrated', 'correction', 'interrupt', 'clarification_request', 'question', 'directive', 'approval'] as PromptMarker[])
          .filter(k => outcome.promptMarkers[k] > 0);
        const maxN = Math.max(1, ...keys.map(k => outcome.promptMarkers[k]));
        return (
          <div>
            <div style={cap}>Prompt markers</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {keys.map(k => {
                const n = outcome.promptMarkers[k];
                const s = MARKER_STYLES[k];
                return (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ width: 92, fontSize: 12, color: 'var(--cr-fg-2)', flexShrink: 0 }}>{s.symbol} {s.label}</span>
                    <div style={{ flex: 1, height: 14, background: 'var(--cr-ink-2)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${(n / maxN) * 100}%`, height: '100%', background: KIND[s.kind || 'neutral'], borderRadius: 3, minWidth: 3 }} />
                    </div>
                    <span style={{ width: 26, textAlign: 'right', fontSize: 12, color: 'var(--cr-fg-1)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{n}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Activity — what the AI actually DID, counted from the transcript.
          Web fetches, edits, reads, bash, MCP calls — each a bar, colored by
          kind of work. This is the "what happened" the user asked for. Opens
          the transcript for the raw calls. */}
      {tools.length > 0 && (
        <div>
          <div style={cap}>Activity · {toolTotal} tool calls{toolErrors > 0 && <span style={{ color: 'var(--cr-err-500)' }}> · {toolErrors} failed</span>}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {tools.slice(0, 16).map(([name, n]) => (
              <div key={name} onClick={onOpenTools} title={`${name} — ${n} call(s). Open the tool calls in the transcript.`}
                style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <span style={{ flex: '0 1 150px', minWidth: 0, fontSize: 12, color: 'var(--cr-fg-2)', fontFamily: 'var(--cr-font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{prettyToolName(name)}</span>
                <div style={{ flex: 1, height: 14, background: 'var(--cr-ink-2)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${(n / maxTool) * 100}%`, height: '100%', background: toolKindColor(name), borderRadius: 3, minWidth: 3 }} />
                </div>
                <span style={{ width: 30, textAlign: 'right', flexShrink: 0, fontSize: 12, color: 'var(--cr-fg-1)', fontVariantNumeric: 'tabular-nums' }}>{n}</span>
              </div>
            ))}
            {tools.length > 16 && <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>+{tools.length - 16} more tool(s)</div>}
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--cr-fg-3)', marginTop: 8 }}>
            <span><span style={{ color: 'var(--cr-ok-500)' }}>■</span> edits</span>
            <span><span style={{ color: 'var(--cr-info-500)' }}>■</span> web</span>
            <span><span style={{ color: 'var(--cr-warn-500)' }}>■</span> shell</span>
            <span><span style={{ color: 'var(--cr-brand-500)' }}>■</span> recall/MCP</span>
            <span><span style={{ color: 'var(--cr-fg-3)' }}>■</span> reads</span>
          </div>
        </div>
      )}

      {/* Tokens by tool — which tools ate the context. Estimated from each
          call's input+result size (~4 chars/token); a Read of a big file or a
          WebFetch dwarfs a dozen small Edits. Different story than call count. */}
      {toolsByTokens.length > 0 && (
        <div>
          <div style={cap}>Tokens by tool · approx from I/O</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {toolsByTokens.slice(0, 12).map(([name, t]) => (
              <div key={name} onClick={onOpenTools} title={`${name} — ~${fmtN(t)} tokens of input+output across its calls.`}
                style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <span style={{ flex: '0 1 150px', minWidth: 0, fontSize: 12, color: 'var(--cr-fg-2)', fontFamily: 'var(--cr-font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{prettyToolName(name)}</span>
                <div style={{ flex: 1, height: 14, background: 'var(--cr-ink-2)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${(t / maxToolTokens) * 100}%`, height: '100%', background: toolKindColor(name), borderRadius: 3, minWidth: 3 }} />
                </div>
                <span style={{ width: 42, textAlign: 'right', flexShrink: 0, fontSize: 12, color: 'var(--cr-fg-1)', fontVariantNumeric: 'tabular-nums' }}>{fmtN(t)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cost & tokens — a visual composition, not a value list. Where the
          tokens went (input / output / cache) as a stacked bar + legend with
          counts and %, cost as the headline, model inline. */}
      {(() => {
        const seg = [
          { key: 'Input', n: meta.inputTokens || 0, c: 'var(--cr-info-500)' },
          { key: 'Output', n: meta.outputTokens || 0, c: 'var(--cr-brand-500)' },
          { key: 'Cache read', n: meta.cacheReadTokens || 0, c: 'var(--cr-ok-500)' },
          { key: 'Cache write', n: meta.cacheCreationTokens || 0, c: 'var(--cr-tool-claude, #c98bff)' },
        ].filter(s => s.n > 0);
        const total = seg.reduce((s, x) => s + x.n, 0);
        return (
          <div>
            <div style={cap}>Cost &amp; tokens</div>
            <div style={{ display: 'flex', gap: '18px 34px', flexWrap: 'wrap', marginBottom: 14 }}>
              {meta.estimatedCostUsd != null && <StatInline label="cost" value={fmtCost(meta.estimatedCostUsd)} tone="var(--cr-warn-500)" />}
              {meta.cacheSavingsUsd != null && meta.cacheSavingsUsd > 0.01 && <StatInline label="cache saved" value={fmtCost(meta.cacheSavingsUsd)} tone="var(--cr-ok-500)" />}
              <StatInline label="total tokens" value={fmtN(total)} />
              {meta.modelsUsed?.length ? <StatInline label="model" value={meta.modelsUsed.join(', ')} /> : null}
            </div>
            {total > 0 && (
              <>
                <div style={{ display: 'flex', height: 12, borderRadius: 4, overflow: 'hidden', gap: 2, background: 'var(--cr-ink-2)' }}>
                  {seg.map(s => <div key={s.key} title={`${s.key}: ${fmtN(s.n)} (${Math.round(s.n / total * 100)}%)`} style={{ width: `${(s.n / total) * 100}%`, background: s.c, minWidth: 2 }} />)}
                </div>
                <div style={{ display: 'flex', gap: '6px 18px', flexWrap: 'wrap', marginTop: 8, fontSize: 12 }}>
                  {seg.map(s => (
                    <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--cr-fg-2)' }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: s.c }} />
                      {s.key} <b style={{ color: 'var(--cr-fg-1)', fontVariantNumeric: 'tabular-nums' }}>{fmtN(s.n)}</b>
                      <span style={{ color: 'var(--cr-fg-3)' }}>{Math.round(s.n / total * 100)}%</span>
                    </span>
                  ))}
                </div>
              </>
            )}
            <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginTop: 10 }}>
              Per-tool cost isn't recorded upstream — tokens are billed per message, not per action.
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function OutcomePanel({
  data, loading, error,
}: { data: SessionOutcomeResponse | null; loading: boolean; error: string | null }) {
  if (loading) return <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>Computing outcome…</div>;
  if (error) return <div style={{ padding: 20, color: 'var(--cr-err-500)' }}>Failed to load outcome: {error}</div>;
  if (!data) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>No outcome data.</div>;
  // 202 placeholder — outcome is being computed in the background. The
  // body has none of the structured fields below (commits, prompts,
  // promptMarkers) so accessing them throws.
  if (data._computing || !data.commits || !data.promptMarkers) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>
        <div style={{ fontSize: 14, marginBottom: 6 }}>Computing outcome in the background…</div>
        <div style={{ fontSize: 12 }}>One-time cost for this session — reopen in a moment.</div>
      </div>
    );
  }

  const minutes = data.startMs && data.endMs ? Math.round((data.endMs - data.startMs) / 60000) : 0;

  // ── Three human questions: what got delivered, what didn't, what frustrated
  //    you. Each bucket is built from the raw outcome fields.
  const commits = data.commits.repos.flatMap(r => r.commits.map(c => ({ ...c, repoName: r.repoName })));
  const frustPrompts = data.prompts.filter(p => p.markers.includes('frustrated') || p.markers.includes('correction'));
  const reactionNegative = data.claimReaction.reaction?.markers?.some(m => m === 'frustrated' || m === 'correction');
  const unfinished = data.status === 'interrupted' || data.status === 'abandoned';

  // Same caption rhythm as the Overview tab — uppercase 11px label, tinted by
  // the section's tone so the green/amber/red meaning still reads at a glance.
  const Section = ({ tone, title, count, children }: { tone: string; title: string; count?: number; children: React.ReactNode }) => (
    <div>
      <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, color: tone, margin: '0 0 12px', display: 'flex', gap: 8, alignItems: 'baseline' }}>
        {title}{count != null && <span style={{ color: 'var(--cr-fg-3)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>}
      </div>
      {children}
    </div>
  );
  const item: React.CSSProperties = { padding: '10px 14px', background: 'var(--cr-ink-1)', borderLeft: '2px solid var(--cr-line-2)', borderRadius: '0 6px 6px 0', fontSize: 13, color: 'var(--cr-fg-1)', lineHeight: 1.5 };
  const list: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
  const empty = (txt: string) => <div style={{ fontSize: 13, color: 'var(--cr-fg-3)', fontStyle: 'italic', padding: '2px 2px' }}>{txt}</div>;

  return (
    <div data-testid="conversation-outcome" style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
      {/* Headline */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <StatusChip status={data.status} />
        <span style={{ fontSize: 13, color: 'var(--cr-fg-2)' }}>{data.reason}</span>
      </div>

      {/* ✅ DELIVERED — commits that landed + decisions concluded. */}
      <Section tone="var(--cr-ok-500)" title="Delivered">
        <div style={list}>
          {commits.length === 0 && data.decisions.length === 0 && data.fileCount === 0 && empty('Nothing shipped — no commits or file changes in this session.')}
          {data.fileCount > 0 && (
            <div style={{ ...item, borderLeftColor: 'var(--cr-ok-500)' }}>
              <b>{data.fileCount} file(s) changed</b>{' '}
              <span style={{ color: 'var(--cr-ok-500)' }}>+{data.totalLinesAdded}</span>{' '}
              <span style={{ color: 'var(--cr-err-500)' }}>−{data.totalLinesRemoved}</span>
              {commits.length === 0 && <span style={{ color: 'var(--cr-warn-500)', marginLeft: 8, fontSize: 12 }}>· never committed</span>}
            </div>
          )}
          {commits.slice(0, 12).map((c) => (
            <div key={c.sha} style={{ ...item, borderLeftColor: 'var(--cr-ok-500)' }}>
              <span style={{ fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-3)', fontSize: 11.5 }}>{c.shortSha}</span>{' '}
              {c.subject}
              <span style={{ color: 'var(--cr-fg-3)', fontSize: 11.5 }}> · {c.repoName} · <span style={{ color: 'var(--cr-ok-500)' }}>+{c.linesAdded}</span> <span style={{ color: 'var(--cr-err-500)' }}>−{c.linesRemoved}</span></span>
            </div>
          ))}
          {data.decisions.slice(0, 12).map((d, i) => (
            <div key={`d${i}`} style={{ ...item, borderLeftColor: 'var(--cr-ok-500)' }}>
              <span style={{ color: 'var(--cr-fg-3)', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em', marginRight: 6 }}>decided</span>
              {d.text}
            </div>
          ))}
        </div>
      </Section>

      {/* 🚧 NOT DONE — blockers, failed tool calls, interrupted/abandoned, a
          claim the user never confirmed. */}
      <Section tone="var(--cr-warn-500)" title="Not done / blocked" count={data.blockers.length || undefined}>
        <div style={list}>
          {data.blockers.length === 0 && !unfinished && empty('Nothing recorded as blocked.')}
          {unfinished && (
            <div style={{ ...item, borderLeftColor: 'var(--cr-warn-500)' }}>
              <b style={{ color: 'var(--cr-warn-500)' }}>Session {data.status}.</b> {data.reason}
            </div>
          )}
          {data.blockers.slice(0, 15).map((b, i) => (
            <div key={i} style={{ ...item, borderLeftColor: 'var(--cr-warn-500)' }}>
              <span style={{ color: 'var(--cr-warn-500)', fontWeight: 600, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.03em', marginRight: 6 }}>
                {b.kind.replace('_', ' ')}
              </span>
              {b.text.length > 300 ? b.text.slice(0, 300) + '…' : b.text}
            </div>
          ))}
          {data.claimReaction.claim && !data.claimReaction.reaction && (
            <div style={{ ...item, borderLeftColor: 'var(--cr-warn-500)' }}>
              <span style={{ color: 'var(--cr-fg-3)', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em', marginRight: 6 }}>unconfirmed</span>
              Ended on “{data.claimReaction.claim.text.slice(0, 200)}” — you never replied, so it may not actually be done.
            </div>
          )}
        </div>
      </Section>

      {/* 😖 FRUSTRATIONS — the moments you pushed back, in your own words. */}
      <Section tone="var(--cr-err-500)" title="Frustrations" count={data.promptMarkers.frustrated || undefined}>
        <div style={list}>
          {frustPrompts.length === 0 && !reactionNegative && empty('No pushback — this one went smoothly.')}
          {data.claimReaction.claim && reactionNegative && (
            <div style={{ ...item, borderLeftColor: 'var(--cr-err-500)' }}>
              <div style={{ color: 'var(--cr-fg-3)', fontSize: 11.5, marginBottom: 4 }}>AI claimed “{data.claimReaction.claim.text.slice(0, 140)}” — you reacted:</div>
              <div>{data.claimReaction.reaction!.text.slice(0, 240)}</div>
            </div>
          )}
          {frustPrompts.slice(0, 12).map((p, i) => (
            <div key={i} style={{ ...item, borderLeftColor: 'var(--cr-err-500)' }}>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 3 }}>
                {p.markers.filter(m => m === 'frustrated' || m === 'correction').map(m => <MarkerChip key={m} marker={m} />)}
              </div>
              {p.text.length > 240 ? p.text.slice(0, 240) + '…' : p.text}
            </div>
          ))}
        </div>
      </Section>

      <div style={{ fontSize: 11.5, color: 'var(--cr-fg-3)', borderTop: '1px solid var(--cr-line-1)', paddingTop: 10 }}>
        {minutes > 0 && `${minutes} min · `}{data.promptMarkers.total} prompt(s) · peak friction {data.promptMarkers.peakIntensity}/5
      </div>
    </div>
  );
}

/* ────────────────────────────── Structured Summary ────────────────────────────── */

function StructuredSummary({
  summary,
  loading,
  sessionId,
}: { summary: string; loading: boolean; sessionId?: string | null }) {
  const [override, setOverride] = useState<string | null>(null);
  const [regenLoading, setRegenLoading] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

  // Reset local override when navigating to a different session.
  useEffect(() => {
    setOverride(null);
    setRegenError(null);
  }, [sessionId]);

  const displaySummary = override ?? summary;
  const isPlaceholder = !displaySummary
    || /^no (summary|first prompt)( available)?$/i.test(displaySummary);

  async function handleRegenerate() {
    if (!sessionId || regenLoading) return;
    setRegenLoading(true);
    setRegenError(null);
    try {
      const r = await regenerateSummary(sessionId);
      setOverride(r.summary);
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegenLoading(false);
    }
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>Loading…</div>;
  }

  const regenButton = sessionId ? (
    <Button
      onClick={handleRegenerate}
      disabled={regenLoading}
      style={{ marginLeft: 'auto' }}
      title="Re-run the AI summary for this session"
    >
      <Icon name="zap" size={13} style={{ marginRight: 6 }} />
      {regenLoading ? 'Regenerating…' : 'Regenerate'}
    </Button>
  ) : null;

  if (isPlaceholder) {
    return (
      <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>
        <Icon name="file" size={28} style={{ opacity: 0.3, marginBottom: 12 }} />
        <div style={{ fontSize: 14 }}>No summary available for this session.</div>
        <div style={{ fontSize: 12, marginTop: 6 }}>
          Summaries are generated by your configured AI provider. Check Settings → Summary.
        </div>
        {regenButton && (
          <div style={{ marginTop: 16, display: 'inline-flex' }}>{regenButton}</div>
        )}
        {regenError && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--cr-danger, #d33)' }}>
            {regenError}
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-testid="conversation-summary">
      <Card style={{ padding: 20, borderColor: 'var(--cr-brand-line)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 18 }}>
          <span style={{
            width: 24, height: 24, display: 'inline-flex', alignItems: 'center',
            justifyContent: 'center', background: 'var(--cr-brand-500)',
            borderRadius: 6, flexShrink: 0, marginTop: 1,
          }}>
            <Icon name="file" size={13} style={{ color: 'var(--cr-on-brand)' }} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--cr-fg-1)', letterSpacing: '-0.005em' }}>
              AI Summary
            </div>
            <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>
              {override
                ? 'Just regenerated — not yet persisted to search index'
                : "Generated summary of this session's activity"}
            </div>
          </div>
          {regenButton}
        </div>

        {regenError && (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: 'var(--cr-danger-surf, #2a0f0f)',
                        border: '1px solid var(--cr-danger-line, #5a1f1f)', borderRadius: 6,
                        fontSize: 12, color: 'var(--cr-danger, #ff8a8a)' }}>
            {regenError}
          </div>
        )}

        <div style={{
          fontSize: 13.5,
          lineHeight: 1.7,
          color: 'var(--cr-fg-1)',
        }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{displaySummary}</ReactMarkdown>
        </div>
      </Card>
    </div>
  );
}

/* ────────────────────────────── Structured First Prompt ────────────────────────────── */

function StructuredFirstPrompt({ firstPrompt }: { firstPrompt: string }) {
  if (!firstPrompt || firstPrompt === 'No first prompt available') {
    return (
      <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>
        <Icon name="message" size={28} style={{ opacity: 0.3, marginBottom: 12 }} />
        <div style={{ fontSize: 14 }}>No first prompt captured.</div>
      </div>
    );
  }

  return (
    <div data-testid="conversation-first-prompt">
      <Card style={{ padding: 20, borderColor: 'var(--cr-info-line)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 18 }}>
          <span style={{
            width: 24, height: 24, display: 'inline-flex', alignItems: 'center',
            justifyContent: 'center', background: 'var(--cr-info-500)',
            borderRadius: 6, flexShrink: 0, marginTop: 1,
          }}>
            <Icon name="message" size={13} style={{ color: 'var(--cr-on-info)' }} />
          </span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--cr-fg-1)', letterSpacing: '-0.005em' }}>
              First Prompt
            </div>
            <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>
              The user's opening message for this session
            </div>
          </div>
        </div>

        <div style={{
          fontSize: 14,
          lineHeight: 1.7,
          color: 'var(--cr-fg-1)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{firstPrompt}</ReactMarkdown>
        </div>
      </Card>
    </div>
  );
}

function parseSummarySections(md: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  const lines = md.split('\n');

  let curHeading = '';
  let curBody: string[] = [];
  let inHeader = true;

  for (const line of lines) {
    const hMatch = line.match(/^#{1,3}\s+(.*)\s*$/);
    if (hMatch) {
      if (curBody.length > 0 || curHeading) {
        sections.push({ heading: curHeading, body: curBody.join('\n').trim() });
      }
      curHeading = hMatch[1].trim();
      curBody = [];
      inHeader = false;
      continue;
    }

    const boldMatch = line.match(/^\*\*([^*]+)\*\*:?\s*(.*)$/);
    if (boldMatch) {
      if (curBody.length > 0 || curHeading) {
        sections.push({ heading: curHeading, body: curBody.join('\n').trim() });
      }
      curHeading = boldMatch[1].trim();
      curBody = boldMatch[2] ? [boldMatch[2]] : [];
      inHeader = false;
      continue;
    }

    if (curHeading && line.trim()) {
      curBody.push(line);
    } else if (!curHeading && line.trim()) {
      curHeading = inHeader ? 'Summary' : 'Details';
      curBody.push(line);
    }
  }

  if (curBody.length > 0 || curHeading) {
    sections.push({ heading: curHeading, body: curBody.join('\n').trim() });
  }

  return sections;
}

function DiffPanel({
  data, loading, error,
}: { data: SessionDiffResponse | null; loading: boolean; error: string | null }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (loading) return <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>Replaying edits…</div>;
  if (error) return <div style={{ padding: 20, color: 'var(--cr-err-500)' }}>Failed to load diff: {error}</div>;
  if (!data) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>No diff data.</div>;
  // 202 placeholder — payload still computing in background.
  if (data._computing || !Array.isArray(data.files)) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>
        <div style={{ fontSize: 14, marginBottom: 6 }}>Replaying edits in the background…</div>
        <div style={{ fontSize: 12 }}>One-time cost for this session — reopen in a moment.</div>
      </div>
    );
  }
  if (data.files.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>
        No edits found in this session.
      </div>
    );
  }

  const toggle = (file: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file); else next.add(file);
      return next;
    });
  };

  // Churn chart: files ranked by lines changed, each a bar (length = share of
  // the busiest file) split added/removed. Shows WHERE the work landed — the
  // useful read a single +/− total can't give. Failed-edit files flagged.
  const ranked = [...data.files]
    .map(f => ({ ...f, churn: f.linesAdded + f.linesRemoved }))
    .sort((a, b) => b.churn - a.churn);
  const maxChurn = Math.max(1, ranked[0]?.churn ?? 1);

  return (
    <div data-testid="conversation-diff" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Same captioned-section header as the Overview tab. */}
      <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cr-fg-3)', fontWeight: 600, display: 'flex', gap: 10, alignItems: 'baseline', margin: '0 0 4px' }}>
        <span>Files changed</span>
        <span style={{ color: 'var(--cr-fg-2)' }}>{data.files.length}</span>
        <span style={{ color: 'var(--cr-ok-500)', fontVariantNumeric: 'tabular-nums' }}>+{data.totalLinesAdded.toLocaleString()}</span>
        <span style={{ color: 'var(--cr-err-500)', fontVariantNumeric: 'tabular-nums' }}>−{data.totalLinesRemoved.toLocaleString()}</span>
      </div>

      {/* One list, ranked by churn. Each row carries its own churn bar AND
          expands its diff on click — no scanning a chart up top then hunting
          the file far below. */}
      {ranked.map((f, idx) => {
        const isOpen = expanded.has(f.file);
        const base = f.file.split('/').pop() || f.file;
        const dir = f.file.slice(0, f.file.length - base.length);
        return (
          <Card key={f.file || `file-${idx}`} style={{ padding: 0, overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => toggle(f.file)}
              style={{
                width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
                padding: '11px 14px', cursor: 'pointer', display: 'block', color: 'var(--cr-fg-1)', fontFamily: 'inherit',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} />
                <span style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 12, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.file}>
                  <span style={{ color: 'var(--cr-fg-3)' }}>{dir}</span>{base}
                </span>
                {f.reverted && <Chip kind="warn" size="sm">reverted</Chip>}
                {f.failedEvents > 0 && <Chip kind="err" size="sm">{f.failedEvents} failed</Chip>}
                <span style={{ color: 'var(--cr-ok-500)', fontSize: 12, fontFamily: 'var(--cr-font-mono)', fontVariantNumeric: 'tabular-nums' }}>+{f.linesAdded}</span>
                <span style={{ color: 'var(--cr-err-500)', fontSize: 12, fontFamily: 'var(--cr-font-mono)', fontVariantNumeric: 'tabular-nums' }}>−{f.linesRemoved}</span>
              </div>
              {/* churn bar: width = this file's share of the busiest file, split add/remove */}
              <div style={{ display: 'flex', height: 5, width: `${(f.churn / maxChurn) * 100}%`, minWidth: 2, marginTop: 8, marginLeft: 24, borderRadius: 3, overflow: 'hidden', gap: 1 }}>
                <div style={{ width: `${(f.linesAdded / Math.max(1, f.churn)) * 100}%`, background: 'var(--cr-ok-500)' }} />
                <div style={{ width: `${(f.linesRemoved / Math.max(1, f.churn)) * 100}%`, background: 'var(--cr-err-500)' }} />
              </div>
            </button>
            {isOpen && (
              <div style={{ borderTop: '1px solid var(--cr-line-1)', padding: 16 }}>
                {f.diff ? (
                  <SyntaxHighlighter
                    language="diff"
                    style={vscDarkPlus}
                    customStyle={{
                      margin: 0, borderRadius: 4, fontSize: 12,
                      maxHeight: 480, overflow: 'auto', background: 'var(--cr-ink-2)',
                    }}
                  >
                    {f.diff}
                  </SyntaxHighlighter>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--cr-fg-3)', fontStyle: 'italic' }}>
                    {f.reverted ? 'File was edited then reverted to its original state.' : 'No textual diff (binary, notebook, or replay couldn\'t reconstruct).'}
                  </div>
                )}
                {f.events.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                      Events
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {f.events.map((e, ei) => (
                        <div key={e.toolUseId || `${f.file || idx}-evt-${ei}`} style={{ display: 'flex', gap: 8, fontSize: 11, fontFamily: 'var(--cr-font-mono)', alignItems: 'center' }}>
                          <span style={{ color: e.succeeded ? 'var(--cr-ok-500)' : 'var(--cr-err-500)' }}>
                            {e.succeeded ? '✓' : '✗'}
                          </span>
                          <span style={{ color: 'var(--cr-fg-3)' }}>{(e.tsIso || '').slice(11, 19)}</span>
                          <span style={{ color: 'var(--cr-fg-1)', fontWeight: 600 }}>{e.toolName}</span>
                          {e.editsCount !== undefined && <span style={{ color: 'var(--cr-fg-3)' }}>{e.editsCount} edit(s)</span>}
                          {e.writeBytes !== undefined && <span style={{ color: 'var(--cr-fg-3)' }}>{e.writeBytes}B</span>}
                          {e.applyError && <span style={{ color: 'var(--cr-err-500)' }}>apply: {e.applyError}</span>}
                          {e.toolError && <span style={{ color: 'var(--cr-err-500)' }}>tool error</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function CommitsPanel({
  data, loading, error,
}: { data: SessionCommitsResponse | null; loading: boolean; error: string | null }) {
  if (loading) return <div style={{ textAlign: 'center', padding: 40, color: 'var(--cr-fg-3)' }}>Looking up commits…</div>;
  if (error) return <div style={{ padding: 20, color: 'var(--cr-err-500)' }}>Failed to load commits: {error}</div>;
  if (!data) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>No commit data.</div>;
  // Server returned 202 — payload is being computed in background.
  // Show a quiet "computing" state instead of crashing on
  // `data.repos.length` (the placeholder body has no repos field).
  if (data._computing || !Array.isArray(data.repos)) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>
        <div style={{ fontSize: 14, marginBottom: 6 }}>Computing commits in the background…</div>
        <div style={{ fontSize: 12 }}>This is a one-time cost for this session. Reopen this tab in a few seconds.</div>
      </div>
    );
  }
  if (data.totalCommits === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--cr-fg-3)' }}>
        <Icon name="sparkle" size={28} style={{ opacity: 0.3, marginBottom: 12 }} />
        <div style={{ fontSize: 14, marginBottom: 6 }}>No commits matched this session's edit window.</div>
        <div style={{ fontSize: 12 }}>Either the work stayed local, or commits landed outside the window.</div>
      </div>
    );
  }

  return (
    <div data-testid="conversation-commits" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card style={{ padding: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--cr-fg-2)' }}>
          <strong>{data.totalCommits}</strong> commit(s) across <strong>{data.repos.length}</strong> repo(s)
        </div>
      </Card>
      {data.repos.map(r => (
        <Card key={r.repo} style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--cr-fg-1)' }}>{r.repoName}</span>
            <span style={{ fontSize: 11, color: 'var(--cr-fg-3)', fontFamily: 'var(--cr-font-mono)' }}>{r.repo}</span>
            <span style={{ flex: 1 }} />
            <Chip kind="info" size="sm">{r.commits.length} commit(s)</Chip>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {r.commits.map(c => (
              <div key={c.sha} style={{
                borderLeft: c.matchedSessionFiles.length > 0 ? '3px solid var(--cr-ok-500)' : '3px solid var(--cr-line-1)',
                paddingLeft: 10,
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-3)' }}>{c.shortSha}</span>
                  <span style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>{c.authorIso.slice(0, 16).replace('T', ' ')}</span>
                  <span style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>· {c.authorName}</span>
                  {c.matchedSessionFiles.length > 0 && (
                    <Chip kind="ok" size="sm">{c.matchedSessionFiles.length} session file(s)</Chip>
                  )}
                </div>
                <div style={{ fontSize: 13, color: 'var(--cr-fg-1)', fontWeight: 500, marginTop: 2, lineHeight: 1.4 }}>
                  {c.subject}
                </div>
                <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginTop: 2, fontFamily: 'var(--cr-font-mono)' }}>
                  +{c.linesAdded} / −{c.linesRemoved} · {c.files.length} file(s)
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
