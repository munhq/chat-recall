---
name: chat-recall-project
description: >-
  Get the state of a project from chat-recall. Use when the user asks "what's
  been happening in <project>", "catch me up on this repo", "what's the state of
  X", about time/cost/activity across a project, or about code findings and
  recommended fixes. Also owns the shared task board and the team view — "what
  are my open tasks", "create a task for…", "what is my team working on", "which
  projects are shared". Aggregates sessions, plans, tasks, commits, cost,
  knowledge graph, and code-intelligence for one project.
---

# Project intelligence with chat-recall

## The one-call overview

`mcp__chat-recall__recall_project_context` — the full project dossier: overview,
tech stack, decisions log, recent sessions with summaries, open tasks, plans,
diary conclusions, and cost. Accepts a path, a name substring, or a project id
(`git:host/owner/repo`, `git-local:<sha1>` for a repo with no remote, `ws:name`,
`user:custom`). Start here for "catch me up on this project".

## Activity, cost, trends

- `mcp__chat-recall__recall_weekly_digest` — sessions, cost, top projects, trend
  vs last week, open tasks, git activity. `weeks_back: 0` = this week.
- `mcp__chat-recall__recall_analytics_summary` — cross-tool spend & activity
  totals (sessions, cost, top tools/projects/models). This one is NOT
  project-scoped, so it is the right call for "how much did I spend this month"
  across everything.
- `mcp__chat-recall__recall_outcome_summary` — how sessions ended over the last
  N days (shipped / interrupted / abandoned), for "am I finishing what I start".

## Code intelligence (when the codeindex companion is present)

- `mcp__chat-recall__recall_code_projects` — indexed projects with health score.
- `mcp__chat-recall__recall_code_findings` — findings (security / clones / dead
  code / coupling / cycles …); each carries a ready-to-run agent prompt. Filter
  by `project`, `severity`, `category`.
- `mcp__chat-recall__recall_code_actions` — the ranked "what to fix next" plan.
- `mcp__chat-recall__recall_recommendations` — concrete recommendations
  (`scope: 'project'` with a `project` id) reasoning over code + how sessions went.
- If a repo isn't indexed yet, `mcp__chat-recall__recall_code_index` (path) runs
  the analyzer and syncs findings.

## Tasks and team (shared, not personal notes)

- `mcp__chat-recall__recall_tasks` — the shared task board: status, assignee,
  project. This is the answer to "what are my open tasks".
- `mcp__chat-recall__recall_task_create` — create a task, optionally assigned to
  a teammate and attached to a project. Returns the new task id.
- `mcp__chat-recall__recall_task_update` — change status, reassign, rename or
  comment. Takes the `t_…` id from `recall_tasks`.
- `mcp__chat-recall__recall_team_activity` — per-teammate × per-project rollup
  (session counts, last activity) for "what is the team working on".
- `mcp__chat-recall__recall_shares` — which projects are shared into the team
  (`scope: 'mine'` / `'all'`). Sharing is opt-in: nothing is visible to
  teammates until it is shared, so an empty result means "not shared", NOT
  "no work happened".

Creating or updating a task is a WRITE other people see. Do it when the user
asks, not to tidy up on their behalf.

## Workflow

1. "Catch me up on <project>" → `recall_project_context`.
2. "How productive / how much did X cost" → `recall_weekly_digest` (per week) or
   `recall_analytics_summary` (cross-project totals).
3. "What should I fix in <project>" → `recall_code_actions` for the ranked plan,
   `recall_code_findings` for the raw findings, `recall_recommendations` when the
   user wants reasoning over how sessions actually went, not just code shape.
   Index first with `recall_code_index` if the repo is not indexed yet.
4. "What are my/our open tasks" → `recall_tasks`; "what is the team doing" →
   `recall_team_activity`.
5. Ground answers in what you found (session ids, finding ids); don't invent status.
