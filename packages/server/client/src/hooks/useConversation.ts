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
import { getConversationWithSubagents, getConversationPage, type SessionInfo, type Subagent } from '../services/api';

export interface UseConversation {
  sessionId: string | null;
  selectionNonce: number;
  messages: any[];
  subagents: Subagent[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  sessionInfo: SessionInfo | null;
  open: (sessionId: string, info?: SessionInfo | null) => void;
  loadFull: () => Promise<void>;
  loadMore: () => Promise<void>;
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
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);

  const open = useCallback((sid: string, info: SessionInfo | null = null) => {
    setSessionId(sid);
    setSelectionNonce((n) => n + 1);
    setMessages([]);
    setSubagents([]);
    setSessionInfo(info);
  }, []);

  const loadFull = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const { messages: msgs, subagents: subs, total: t, hasMore: hm } = await getConversationWithSubagents(sessionId);
      setMessages(msgs); setSubagents(subs); setTotal(t ?? msgs.length); setHasMore(!!hm);
    } catch (err) { console.error('Failed to load conversation:', err); }
    finally { setLoading(false); }
  }, [sessionId]);

  const loadMore = useCallback(async () => {
    if (!sessionId || !hasMore) return;
    try {
      const page = await getConversationPage(sessionId, messages.length);
      setMessages((prev) => [...prev, ...page.messages]);
      setTotal(page.total); setHasMore(page.hasMore);
    } catch (err) { console.error('load more messages failed:', err); }
  }, [sessionId, hasMore, messages.length]);

  const close = useCallback(() => {
    setSessionId(null); setMessages([]); setSubagents([]); setSessionInfo(null);
  }, []);

  return { sessionId, selectionNonce, messages, subagents, total, hasMore, loading, sessionInfo, open, loadFull, loadMore, close };
}
