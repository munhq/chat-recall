# How chat-recall works

chat-recall has two parts: a CLI on each machine, and a server. The CLI reads
what your AI tools write to disk and sends it to the server. The server stores
it, searches it, and answers the assistants. There is no third part, and no
local database.

## The CLI collects

Each AI tool writes its sessions to its own folder, in its own format: Claude
Code writes JSONL under `~/.claude/projects/`, OpenCode keeps a SQLite
database, Codex writes rollout files by date. The CLI has one reader for each
tool, and each reader turns that tool's format into the same events: a prompt,
an answer, a tool call, a file edit. From then on, chat-recall treats a Codex
session and a Claude Code session the same way.

The CLI also reads plans, task lists, `CLAUDE.md` files, shell history, the
paste cache, agent diaries, skills, MCP registrations, commands and agents.

Before anything leaves the machine, the CLI masks every secret it finds. The
server never receives the plain value. See
[Secret detection](./SECRET-DETECTION.md).

## The server stores and answers

The server keeps everything in Postgres. It splits each session into chunks,
indexes them for search, classifies them, and rebuilds the conversation view
from them. The server owns all state: deletions, summaries, secret findings,
decisions and the knowledge graph. A second machine that logs in to the same
account sees the same memory.

The server runs either as the hosted service at chatrecall.dev or on your own
machine with Docker Compose. Both are the same program. See
[Self-hosting](./SELF_HOSTING.md).

## The assistants ask

An assistant reaches the memory through the MCP server, which runs on your
machine and calls the server for each tool. One MCP process serves all
sessions of a machine: each session starts a small relay that connects to it,
so ten open sessions do not load ten copies of the engine.

An assistant without the CLI, such as claude.ai or ChatGPT, connects to the
remote MCP endpoint of the server. See [Connect claude.ai or ChatGPT](./CONNECTORS.md).

## Hooks fill the gaps

An assistant uses memory only when it thinks to ask. Hooks put memory in front
of it without that step: the wake-up bundle at the start of a session, a note
when a prompt resembles earlier work, a warning when a tool call goes against a
decision, and the messages from other sessions. See [Hooks](./HOOKS.md).

## Why sync instead of reading the disk

A local-only tool would need no server. It would also see only one machine, and
only the tools on that machine. Most work now spans several tools and often
several machines, and the question "what did I decide about this" has its
answer in whichever session made the decision. One server gives one answer to
that question from every machine and every tool.
