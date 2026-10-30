# Work with a team

A team shares projects, a task board and a library of skills, commands, agents
and MCP servers. Your sessions stay private until you share their project.

## Create a team and add people

1. Create the team. You become its owner:

   ```bash
   chat-recall team create acme
   ```

2. Make an invite for each person:

   ```bash
   chat-recall team invite --email teammate@example.com
   ```

   The command prints a single-use token. The email is only a label.

3. Each person accepts on their own machine:

   ```bash
   chat-recall team join <invite-token>
   ```

To see your teams, run `chat-recall team whoami`.

## Share a project

Nothing you sync is visible to the team until you share its project:

```bash
chat-recall share git:github.com/acme/example-app
```

`chat-recall shares` lists your shared projects, and `chat-recall unshare
<project_id>` stops a share. `chat-recall projects` lists the project ids on
this machine.

Teammates then see your sessions of that project in search and in the team
view. An assistant answers "what has the team worked on" with
`recall_team_activity`.

## Use the task board

The board holds the team's tasks. An assistant works on it with these tools:

- `recall_tasks` lists the cards. With `detail: true` it returns the full brief
  of each open card.
- `recall_task_create` adds a card.
- `recall_task_update` changes a card. To start work, the agent sets the
  status `in_progress` and links its own session. To finish, it sets `done`
  and passes the diff or the commits. The board refuses a `done` without them.
- `recall_task_comment` adds a note.

From the terminal, `chat-recall tasks list` shows your cards.
`chat-recall tasks pull` writes them to `TEAM_TASKS.md` in the project, and
`chat-recall tasks push` sends your status changes back.

The board also files cards from code findings. `recall_task_policy` sets which
findings become cards: a severity floor, the categories, a limit of open
cards, and projects that never get cards.

## Share skills, commands, agents and MCP servers

1. Publish a file to the team library:

   ```bash
   chat-recall team publish skill release-notes ./skills/release-notes/SKILL.md
   ```

   The types are `skill`, `command`, `agent`, `mcp`, `plan`, `plugin`,
   `instructions` and `hook`. `--tool` names one AI tool; the default is all.

2. Each teammate pulls the library into their own tools:

   ```bash
   chat-recall team pull
   ```

   `--dry-run` shows what it would write.

`chat-recall team list` lists the library. The owner removes an item with
`chat-recall team revoke <artifact-id>`.

To leave a team on one machine, run `chat-recall team leave`. It keeps the
files that you pulled, and it does not end your membership on the server.
