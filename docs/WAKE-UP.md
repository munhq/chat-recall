# Give a new session your context

This guide gives a new AI session the decisions, preferences and facts of your
earlier work, and the state of the work you want to continue. For what the
memory holds and how chat-recall ranks it, see [Memory and wake-up](./MEMORY.md).

## In Claude Code

`chat-recall init` installs the wake-up hook. It adds the wake-up bundle of the
project to each new session, and to a session after `/clear`. It does not run
on a resumed session, because that session still has its context.

To check that the hook runs, start a new session and look for the facts at the
start of its context. If they are missing, run:

```bash
chat-recall doctor
```

The hook gives up after 10 seconds, so a slow server never delays a session.
`CHAT_RECALL_WAKEUP_TIMEOUT` changes the limit.

## In another AI tool

Ask the agent to call `recall_wake_up` at the start of the session. To keep it
to one project, pass `project`:

```
recall_wake_up { "project": "example-app" }
```

`max_facts` and `max_kg_facts` change how many items the bundle holds.

## From the terminal

```bash
chat-recall memory wake-up --project example-app
```

The command prints the bundle. Paste it into any tool, or pipe it into a
script.

## Add an identity line

1. Write one or two lines about yourself and how you work into
   `~/.chat-recall/identity.txt`.
2. Start a new session.

The bundle starts with that text. `recall_wake_up` with `identity` replaces it
for one call.

## Continue the last piece of work

Ask the agent to call `recall_smart_resume`, or say "continue where we left
off". It returns what the newest session did, what is still open, the changed
files and the cost, then a short digest of the two sessions before it.

- `project_filter` keeps it to one project.
- `session_id` resumes one session.
- `depth` sets how many sessions it covers, up to 5.

## Make a decision part of every wake-up

Ask the agent to record it, for example: "Record the decision: we use Postgres
for the job queue, area database." The agent calls `recall_decision_record`.

Give importance 4 or 5 to a decision that every future session must see. Lower
values are stored but stay out of the bundle. A later decision in the same
`area` replaces this one.
