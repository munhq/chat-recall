---
name: chat-recall-find
description: >-
  Find past AI-coding work with chat-recall. Use when the user asks "remember
  when we…", "have we done X before", "find my notes/sessions on…", "where did we
  discuss Y", "what did I ask about Z", or otherwise wants to locate earlier
  conversations, plans, tasks, or notes across all their AI tools. Searches the
  unified memory (sessions, plans, tasks, CLAUDE.md, history, diaries).
---

# Finding past work with chat-recall

## Pick the search tool

- `mcp__chat-recall__recall_search` — search SESSIONS. Free-text query.
  - `include_outcome: true` → each hit gets a shipped/interrupted/abandoned line
    so you can judge relevance fast.
  - `like_session: <id>` → find sessions similar to a given one.
  - `project_filter`, `top_k` to narrow.
- `mcp__chat-recall__recall_memory_search` — search ALL memory types, not just
  sessions. Use this when the answer might be in a plan, task list, CLAUDE.md, or
  an agent diary — not only a conversation. Omit `source_types` to search
  everything; pass it to narrow. The conversation-ish types are
  `['session','plan','task','claude_md','paste','history','diary','agent_memory']`,
  and the toolkit types — what is CONFIGURED rather than what was said — are
  `['skill','mcp','command','agent','hook','plugin']`.
- `mcp__chat-recall__recall_user_prompts` — search only what the USER actually
  typed (assistant output stripped). Best for "what did I ask about X",
  "what was I requesting yesterday".
- `mcp__chat-recall__recall_subagent_search` — search inside SUBAGENT
  transcripts. Explore/compact/aside sub-tasks run within a session and their
  work never appears in the main conversation, so a normal session search cannot
  find it. Reach for this when a session clearly did work you cannot locate.
- `mcp__chat-recall__recall_redundant_files` — before creating a file, check
  whether you have written one like it before. Scores a filename against every
  file in the synced history.

## From a hit to the content

Every tool here takes a NAMED `session_id` (not a positional argument).

- `mcp__chat-recall__recall_show` — read the session slice (`around_line`,
  `from_end`, `include_code: true` for diffs/commands). It returns **10 messages
  by default**: raise `max_messages` before telling the user what a session
  contains, or you will describe a tenth of it as the whole.
- `mcp__chat-recall__recall_summary` — AI summary + outcome.
- `mcp__chat-recall__recall_memory_item` — read ONE item in full (or its links)
  once search has found it. `mode=browse` lists a whole source type.
- Plans/tasks: `recall_memory_search(source_types: ['plan','task'])` to find,
  then `recall_show` with the plan id to read the full plan.

## Strategy

1. Sessions-only question → `recall_search` (add `include_outcome: true`).
2. Might be a plan/task/note/diary → `recall_memory_search` (set `source_types`).
3. "What did *I* ask" → `recall_user_prompts`.
4. Zero results → broaden the query by dropping qualifiers, drop or widen
   `project_filter`, or try the other search tool. Neither search tool has a
   date/time filter, so do NOT try to narrow by time here — for a time window
   use `recall_recent` (`since_hours`) or `recall_edits_timeline` instead.
   Then open the best hit with `recall_show`.
5. Work you cannot find in the session itself → `recall_subagent_search`.

Report the session id / source of each result so the user can jump to it.
