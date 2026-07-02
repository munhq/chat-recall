# Contributing to chat-recall

## Before opening a PR

1. **There's probably a session for this already.** Run `chat-recall search "<topic>"` against your own index — if you've worked on something similar, link it in the PR. Eat the dogfood.
2. Open an issue first if the change is more than a one-file fix. Saves both of us if the approach is wrong.
3. Run `npm run build` and `cd web/server && npm run build && cd ../client && npm run build`. Both must pass tsc cleanly.
4. Run `npm run test:e2e` for any UI change. There are 21 Playwright tests; don't add a 22nd unless it's actually testing new behavior.

## Local dev

```bash
git clone https://github.com/darkkraft/chat-recall.git
cd chat-recall
npm install
npm run build
npm run web:install
CHAT_RECALL_STORAGE=sqlite npm run web:dev   # API :5000, UI :5174
```

`CHAT_RECALL_STORAGE` is required — the server refuses to guess a storage
backend (fail-closed; a misconfigured deployment must not silently land on a
local file). Use `sqlite` for quick local dev, or `postgres` + `DATABASE_URL`
to develop against the docker-compose stack.

## Code style

- TypeScript, ES modules. Imports use `.js` extensions even for `.ts` files (NodeNext).
- No new dependencies without a sentence in the PR explaining why a stdlib + 20 lines wouldn't do.
- Don't write comments that describe **what** the code does — write the code clearly. Reserve comments for **why** when the answer isn't obvious.
- Errors propagate. Don't catch-and-log-and-continue unless you've thought about why a partial result is acceptable.

## Adding a new memory source

The plugin interface is in `src/types/memory.ts`. A new source needs three methods: `discover()`, `parse()`, `extractLinks()`. See `src/parsers/diary-source.ts` for a small example. After implementing:

1. Add the source-type literal to `SourceType` in `src/types/memory.ts` and `web/client/src/services/api.ts`.
2. Register it in `src/cli.ts`, `src/mcp.ts`, and `web/server/src/imports.ts`.
3. Add a badge entry in `web/client/src/components/primitives.tsx` (`SourceBadge`).
4. Add a tab to `web/client/src/components/MemoryExplorer.tsx`.
5. Add `'<sourceType>'` to `VALID_SOURCE_TYPES` in `web/server/src/routes/memory.ts`.
6. Auto-indexer watch entry if applicable.

Diary integration is the canonical end-to-end example — diff `git log -p -- src/parsers/diary-source.ts web/client/src/components/MemoryExplorer.tsx web/server/src/routes/memory.ts`.

## Adding a new MCP tool

Tools live in `src/mcp.ts`. Each one has a Zod input schema, a description, and a handler. Keep handlers under ~60 lines — anything bigger probably belongs in `src/core/`. Test by running `node dist/mcp.js` and pointing a Claude Code session at it.

## What I (probably) won't merge

- Refactors that don't fix a real bug or feature.
- Adding analytics, telemetry, or "phone home" features. Chat-recall is local-first by intent.
- New summary/embedding providers without a `Test connection` probe wired up.
- PRs that disable the e2e tests "because they're flaky on my machine".

## Releases

Maintainer publishes from `main` after CI is green and CHANGELOG.md has an entry for the new version. `npm publish --access public` from a clean checkout. The CI workflow handles the npm publish on tag push.
