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
| `packages/engine:test`, `packages/cli:test`, `packages/server:test` | the runners, after a landing, when the change matches the `paths` of the check |
| `packages/*:syntax` and `modules` | the runners, before a landing |
| the tests with the `.pg.test.ts` suffix | GitHub Actions only: the runners have no Postgres |

A test with the `.pg.test.ts` suffix skips on the runners, because the runner sets no `DATABASE_URL`. The jobs `postgres-tests` and `server-tests` of `.github/workflows/ci.yml` run these tests against a real Postgres.

## Read a result

The landing prints the run id of each check. Read the log of a run with `desk runs log <id>`, and read the run of a landing with `desk runs landing <seq>`.
