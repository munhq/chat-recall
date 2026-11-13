# AGENTS.md

How an agent tests a change in this repository.

## Test on the runners, not on the PC

The PC of the owner is not a test machine. Do not run a test suite, a lint or a build there.

1. Run the checks of the change with `desk try`. It runs each check of `.desk/config.json` that the changed paths match, on the runners of desk (munhq/desk#234).
2. If your desk has no `desk try`, run `desk pr create`. A proposal runs the checks of the repository on the runners and it does not land the change.
3. One quick test of one file is permitted on the PC.

## What runs where

| Check | Where it runs |
|---|---|
| `packages/engine:test-1of2` and `-2of2`, `packages/cli:test-1of2` and `-2of2`, `packages/server:test-1of2` and `-2of2` | the runners, after a landing, when the change matches the `paths` of the check |
| `packages/*:syntax` and `modules` | the runners, before a landing |
| the tests with the `.pg.test.ts` suffix | GitHub Actions only: the runners have no Postgres |

A test with the `.pg.test.ts` suffix skips on the runners, because the runner sets no `DATABASE_URL`. The jobs `postgres-tests` and `server-tests` of `.github/workflows/ci.yml` run these tests against a real Postgres.

## Read a result

The landing prints the run id of each check. Read the log of a run with `desk runs log <id>`, and read the run of a landing with `desk runs landing <seq>`.

## Keep a check under 60 s

The goal of the owner is a check, a test run, a lint and an image build that end in under 60 s on the runners, with no new node and no raised CPU or memory request. These rules came from the measured runs of this repository (munhq/chat-recall#18). They hold for every repository on desk.

1. Find the time before you change anything. Read `desk runs log <id>` and sort the test files by their duration. In this repository 5 files held 330 CPU-seconds of 450 (the vault tests derived a 64 MiB Argon2 key in each test; the waiter test slept 30 s).
2. A test must not pay the production cost of a thing that it does not test. Give the function an option (`kdf` in `vaultEnable`, `vaultSync` and `vaultRestore`) or a setting (`CHAT_RECALL_WAIT_BACKOFF_UNIT_MS`) whose default is the production value, and set the cheap value in the test. Keep one test that proves the default.
3. A check has one input: the `paths` of its own package. A check that lists `package.json` and the lock file of the root reruns for every dependency change, so list only what the package reads.
4. A step that installs dependencies keeps its `node_modules` for the next run: key the folder by the hash of the lock files and the node version.
5. Split a package into shards when its longest file is under 40 s and its total is over 60 s of wall time. A shard is a validation entry with its own `paths`. Do not split a file: the longest file is the floor of the wall time.
6. Order the layers of a Dockerfile by how often their inputs change: the system packages, then the lock files and the install, then the sources. A stage that only checks a result hands its output to the next stage with `COPY --from` of a small file, so BuildKit keys the next step by the content of that file.
7. Use a bind mount (`RUN --mount=type=bind,from=<stage>`) when a step only reads a stage. `COPY --from=<stage> /app/` writes the whole stage again as a layer.
8. Prove one change at a time with one `desk try`. Do not start several runs at once: the 40 cores of the cluster are shared with production.
