# Contributing to chat-recall

## Repo layout

A TypeScript monorepo (npm workspaces):

- `packages/engine` — shared library: parsers, storage drivers, knowledge graph,
  classifier, secret redactor, tool backends. **MIT.**
- `packages/cli` — the collector CLI + MCP server (`chat-recall`,
  `chat-recall-mcp`, `chat-recall-watch`). **MIT.**
- `packages/server` — Express API + React dashboard + multi-tenant SaaS server.
  **Business Source License 1.1** (source-available, not OSI open source).

## Before opening a PR

1. **There's probably a session for this already.** Run
   `chat-recall search "<topic>"` against your own history — if you've worked on
   something similar, link it in the PR.
2. Open an issue first if the change is more than a one-file fix.
3. Green checks: `npm run build` (typechecks every workspace via `tsc -b` and
   bundles the CLI) and `npx vitest run` (the unit suite) must both pass. The
   `CI` workflow runs exactly these on every PR.
4. Run `npm run test:e2e` for any dashboard/UI change.

## Local dev

```bash
git clone https://github.com/darkkraft/chat-recall.git
cd chat-recall
npm install          # optional native deps (better-sqlite3) build here; skipped
                     # gracefully if you have no C++ toolchain
npm run build        # tsc -b + CLI bundles
npx vitest run       # unit suite
```

To work on the **dashboard/server**, run it against a real Postgres (there is no
user-facing SQLite mode — the `sqlite` storage driver exists only for unit
tests):

```bash
docker compose up -d db                 # Postgres (pgvector) from the compose
npm run web:install                     # install dashboard deps
CHAT_RECALL_STORAGE=postgres \
  DATABASE_URL=postgres://chat_recall:chat_recall@localhost:5432/chat_recall \
  npm run web:dev                       # prints the API + UI URLs on startup
```

`CHAT_RECALL_STORAGE` is required — the server fails closed rather than guessing
a backend.

## Code style

- TypeScript, ES modules. Imports use `.js` extensions even for `.ts` files (NodeNext).
- No new dependencies without a sentence in the PR explaining why stdlib + 20 lines wouldn't do.
- Comments explain **why**, not **what**. Write the code clearly instead of narrating it.
- Errors propagate. Don't catch-and-log-and-continue unless you've thought about why a partial result is acceptable.

## Adding a new memory source

The plugin interface is in `packages/engine/src/types/memory.ts`. A new source
implements `discover()`, `parse()`, `extractLinks()`. See
`packages/engine/src/parsers/diary-source.ts` for a small example. After
implementing:

1. Add the literal to `SourceType` in `packages/engine/src/types/memory.ts`.
2. Register it where the source registry is built (`packages/engine/src/parsers/all-sources.ts`).
3. Surface it in the dashboard under `packages/server/client/src/` if it should be browsable.
4. Add an auto-indexer/collector watch entry if it lives in a new directory.

## Adding a new AI tool backend

One new file in `packages/engine/src/core/backends/`, one line in
`backends/index.ts`, zero edits elsewhere — the generic engine consumes the
`ToolBackend` interface. Walkthrough: [`docs/ADDING_A_TOOL.md`](docs/ADDING_A_TOOL.md).

## Adding a new MCP tool

Tools live in `packages/cli/src/mcp.ts` — each has a Zod input schema, a
description, and a handler. Keep handlers small; heavy logic belongs in
`packages/engine/src/core/`. Test with `node packages/cli/dist/mcp.js` pointed
at a Claude Code session.

## What probably won't be merged

- Refactors that don't fix a real bug or feature.
- Analytics/telemetry/"phone home" defaults. Redaction and explicit opt-in are core.
- New summary/embedding providers without a `Test connection` probe.
- PRs that disable tests "because they're flaky on my machine".

## Releases

The maintainer publishes from `main` after CI is green and `CHANGELOG.md` has an
entry. The CLI is distributed **as a tarball baked into the server image**
(`npm pack` of `packages/cli`, served at `/install/chat-recall.tgz`) — collectors
auto-update from the server they're logged in to. `packages/engine` and
`packages/server` are `private` and are not published to the npm registry.
