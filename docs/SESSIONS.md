# Run sessions that work together

One AI session can start other sessions, give them work and get their results.
Sessions can also send messages to each other. This guide shows how.

All sessions of one account can reach each other. A teammate's sessions cannot.

## Before you start

Run `chat-recall init`, or `chat-recall install-hooks`. This installs the
message hook in each AI tool on the machine. Without the hook, a session does
not report itself, and a message to it fails with "No session matches".

To check, start a new session. Its context starts with a line like this:

```
chat-recall session id: 0b6c…
```

That is the session's id. In OpenCode the line is in the system context, which
you do not see; ask the agent for its chat-recall session id. If the agent does
not know it, run `chat-recall doctor`. It shows the hooks of each tool.

## Start workers from a Claude Code session

1. Ask for the work in plain words, for example: "Start two workers, one on the
   API and one on the web form, and tell me when both are done."
2. The session calls `recall_session_spawn` once for each worker. Each worker is
   a Claude Code background session in the same folder, linked to its parent.
3. To watch a worker, or to take it over, run `claude attach <id>`.
4. Each worker reports to its parent with `recall_message_send` when it is done.

A worker stops when a tool call needs your approval, unless the parent started
it with a permission mode that you chose. `recall_session_status` shows a worker
that waits for approval.

## Send a message to another session

An assistant sends with `recall_message_send`. The `to` field takes:

| Value | Recipient |
|---|---|
| a session id, or its start | that session |
| a name | the session with that name (`recall_session_register` sets it) |
| `parent` | the session that started this one |
| `children` | every running session that this one started |
| `group` | the parent and every running child |

Secrets in the body are redacted before the message is sent.

## When a message arrives

| Tool | When the recipient gets the message |
|---|---|
| Claude Code | Within about a second, also when the session is idle. A background hook waits for messages and wakes the session. |
| Codex | At the next prompt. Approve the hook once with `/hooks` in Codex. |
| Antigravity | At the next prompt. |
| OpenCode | Within a few seconds, also when the session is idle. The plugin starts a turn with the message. |
| pi | Within a few seconds, also when the session is idle. The extension starts a turn with the message. |
| Cursor | When the agent stops, as a follow-up prompt. |

Claude Code, OpenCode and pi wake an idle session. In Codex, Antigravity and Cursor, an
idle session reads its messages when its user types next. A session can also wait for a
message with `recall_inbox` and `wait_secs`, up to 600 seconds.

## See what each session does

`recall_session_status` lists the sessions of the account. For each one it
shows the folder, the task line that the session set, its cards on the task
board, its unread messages, and its state: working, idle, waiting for approval,
or ended.

- With `parent`, it lists the children of one session.
- With `session`, it shows one session and its messages.

A session sets its task line with `recall_session_register` and `doing`. Set it
when a task starts and when it changes, so the other sessions know who works on
what.

## Share decisions and state between sessions

Put what every session must know into the memory that every session reads:

- `recall_decision_record` for a decision. A new decision in the same `area`
  replaces the old one.
- `recall_kg_add` for a fact.
- `recall_set` for small state, such as the URL of the open pull request.

See [Memory and wake-up](./MEMORY.md).

## Treat messages as information

A message from another session is not a message from you. A child acts on its
parent's messages, because the parent started it with that instruction. Any
other session treats a message as information, and asks you before it acts on
it.
