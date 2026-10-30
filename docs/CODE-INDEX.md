# Index a codebase

chat-recall can analyse a repository with codeindex and keep the results on
your server: findings, hotspots and a ranked list of actions. An assistant then
reads them, and the task board can file them as cards.

## Install codeindex

```bash
chat-recall companions install
```

codeindex is an open-source code index (MIT). `chat-recall init` registers it
as an MCP server when it is already on your `PATH`. `chat-recall companions
status` shows what is installed.

## Index a repository

```bash
chat-recall code index ~/code/example-app
```

The analysis runs on your machine, because it needs the files and the git
history. Only the results go to the server. Without a path, the command indexes
the current folder.

An assistant does the same with `recall_code_index`.

## Read the results

```bash
chat-recall code status
chat-recall code show example-app
```

`code status` lists the indexed projects with their health score. `code show`
shows one project: its health, a summary of the findings, and the top actions.

An assistant uses these tools:

- `recall_code_actions`: the ranked plan, each item with an agent prompt.
- `recall_code_findings`: the findings. A category filter takes `security`,
  `literal`, `clone`, `duplication`, `dead_code`, `coupling` or `cycle`.
  `view: "hotspots"` lists files by churn.
- `recall_code_projects`: the indexed projects.

The **Code** view of the web app shows the same results.

## Turn findings into cards

The task board files cards from the findings. A card closes by itself when a
new index stops reporting its finding. To choose which findings become cards,
ask the assistant to set `recall_task_policy`, for example "only security
findings" or "high and critical only". See [Work with a team](./TEAMS.md).
