---
name: chat-recall-changes
description: >-
  See what changed across past AI-coding sessions with chat-recall. Use when the
  user asks "what did I change 2h ago", "what files did we touch", "what happened
  in that session", "did that session actually ship", "which sessions edited
  <file>", or wants diffs/commits/edit-history that isn't in the current working
  tree. Reconstructs edits, diffs, commits, and outcomes from indexed sessions.
---

# What-changed with chat-recall

## Recent edits across everything

`recall_edits_timeline` — chronological file edits across
every AI tool chat-recall indexes, read live from each tool's own session store.
`since_hours: 2` for "what was I doing recently"; `pattern` to filter by path;
`group_by: "session"` (+ wide `since_hours`) to answer "which sessions edited
<file> this month".

## One session's changes

Every tool here takes a NAMED `session_id` (not a positional argument).

- `recall_diff` — per-file unified diffs of what a session
  actually changed (detects reverts). `files_only: true` = just the touched-files
  list; `context_only: true` = per-file add/remove stats.
- `recall_commits` — git commits that landed in the
  session's edit window, grouped by repo. Use to verify "shipped" claims: many
  edits but no commit = work stayed local.
- `recall_summary` — AI summary + outcome classification
  (shipped / interrupted / abandoned) + last-claim-vs-user-reaction.
- `recall_markers` — per-prompt sentiment/correction
  markers (frustrated, correction, approval) to spot where a session went sideways.

## Across many sessions

`recall_outcome_summary` — how sessions ended over the last N
days (shipped / interrupted / abandoned / in_progress). Use for "am I finishing
what I start", never for one session — `recall_summary` answers that.

## Workflow

1. "What was I doing recently" → `recall_edits_timeline` (`since_hours`).
2. "Which sessions touched <file>" → `recall_edits_timeline`
   (`pattern`, `group_by: "session"`, wide window).
3. "What did session X change / did it ship" → `recall_diff` + `recall_commits`
   (+ `recall_summary` for the outcome).
4. Don't claim a session shipped without `recall_commits` confirming a matching
   commit — edits alone can be local-only.
