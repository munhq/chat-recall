---
name: chat-recall-project
description: >-
  Get the state of a project from chat-recall. Use when the user asks "what's
  been happening in <project>", "catch me up on this repo", "what's the state of
  X", about time/cost/activity across a project, or about code findings and
  recommended fixes. Owns the ranked findings views — "what should I fix next",
  "what should I work on", "what should I tell Claude about this repo", "turn
  these findings into tasks". Also owns the shared task board and the team view —
  "what are my open tasks", "create a task for…", "what is my team working on",
  "which projects are shared". Aggregates sessions, plans, tasks, commits, cost,
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

## Findings, ranked (no codeindex binary required)

- `mcp__chat-recall__recall_claude_suggestions` — every finding that turns into
  an agent-instruction change: the CLAUDE.md rules and skill installs, merged
  across account scope and every indexed project. Reach for it on "what should I
  tell Claude about this repo".
- `mcp__chat-recall__recall_improvements` — everything else, ranked most urgent
  first. `create_tasks: true` opens one task per item on the shared board; it is
  off by default, so the tool reads unless the user asks it to write.
- The two partition the same engines — an item is in one list or the other,
  never both — so acting on both cannot duplicate work.

### Acting on a recommendation

Finding advice and answering it are the same job, so both verbs live here.

- `mcp__chat-recall__recall_recommendation_apply` — apply one: add its rule to
  the repo's CLAUDE.md, or set the label it asks for. A CLAUDE.md rule needs no
  permission — it is additive, visible in the diff, and one line the user can
  delete. DO ask first for anything that changes what the AI is allowed to do
  destructively.
- `mcp__chat-recall__recall_recommendation_dismiss` — say no for THIS project,
  with a reason: a reuse rule on a repo that is deliberately duplicated per
  environment, a label on a scratch project. It stops being offered for that
  project and no other. TELL THE USER what you dismissed and why — this changes
  how future sessions treat their codebase, and a reason nobody sees is a
  decision nobody can revisit.

## Tasks and team (shared, not personal notes)

**Working the board out loud.** When you take work from here, say so: that you are
pulling tasks from the chat-recall board, which ones you picked, and — as each one
lands — that it is done and what changed. The board is the user's, and a card that
claims and closes itself with no word to them is how it stopped being trusted the
first time. `recall_tasks detail:true` gives you the brief, the locations and the
agent prompt for each card, so "what can I pick up" is one call.


- `mcp__chat-recall__recall_tasks` — the shared task board: status, assignee,
  project. This is the answer to "what are my open tasks".
- `mcp__chat-recall__recall_task_create` — create a task, optionally assigned to
  a teammate and attached to a project. Returns the new task id.
- `mcp__chat-recall__recall_task_update` — change status, reassign, rename or
  comment. Takes the `t_…` id from `recall_tasks`.
  - **`done` needs the CHANGE.** Pass `diff` — the unified diff of what you changed
    for that card — and `commits` if you committed it. Nothing else can supply it:
    the board cannot see edits made through a shell, and its commit scan only
    searches repositories the session already touched with file tools. The diff you
    record is what the person reads on the card.
  - **`done` needs the session that did the work.** Pass your own session id;
    without one the update is refused. A card asserts a problem in the code, so
    closing it asserts the code changed, and the board shows the files and commits
    behind the claim. If a card should not be worked at all, use `rejected` — that
    is the verdict a machine may not give itself.
  - Cards filed from findings also close THEMSELVES once a re-index stops
    reporting the finding, so fixing the code and re-indexing is usually enough.
    Attach your session anyway: the closure keeps its evidence.
  - **Stay inside the card's project.** A card names one repository; fix it there
    and nowhere else. If the real fix needs a change in another repo, say so and
    leave the card open — the API refuses evidence whose file paths climb out of
    the project, and a diff spanning repositories cannot be reviewed as one change.
  - Filing is capped — at most 10 new cards per run and 50 open at once. A board
    at the ceiling files nothing until cards close; the backlog stays visible in
    the ranked findings view.
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
3. "What should I fix in <project>" → `recall_improvements` for the ranked plan
   across every source at once, or `recall_code_actions` / `recall_code_findings`
   for the code-only view, and `recall_recommendations` when the user wants
   reasoning over how sessions actually went, not just code shape.
   Index first with `recall_code_index` if the repo is not indexed yet.
   "What should I tell Claude about this" → `recall_claude_suggestions`.
   Add `create_tasks: true` to `recall_improvements` ONLY when the user asks for
   the work to be tracked — it writes to the shared board.
4. "What are my/our open tasks" → `recall_tasks`; "what is the team doing" →
   `recall_team_activity`. To CLAIM, close, comment on or re-scope a card, see
   [chat-recall-tasks] — claiming and closing both have required evidence.
5. Leaked secrets found in this project's history → [chat-recall-security].
5. Ground answers in what you found (session ids, finding ids); don't invent status.
