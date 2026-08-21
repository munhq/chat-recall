---
name: chat-recall
description: >-
  Recall past AI-coding work — prior sessions, decisions, and project history —
  through the chat-recall MCP tools (mcp__chat-recall__recall_*). Use when the
  user says "continue" / "pick up where we left off", "did we decide X",
  "remember when we…", "what was I doing", "what do you know about this
  project/me", or otherwise references earlier work that is not in the current
  context. Also the entry point for the surfaces no focused skill owns: leaked
  secrets ("did I paste an API key"), the shared task board and team activity
  ("what are my open tasks", "what is my team working on"), the ranked findings
  views ("what should I fix next", "what should I tell Claude about this repo"),
  and index health ("is chat-recall working", "re-index my sessions"). This is the hub: it routes
  to the focused chat-recall skills and lists every recall_* tool. Reach for it
  whenever the answer lives in PAST work rather than the files in front of you.
---

# chat-recall — cross-session memory for AI coding

chat-recall indexes your Claude Code, Gemini, OpenCode, Codex and Antigravity
sessions — plus plans, tasks, CLAUDE.md files, shell history and agent diaries —
into a searchable server with a temporal knowledge graph. When a request depends
on something that happened in an *earlier* session (a decision, a past fix, "what
were we doing"), don't guess or ask the user to re-explain — recall it.

All tools are MCP tools on the `chat-recall` server, named
`mcp__chat-recall__<tool>`.

**Reads are safe to call proactively. Writes are not.** Everything below is a
read except these, which change stored memory or state — treat each as an edit
and apply the test in `chat-recall-memory` before calling one:
`recall_kg_add`, `recall_kg_invalidate`, `recall_decision_record`,
`recall_diary_write`, `recall_set`, `recall_task_create`, `recall_task_update`,
`recall_task_comment`,
`recall_security_dismiss`, `recall_rename_session`, `recall_regenerate_summary`,
`recall_reclassify`, `recall_index`, `recall_code_index`.

`recall_improvements` is a read UNLESS you pass `create_tasks: true`, which opens
one task per returned item on the shared team board. Pass it only when the user
asked for the work to be tracked — the board is visible to teammates and the API
has no delete. `recall_claude_suggestions` never writes.

## Route to the right skill

Match the intent, then read that skill and follow its workflow:

| The user wants… | Read skill |
| --- | --- |
| Continue / resume / pick up prior work; cold start on an ongoing task | `chat-recall-resume` |
| Find past conversations — "remember when", "have we done X", "find my notes on…" | `chat-recall-find` |
| Store or recall a decision / fact; "what do you know about…", "did we decide…" | `chat-recall-memory` |
| The state of a project — "what's been happening in X", cost, findings | `chat-recall-project` |
| What changed — edits, diffs, commits; "what was I doing 2h ago" | `chat-recall-changes` |

Leaked secrets, the shared task board, team activity and index health have no
focused skill — use the catalog below directly.

## Tool catalog

Every `recall_*` tool. `packages/cli/src/skills-catalog.test.ts` fails when a
tool is registered and never named here, so adding a tool means placing it.

**Resume / cold start** — `recall_smart_resume` (structured resume bundle; needs a session id), `recall_recent` (list recent sessions), `recall_wake_up` (identity + high-signal facts), `recall_context` (structured dump of one session), `recall_show` (raw slice — returns 10 messages unless you raise `max_messages`), `recall_summary` (AI summary + outcome).
**Search** — `recall_search` (sessions; `include_outcome`, `like_session`), `recall_memory_search` (every memory type), `recall_memory_item` (read ONE item found by search, or browse a source type), `recall_user_prompts` (what the user actually typed), `recall_subagent_search` (inside subagent transcripts, whose work never reaches the main conversation), `recall_redundant_files` (before writing a new file, check you have not written one like it already).
**Project** — `recall_project_context` (rich dump), `recall_weekly_digest`, `recall_analytics_summary`, `recall_outcome_summary` (how many recent sessions actually shipped), `recall_code_findings` / `recall_code_actions` / `recall_code_projects` / `recall_code_index` / `recall_recommendations`.
**Findings, ranked** — `recall_claude_suggestions` (every finding that becomes an agent-instruction change — the CLAUDE.md rules and skill installs — merged across account scope and every indexed project) and `recall_improvements` (everything else, most urgent first; `create_tasks: true` opens one team task per item). They split the same engines, so an item never appears in both. Neither needs the codeindex binary: without it you still get the account-level half.
**What changed** — `recall_edits_timeline` (cross-tool edits), `recall_diff` (per-session diffs), `recall_commits` (did it actually land), `recall_markers` (where a session went sideways).
**Durable memory / KG** — `recall_kg_query` / `recall_kg_add` / `recall_kg_invalidate` / `recall_kg_timeline` / `recall_kg_stats`, `recall_decision_record`, `recall_diary_write` / `recall_diary_read`, `recall_set` / `recall_get`.
**Team** — `recall_tasks` (the shared task board), `recall_task_create`, `recall_task_update` (status, assignee, linked session; task ids look like `t_…`; when you start work on a task, set it `in_progress` and pass your session id as `linked_session_id` so the board can verify the work shipped), `recall_task_comment` (leave a progress note on a card), `recall_team_activity` (per-teammate × per-project rollup), `recall_shares` (which projects are shared — private by default, nothing is visible to teammates until shared).
**Security** — `recall_security_summary` (leaked secrets that still need action — start here for "did I paste a key somewhere"), `recall_security_session` (findings for one session), `recall_security_dismiss` (mark rotated / false positive — do this only when the user confirms which), `recall_security_rules` (tenant detection rules; also tests a regex).
**Health / maintenance** — `recall_status` (is the index alive, what is synced), `recall_index` (sync now), `recall_help` (names the tools the lean profile leaves unlisted — they all still work by name), `recall_heal_audit` (sessions whose rendered text is thinner than the raw archive, i.e. truncated upstream), `recall_regenerate_summary` (stored summary is stale or wrong), `recall_reclassify` (re-run the classifier over old chunks), `recall_rename_session`.

## If you're unsure where to start

- Free-text "is there past work relevant to this?" → `recall_search` with `include_outcome: true`.
- Broader ("plans, tasks, CLAUDE.md, diaries too") → `recall_memory_search`.
- "What do you know about me / this project right now?" → `recall_wake_up` (add a project filter) or `recall_project_context`.
- "Continue where we left off" → you need a session id first. `recall_smart_resume`
  takes one and REQUIRES it, so get the id from `recall_recent` (most recent work)
  or `recall_search` (`include_outcome: true`, when the user described the task),
  then resume. See `chat-recall-resume`.

Prefer one targeted recall over asking the user to recap. Cite what you found
(session id / decision) so the user can verify.
