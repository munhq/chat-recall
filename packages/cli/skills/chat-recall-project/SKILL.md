---
name: chat-recall-project
description: >-
  Get the state of a project from chat-recall. Use when the user asks "what's
  been happening in <project>", "catch me up on this repo", "what's the state of
  X", about time/cost/activity across a project, or about code findings and
  recommended fixes. Aggregates sessions, plans, tasks, commits, cost, knowledge
  graph, and code-intelligence for one project.
---

# Project intelligence with chat-recall

## The one-call overview

`mcp__chat-recall__recall_project_context` — the full project dossier: overview,
tech stack, decisions log, recent sessions with summaries, open tasks, plans,
diary conclusions, and cost. Accepts a path, a name substring, or a project id
(`git:host/owner/repo`, `ws:name`, `user:custom`). Start here for "catch me up on
this project".

## Activity, cost, trends

- `mcp__chat-recall__recall_weekly_digest` — sessions, cost, top projects, trend
  vs last week, open tasks, git activity. `weeks_back: 0` = this week.
- `mcp__chat-recall__recall_analytics_summary` — cross-tool spend & activity
  totals (sessions, cost, top tools/projects/models).

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

## Workflow

1. "Catch me up on <project>" → `recall_project_context`.
2. "How productive / how much did X cost" → `recall_weekly_digest` or `recall_analytics_summary`.
3. "What should I fix in <project>" → `recall_code_actions` / `recall_code_findings`
   (index first with `recall_code_index` if needed).
4. Ground answers in what you found (session ids, finding ids); don't invent status.
