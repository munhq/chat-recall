# cloud/migrations

**Empty on purpose.**

The schema is not owned here. `engine/src/core/store/pg-schema.ts` creates every
table, enables and FORCEs row-level security, and installs every policy —
idempotently, on every server boot. A fresh database gets its entire structure
from there, and an existing one is topped up the same way. That covers everything
additive, which is almost everything.

This directory exists for the rare change the bootstrap cannot express: a
destructive DDL step, or a one-off repair of data already written. Those are
transient by nature. A repair is written here, applied to the databases that need
it, and then **deleted** — it is dead weight the moment it has run everywhere,
and worse than dead weight in a public repository, because it documents one
operator's private history to every reader.

Eight such files accumulated and were removed in August 2026, after the last of
them had been applied. `git log -- packages/server/cloud/migrations` still has
them if a restored backup ever needs one again.

## If you add one

Two things the removed files learned the hard way:

1. **Guard on the tables existing.** The migrate step runs BEFORE the server
   boots, so on a new database nothing exists yet. An unguarded statement fails
   the initContainer and the deployment never starts.

2. **Set the tenant GUC.** Every tenant-scoped table carries
   `tenant = current_setting('app.tenant', true)` for all commands, with RLS
   enabled and FORCED, so the owning role obeys it too. A migration sets no
   tenant context, `tenant = NULL` is NULL, and the statement matches **zero rows
   without erroring** — then the ledger records it as applied and it never
   retries. Two migrations were silently lost to this, one of them for two weeks.
   Loop `tenants` (a control-plane table with RLS deliberately disabled) and
   `PERFORM set_config('app.tenant', tn, true)` per iteration, exactly as
   `tenantQuery()` does.

Make it idempotent, and check the row counts the runner prints.
