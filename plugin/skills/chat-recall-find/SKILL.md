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
  sessions. Use `source_types` to filter (`['session','plan','task','claude_md',
  'paste','history','diary']`). Use this when the answer might be in a plan, task
  list, CLAUDE.md, or an agent diary — not only a conversation.
- `mcp__chat-recall__recall_user_prompts` — search only what the USER actually
  typed (assistant output stripped). Best for "what did I ask about X",
  "what was I requesting yesterday".

## From a hit to the content

- `mcp__chat-recall__recall_show <id>` — read the session slice
  (`around_line`, `from_end`, `include_code: true` for diffs/commands).
- `mcp__chat-recall__recall_summary <id>` — AI summary + outcome.
- Plans/tasks: `recall_memory_search(source_types: ['plan','task'])` to find,
  then `recall_show` with the plan id to read the full plan.

## Strategy

1. Sessions-only question → `recall_search` (add `include_outcome: true`).
2. Might be a plan/task/note/diary → `recall_memory_search` (set `source_types`).
3. "What did *I* ask" → `recall_user_prompts`.
4. Zero results → broaden the query (drop qualifiers), try the other tool, or
   widen `project_filter`/time. Then open the best hit with `recall_show`.

Report the session id / source of each result so the user can jump to it.
