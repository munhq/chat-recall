# Memory and wake-up

A new AI session knows nothing about your past work. chat-recall keeps a memory
of that work on your server and gives the important part of it to each new
session. This page explains what the memory holds, where each part comes from,
and how chat-recall chooses what a new session sees.

## Four kinds of memory

**Your sessions.** Every transcript that your AI tools write is synced to your
server, with secrets redacted. Search reads them, and so do `recall_show` and
`recall_context`. This is the largest part of the memory, and the only part
that you do not write on purpose.

**Classified chunks.** When a session reaches the server, the server splits it
into chunks and classifies each chunk as a decision, a preference, a milestone,
a problem or a discovery. Each chunk also gets an importance from 0 to 5.

**The knowledge graph.** Facts in the form subject → predicate → object, for
example `example-app → uses → Postgres`. Each fact has a time window: it is
valid from one date, and a later fact can end it. `recall_kg_query` with
`as_of` shows what was true on a given date.

**Notes that an agent or you write.** A decision recorded with
`recall_decision_record`, a diary entry with `recall_diary_write`, or a small
value with `recall_set`.

## Where the facts come from

Most facts come in without a step from you:

- During a sync, the CLI finds the tools and technologies, projects, people
  and decisions that a session names, and adds them to the knowledge graph.
- When a Claude Code session ends, the escalation hook adds the session's
  decisions, your corrections and its outcome to the knowledge graph
  (`chat-recall escalate <session-id>` does the same for one session).

An explicit decision is stronger than an extracted one. Record it with
`recall_decision_record` and give it an `area`, such as `auth` or `database`.
A later decision in the same area closes the earlier one. Without an area, both
stay valid, and a new session sees both answers.

## How the classifier scores a chunk

The classifier uses fixed text patterns. It does not call a model. A chunk gets
a type only when it holds a strong marker, an explicit phrase such as "we
decided to", "I prefer" or "root cause". A single topic word such as
"architecture" or "bug" adds weight to a type that a strong marker set, but it
cannot set a type alone.

The importance measures the strength of that evidence. It does not measure how
much the content matters. Importance 4 or 5 needs a strong marker, and text
with only weak markers gets importance 1.

When the rules change, a background sweep classifies the existing chunks again,
so older sessions get the new rules too.

## What a new session sees

The wake-up bundle is the start context of a session. It holds:

1. An identity line, from `~/.chat-recall/identity.txt` when that file exists.
2. The top classified chunks of type decision, preference or milestone, at
   importance 4 or 5.
3. The current facts of the knowledge graph.

The bundle has no summary step. It holds the items that the classifier and the
knowledge graph rank highest, so a wrong item in it comes from a wrong fact or
a wrong marker, and you can find and fix that item.

In Claude Code, the wake-up hook adds the bundle at the start of each new
session, for the project of the session's folder. In the other tools, an agent
calls `recall_wake_up`. To build the bundle yourself, see
[Give a new session your context](./WAKE-UP.md).

## Wake-up and resume are different

Wake-up gives the facts that stay true across sessions. Resume gives the state
of the last piece of work: what was done, what is open and which files changed.
`recall_smart_resume` builds the resume. A session that continues work uses
both.
