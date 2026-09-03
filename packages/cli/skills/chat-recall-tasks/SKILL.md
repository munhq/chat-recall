---
name: chat-recall-tasks
description: >-
  Work the shared chat-recall task board — the cards a team and its agents pick
  up, claim and close. Use when the user says "what are my open tasks", "what's
  on the team's plate", "create a task for…", "assign this to…", "mark that
  done", "leave a note on that card", "what is my team working on", or asks you
  to START working on something from the board. Also owns what the board files
  automatically — "stop filing low-priority cards", "only file security
  findings". Claiming and closing a card have required evidence; this skill
  covers that protocol.
---

# The task board with chat-recall

The board is shared: teammates and agents on other machines see the same cards.
So a card is a claim about real work, and the tools enforce that rather than
trusting a status field.

## See the board

`mcp__chat-recall__recall_tasks` — one line per card (title, id, assignee).
Use it for "what's on the team's plate", "my tasks", or to find a task id.

Pass `detail: true` when you intend to actually DO one. That returns the full
brief per open card: the fix, the file locations, and the agent prompt the
auto-filer already wrote. Reading the brief before starting is the difference
between doing the filed work and re-deriving it.

## Create a card

`mcp__chat-recall__recall_task_create` — optionally assign it to a teammate and
attach it to a project. Returns the new task id.

File a card when work must survive the end of the session. A leaked key to
rotate, a finding worth fixing, a follow-up the user described out loud — those
belong on the board, not in a reply the user has to scroll back to.

Never put a real credential in a title or body. Refer to a secret by its
redacted preview. See [chat-recall-security].

## Claim it, then close it — the protocol

`mcp__chat-recall__recall_task_update` changes status, assignee, title, links a
session and can carry a comment. Two steps are not optional, and the server
refuses the call without them:

1. **Starting.** Set `status: 'in_progress'` AND pass your own current session
   id as `linked_session_id`. You know that id from your own context; the MCP
   server cannot see it. A claim without it is refused, because "in progress"
   with nothing behind it cannot be asked about. With it, the card shows that
   session's changes as they land rather than only after a commit.
2. **Finishing.** Set `status: 'done'` AND record what changed: the unified
   `diff` (what `git diff` printed for this fix) and the `commits` if you
   committed. The close is refused without one of them.

Both refusals are the point. Treat them as the contract, not an obstacle to
route around — a board full of cards closed with no evidence is worth less than
no board.

## Leave a note

`mcp__chat-recall__recall_task_comment` — a progress note visible to everyone on
the board. Use it to record what you did, what is blocked, or why a status
changed, without editing the card itself. Pass the task id (`t_…`).

A status change that will surprise someone deserves a comment saying why.

## What the board files on its own

`mcp__chat-recall__recall_task_policy` — read it by calling with no arguments.
It controls what gets auto-filed:

- `max_pri` — severity floor, inclusive: 0 critical, 1 high, 2 medium, 3 low.
- `ceiling` — how many auto-filed cards may be open at once.
- `max_per_run` — cap on new cards per run.
- `categories` — only file these (e.g. `["security"]`); `[]` means all.

Use it for "the board is too noisy", "only file security findings", "stop
filing low-priority cards". Say what you changed: this alters what the team
sees for every future run, not just this one.

## Where cards come from

- Findings worth fixing → [chat-recall-project] (`recall_recommendations`,
  `recall_code_findings`, and "turn these findings into tasks").
- Leaked secrets to rotate → [chat-recall-security].
- The team view — who is working on what, which projects are shared →
  [chat-recall-project].

## Quick routing

| the user says | call |
|---|---|
| "my open tasks", "what's on the team's plate" | `recall_tasks` |
| "work on that card", "pick this up" | `recall_tasks` with `detail: true`, then `recall_task_update` |
| "create a task for…", "assign this to…" | `recall_task_create` |
| "mark it done", "I'm starting this" | `recall_task_update` (with the required evidence) |
| "note on that card", "say why it's blocked" | `recall_task_comment` |
| "the board is too noisy", "only file security" | `recall_task_policy` |
