# How search works

Search runs on the server, in Postgres.

## Keyword search

The default search is Postgres full-text search. Each chunk of a session gets a
text index when it reaches the server. A query matches words and their stems,
and the results are ranked by how well each chunk matches. The `pg_trgm`
extension adds tolerance for typing errors.

This search needs no embedding model, no API key and no extra service, so it
works the same on every server.

## Vector search

Vector search finds text with a similar meaning, also when it shares no words
with the query. It is opt-in. It needs an embedding model: an
OpenAI-compatible endpoint, Ollama, or a Gemini API key on a self-hosted server.
The vectors are stored with pgvector.

A query asks for the vector tier with `semantic`. The server uses it only when
an embedding model is configured and the account's plan includes embeddings.
Otherwise the query runs as keyword search. See
[Environment variables](./ENVIRONMENT.md).

## Ranking cost

Keyword search ranks the best 500 matches of a query before it reads their
text. A common word can match tens of thousands of chunks, and ranking all of
them took seconds on a large database. The 500 candidates are then scored from
their own rank, type and timestamp, and only the top results have their text
read. The bound changes nothing you see: the same top results come back in the
same order.

Each chunk carries `has_vector`, a flag the embedder sets when it stores a
vector for the chunk and clears when it removes one. The pending-vector count
that scales the embed workers reads this column instead of checking the vector
table for every chunk, so it stays fast on a large corpus. The name is also the
one to look for in the schema when a chunk with a vector appears queued.

Each chunk also carries `trivial`, a flag the writer sets when its session is
too short to embed (few turns and little output). The pending-vector count and
the embed worker skip a chunk with `trivial = true`, so a short session never
adds work to the queue. The count stops at `PENDING_VECTORS_CAP` entries per
tenant, so checking the backlog stays fast however large the queue gets; the
number is exact below that ceiling.

## What a search covers

`recall_search` and `chat-recall search` search sessions. `recall_memory_search`
and `chat-recall memory search` search every kind of memory: sessions, plans,
tasks, `CLAUDE.md` files, shell history, the paste cache and agent diaries.
`recall_subagent_search` searches the transcripts of subagents, whose work
never appears in the main conversation.

Three options change what comes back:

- `like_session` finds sessions similar to one session. It uses that session's
  first prompt as the query.
- `include_outcome` adds a line to each result: shipped, interrupted or
  abandoned, with the edit count.
- `project_filter` keeps the results to one project.

## Why keyword search is the default

Most questions to a memory name the thing they look for: a library, an error
message, a file, a decision. Keyword search finds those exactly, at no cost per
query, and gives the same answer every time. Vector search helps with vague
questions, but it costs an embedding call for each query and each chunk, so it
stays a choice.
