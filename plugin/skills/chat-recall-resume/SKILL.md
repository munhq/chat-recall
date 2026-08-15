---
name: chat-recall-resume
description: >-
  Resume or cold-start work using chat-recall. Use when the user says "continue",
  "pick up where we left off", "resume our work", "carry on with X", starts a new
  session on an ongoing task, or references something from "last time" that isn't
  in the current context. Rebuilds prior context from past sessions instead of
  asking the user to re-explain.
---

# Resuming work with chat-recall

Goal: reconstruct the state of prior work so you can continue seamlessly.

## Default move

`mcp__chat-recall__recall_smart_resume` returns a structured bundle: what was
done, what's pending, files touched, budget, and current knowledge-graph facts.
This is the best single call for "continue".

**It REQUIRES `session_id` — there is no "latest session" default, and calling
it bare is a validation error, not a lucky guess.** So resuming is always two
steps unless the user handed you an id:

1. Get the id. `mcp__chat-recall__recall_recent` (`project_filter`,
   `since_hours`) lists candidates newest-first — the right call for a plain
   "continue". Use `mcp__chat-recall__recall_search` with
   `include_outcome: true` instead when the user described the TASK rather than
   the timing; the outcome line (shipped / interrupted / abandoned) tells you
   whether that session is even worth resuming.
2. Pass that id to `recall_smart_resume`.

`recall_smart_resume` also takes no project filter. Scope the SEARCH in step 1
(`project_filter` on `recall_recent`), not the resume call.

## Cold start (new session, unclear task)

- `mcp__chat-recall__recall_wake_up` — identity blurb + high-importance
  decisions/preferences/milestones + a knowledge-graph snapshot. Fast "who am I,
  what's true right now". Add a project filter to scope it.
- `mcp__chat-recall__recall_project_context` — when the user is clearly working in
  one project and wants its full picture (see `chat-recall-project`).

## Reading a specific past session

Once you have a session id:
- `mcp__chat-recall__recall_context` — structured context (requests, decisions,
  files, tools).
- `mcp__chat-recall__recall_show` — raw slice; `from_end: N` for the last N
  messages, `include_code: true` when the actual diffs/commands matter. It
  returns 10 messages unless you raise `max_messages`, so don't read a truncated
  slice as the whole session.
- `mcp__chat-recall__recall_summary` — AI summary + outcome (did the work land?).

## Workflow

1. Have a session id? → `recall_smart_resume` (or `recall_context`/`recall_show`).
2. No id, know the task? → `recall_search` (`include_outcome: true`) → take the id from the best hit → `recall_smart_resume`.
3. No id, no clear task? → `recall_wake_up` (+ project filter), then confirm direction with the user.
4. Continue the work; state which past session you picked up so the user can course-correct.

Don't ask the user to recap what a recall call can reconstruct.
