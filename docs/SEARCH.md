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
