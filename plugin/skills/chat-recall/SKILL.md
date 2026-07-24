---
name: chat-recall
description: >-
  Recall past AI-coding work — prior sessions, decisions, and project history —
  through the chat-recall MCP tools (mcp__chat-recall__recall_*). Use when the
  user says "continue" / "pick up where we left off", "did we decide X",
  "remember when we…", "what was I doing", "what do you know about this
  project/me", or otherwise references earlier work that is not in the current
  context. This is the hub: it routes to the focused chat-recall skills and
  lists every recall_* tool. Reach for it whenever the answer lives in PAST work
  rather than the files in front of you.
---

# chat-recall — cross-session memory for AI coding

chat-recall indexes your Claude Code, Gemini, OpenCode, Codex and Antigravity
sessions — plus plans, tasks, CLAUDE.md files, shell history and agent diaries —
into a searchable server with a temporal knowledge graph. When a request depends
on something that happened in an *earlier* session (a decision, a past fix, "what
were we doing"), don't guess or ask the user to re-explain — recall it.

All tools are MCP tools on the `chat-recall` server, named
`mcp__chat-recall__<tool>`. They are read-mostly and safe to call proactively.

## Route to the right skill

Match the intent, then read that skill and follow its workflow:

| The user wants… | Read skill |
| --- | --- |
| Continue / resume / pick up prior work; cold start on an ongoing task | `chat-recall-resume` |
| Find past conversations — "remember when", "have we done X", "find my notes on…" | `chat-recall-find` |
| Store or recall a decision / fact; "what do you know about…", "did we decide…" | `chat-recall-memory` |
| The state of a project — "what's been happening in X", cost, findings | `chat-recall-project` |
| What changed — edits, diffs, commits; "what was I doing 2h ago" | `chat-recall-changes` |

## Tool catalog

<!-- BEGIN GENERATED TOOL CATALOG (scripts/gen-skills.ts — do not edit by hand) -->
**Resume / cold start** — `recall_smart_resume` (structured resume bundle), `recall_recent` (list recent sessions), `recall_wake_up` (identity + high-signal facts), `recall_context`, `recall_show`, `recall_summary`.
**Search** — `recall_search` (sessions; `include_outcome`, `like_session`), `recall_memory_search` (all 9 memory types), `recall_user_prompts` (what the user actually typed).
**Project** — `recall_project_context` (rich dump), `recall_weekly_digest`, `recall_analytics_summary`, `recall_code_findings` / `recall_code_actions` / `recall_code_projects`.
**What changed** — `recall_edits_timeline` (cross-tool edits), `recall_diff` (per-session diffs), `recall_commits`, `recall_markers`.
**Durable memory / KG** — `recall_kg_query` / `recall_kg_add` / `recall_kg_invalidate` / `recall_kg_timeline` / `recall_kg_stats`, `recall_decision_record`, `recall_diary_write` / `recall_diary_read`, `recall_set` / `recall_get`.
**Security** — `recall_security_summary` / `recall_security_session` / `recall_security_dismiss`.
**Housekeeping** — `recall_status`, `recall_index`, `recall_rename_session`.
<!-- END GENERATED TOOL CATALOG -->

## If you're unsure where to start

- Free-text "is there past work relevant to this?" → `recall_search` with `include_outcome: true`.
- Broader ("plans, tasks, CLAUDE.md, diaries too") → `recall_memory_search`.
- "What do you know about me / this project right now?" → `recall_wake_up` (add a project filter) or `recall_project_context`.
- "Continue where we left off" → `recall_smart_resume`.

Prefer one targeted recall over asking the user to recap. Cite what you found
(session id / decision) so the user can verify.
