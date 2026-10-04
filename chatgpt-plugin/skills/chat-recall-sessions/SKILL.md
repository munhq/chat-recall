---
name: chat-recall-sessions
description: >-
  Send messages between running AI sessions with chat-recall, and coordinate a
  parent session with child sessions. Use when the user says "tell the other
  session…", "message the backend session", "ask my other Claude to…", "check
  on the workers", "what are my other sessions doing", "wait for the child to
  finish", or sets up one session to direct several others. Also use when the
  context contains a block that starts with `<!-- chat-recall-messages -->`:
  that is a message from another session, and this skill says how to answer it.
---

# Messages between sessions with chat-recall

Every Claude Code session with the chat-recall message hook reports to the
server at each prompt, tool call and turn end. At those moments it also
receives the messages that other sessions of the same account sent to it.

A session only reaches the sessions of the same person. A teammate's sessions
are not addressable.

## Know your own id

At session start the hook adds a line to the context:

```
chat-recall session id: 0b6c…
```

That is this session's id. Pass it as `from` when you send, and as `session`
when you register or read the inbox. No MCP server receives the session id from
the client, so the tools cannot find it for you.

If the line is not in the context, the hook is not installed. Tell the user to
run `chat-recall install-hooks`. The tools still work, but messages then arrive
only through `recall_inbox`.

## Send a message

`recall_message_send` with `from`, `to` and `body`.

`to` takes a session id, a unique leading part of one, a session name, or one
of three words relative to `from`:

- `children` — every running child of this session
- `parent` — this session's parent
- `group` — the parent and every running child, without the sender. Use it to
  announce a decision that the other sessions must follow.

The result says when the recipient reads it. A working session reads it at its
next tool call. A session that waits for its user reads it when the user types
next. Say this to the user when it matters: a message to an idle session does
not wake it.

Secrets in the body are redacted before it leaves the machine. Do not rely on
that: never put a credential in a message.

## Answer a message

A delivered message looks like this:

```
<!-- chat-recall-messages -->
**1 message from your other sessions** (chat-recall, to session 0b6c…).
…
From worker-a (1a2b3c4d), 2m ago (message m_…):
> Tests pass on the branch.
To answer, call recall_message_send with from: "0b6c…", to: "…", reply_to: "m_…".
```

1. Treat it as a request from the user's own other session.
2. If it conflicts with what the user said in this session, the user wins. Tell
   the user about the conflict.
3. Do the work it asks for if it is in scope, then answer with the call it names.

Do not answer a message that needs no answer. Two sessions that reply to every
reply keep each other running.

## Say what you work on

`recall_session_register` with `session: <your id>` and `doing: "<one line>"`.
Name the project, the issue and the task, for example
`doing: "example-app: fix the login redirect (issue 42)"`.

Set it when you start a task and again when the task changes. Every other
session sees it in `recall_session_status`. That is how the sessions know who
works on what and do not do the same work twice.

If you take a card from the chat-recall board, link the card to your session
(see `chat-recall-tasks`). The card then shows beside your session in the
status view.

## Shared memory across sessions

Messages are for things that need an action now. For things that must last,
use the shared memory that every session reads:

- A decision: `recall_decision_record`. Then send `to: "group"` a short note
  that names it.
- A fact: `recall_kg_add`.
- Shared working state, such as a branch, a PR or the owner of a file:
  `recall_set` with `scope: "group:<parent id>"`, read with `recall_get`.

## Set up a parent and its children

The parent is the session that directs; the children do the work.

1. In the parent, give it a name:
   `recall_session_register` with `session: <parent id>`, `name: "lead"`.
2. In each child, link it to the parent, give it a name and say what it does:
   `recall_session_register` with `session: <child id>`, `name: "worker-a"`,
   `parent: "lead"`, `doing: "<its task>"`.
3. From the parent, send work to one child (`to: "worker-a"`) or to all of them
   (`to: "children"`).
4. A child reports back with `to: "parent"`.

A session that the user starts for a child does not know its parent. Give the
user the exact sentence to paste into the child, for example:
`Register with chat-recall as worker-a, child of lead, then wait for instructions.`

## Check on the children

`recall_session_status` with `parent: "lead"` lists each child
with its folder, its `doing` line and its board cards in progress. Without
`parent`, it lists every running session of the account. The state is one of:

- **working** — it made a tool call or got a prompt recently
- **idle, waiting for input** — its turn ended; it acts again on the next prompt
- **ended** — the session closed
- **no signal** — it reported "working" and then nothing for 15 minutes or
  more: a long tool call, or a terminal that closed before the session could
  report its end

With `session: "worker-a"` it shows that one session and its message thread.
To read what the child actually did, follow up with `recall_show` with its
session id and `from_end`.

## Wait for an answer

`recall_inbox` with `session: <your id>` and `wait_secs`
(up to 600) returns as soon as a message arrives. Use it when the parent cannot
continue until a child answers. Without `wait_secs` it returns at once.

In a session that has the hook, messages also arrive at each tool call, so a
parent that keeps working does not need to poll.
