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

`mcp__chat-recall__recall_edits_timeline` — chronological file edits across
Claude/Gemini/OpenCode/Codex sessions. `since_hours: 2` for "what was I doing
recently"; `pattern` to filter by path; `group_by: "session"` (+ wide
`since_hours`) to answer "which sessions edited <file> this month".

## One session's changes

- `mcp__chat-recall__recall_diff <id>` — per-file unified diffs of what a session
  actually changed (detects reverts). `files_only: true` = just the touched-files
  list; `context_only: true` = per-file add/remove stats.
- `mcp__chat-recall__recall_commits <id>` — git commits that landed in the
  session's edit window, grouped by repo. Use to verify "shipped" claims: many
  edits but no commit = work stayed local.
- `mcp__chat-recall__recall_summary <id>` — AI summary + outcome classification
  (shipped / interrupted / abandoned) + last-claim-vs-user-reaction.
- `mcp__chat-recall__recall_markers <id>` — per-prompt sentiment/correction
  markers (frustrated, correction, approval) to spot where a session went sideways.

## Workflow

1. "What was I doing recently" → `recall_edits_timeline` (`since_hours`).
2. "Which sessions touched <file>" → `recall_edits_timeline`
   (`pattern`, `group_by: "session"`, wide window).
3. "What did session X change / did it ship" → `recall_diff` + `recall_commits`
   (+ `recall_summary` for the outcome).
4. Don't claim a session shipped without `recall_commits` confirming a matching
   commit — edits alone can be local-only.
