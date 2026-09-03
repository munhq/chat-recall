---
name: chat-recall-memory
description: >-
  Store and recall durable facts, decisions, and notes with chat-recall's
  knowledge graph and diary. Use when the user says "remember this", "note that
  we decided…", "what do you know about X", "did we decide Y", "what's our
  convention for Z", or when a non-obvious decision/preference is made that future
  sessions should know. Covers the temporal knowledge graph, decision records,
  the agent diary, and a scoped key/value store.
---

# Durable memory with chat-recall

Two directions: **recall** what's already known, and **record** new facts so
future sessions inherit them.

## Recall what's known

- `recall_kg_query` — query an entity's relationships (facts
  with validity windows). `as_of: <date>` time-travels to what was true then.
  Use to VERIFY before asserting a fact ("did we decide to use Postgres?").
- `recall_kg_timeline` — chronological story of an entity (or
  everything). `recall_kg_stats` — graph overview.
- `recall_wake_up` — high-importance facts + KG snapshot for a
  fast "what's true right now".
- `recall_diary_read` — prior agent diary entries (narrative
  notes across sessions). `recall_get` — a scoped key/value.

## Record new knowledge (do this when something non-obvious is decided)

- `recall_decision_record` — an explicit decision (subject,
  decision, reason, importance). Shows up in future wake-up context. Use the
  moment you and the user agree on something a later session would need.
- `recall_kg_add` — assert a fact triple
  (subject → predicate → object, optional `valid_from`). E.g.
  `("chat-recall", "uses", "Postgres")`.
- `recall_kg_invalidate` — mark a fact no longer true when a
  decision is reversed or a tool is replaced (keeps the graph honest).
- `recall_diary_write` — narrative notes ("what I learned /
  what matters") keyed per agent, across sessions.
- `recall_set` — small structured state (current PR url,
  branch, preferred test runner); `scope` namespaces per project.

## When to record

Record when a decision or preference is (a) non-obvious, (b) not already captured
by the code/CLAUDE.md/git history, and (c) useful to a future session. Prefer
`recall_decision_record` for choices with a rationale, `recall_kg_add` for plain
entity-relationship facts, `recall_diary_write` for narrative context, `recall_set`
for transient pointers. Don't duplicate what the repo already records.

## Verify-then-assert

Before stating "we decided X" or "we use Y", confirm with `recall_kg_query`
(and `as_of` if the timing matters) rather than relying on memory.
