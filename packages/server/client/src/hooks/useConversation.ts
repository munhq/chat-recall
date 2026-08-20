/**
 * useConversation — self-contained session-load state for the prop-driven
 * ConversationViewer. Lets the viewer live anywhere (the global search pane OR
 * inline inside the project workspace) without routing through view='search'.
 *
 * Mirrors App.tsx's session-branch logic (handleSelectSession session-only +
 * handleLoadFull + handleLoadMoreMessages + handleCloseConversation), minus the
 * App-shell concerns (URL ?session= push, memory-item routing) which the caller
 * composes around open().
 */
import { useState, useCallback } from 'react';
import { getConversationWithSubagents, getConversationPage, loadRestOfConversation, type SessionInfo, type Subagent } from '../services/api';

export interface UseConversation {
  sessionId: string | null;
  selectionNonce: number;
  messages: any[];
  subagents: Subagent[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  sessionInfo: SessionInfo | null;
  open: (sessionId: string, info?: SessionInfo | null) => void;
  loadFull: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** Page to the END of the session, so whole-session views are not reading a window. */
  loadAll: () => Promise<void>;
  close: () => void;
}

export function useConversation(): UseConversation {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selectionNonce, setSelectionNonce] = useState(0);
  const [messages, setMessages] = useState<any[]>([]);
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Server rows consumed. Never messages.length — see ConversationPage.nextOffset. */
  const [offset, setOffset] = useState(0);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);

  const open = useCallback((sid: string, info: SessionInfo | null = null) => {
    setSessionId(sid);
    setSelectionNonce((n) => n + 1);
    setMessages([]);
    setSubagents([]);
    setOffset(0);
    setHasMore(false);
    setSessionInfo(info);
  }, []);

  const loadFull = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const { messages: msgs, subagents: subs, total: t, hasMore: hm, nextOffset } = await getConversationWithSubagents(sessionId);
      setMessages(msgs); setSubagents(subs); setTotal(t ?? msgs.length); setHasMore(!!hm); setOffset(nextOffset);
    } catch (err) { console.error('Failed to load conversation:', err); }
    finally { setLoading(false); }
  }, [sessionId]);

  const loadMore = useCallback(async () => {
    if (!sessionId || !hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getConversationPage(sessionId, offset);
      setMessages((prev) => [...prev, ...page.messages]);
      setTotal(page.total); setHasMore(page.hasMore); setOffset(page.nextOffset);
    } catch (err) { console.error('load more messages failed:', err); }
    finally { setLoadingMore(false); }
  }, [sessionId, hasMore, loadingMore, offset]);

  const loadAll = useCallback(async () => {
    if (!sessionId || !hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await loadRestOfConversation(sessionId, offset, (page) => {
        setMessages((prev) => [...prev, ...page.messages]);
        setTotal(page.total);
      });
      setHasMore(r.hasMore); setOffset(r.nextOffset);
    } catch (err) { console.error('load all messages failed:', err); }
    finally { setLoadingMore(false); }
  }, [sessionId, hasMore, loadingMore, offset]);

  const close = useCallback(() => {
    setSessionId(null); setMessages([]); setSubagents([]); setSessionInfo(null);
    setOffset(0); setHasMore(false);
  }, []);

  return { sessionId, selectionNonce, messages, subagents, total, hasMore, loading, loadingMore, sessionInfo, open, loadFull, loadMore, loadAll, close };
}
