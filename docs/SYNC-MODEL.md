# How sync works

The CLI sends your sessions to the server and makes sure that none is lost on
the way. This page explains how it decides what to send, and how it recovers.

## What the CLI sends

For each session, the CLI sends the turns with secrets masked, and values it
computes from the transcript: the project, the token counts and cost, the files
changed, the outcome, the commits and the facts for the knowledge graph. It
does not send a stored copy of the conversation, and it keeps no derived state
of its own. Everything it sends, it computes again from the transcript.

## Which sessions it sends

The CLI keeps a ledger for each server: for each session, the time of the
transcript that it sent, and the version of the code that read it. A sync walks
all sessions and sends a session when its transcript changed or when the
reader code changed since the last send. A fix in the reader therefore reaches
the sessions that were sent before the fix.

A session is marked as sent only after the server confirmed the batch that
held it. A session that failed stays unmarked, and the next sync sends it
again. `chat-recall verify` compares the ledger with what the server holds.

The background service runs the sync after a transcript changes. It installs
as a user service: systemd on Linux, launchd on macOS, a scheduled task on
Windows. It needs no administrator rights.

## Transcripts that shrink

Some tools rewrite a transcript in place, for example when a session resumes,
and the rewrite can be shorter than the file before it. A sync of the shorter
file would lose turns. So the CLI also keeps a raw archive of each session on
the server, and the archive never shrinks. `chat-recall repair` rebuilds a
damaged session from it.

A large archive goes to object storage in parts, straight from the CLI, so the
server does not hold it in memory.

## Deletions stay deleted

`chat-recall delete` and `recall_forget` remove a session on every server and
leave a tombstone. A later sync from any machine skips a session with a
tombstone, so the transcript on another disk does not bring it back.
`chat-recall restore` removes the tombstone.

## More than one server

The CLI can sync to more than one server, for example the hosted service and a
self-hosted one. Each server has its own ledger, so a new server gets all
sessions, and the old one keeps its state. `chat-recall logout <server-url>`
removes one.
