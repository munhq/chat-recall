# Batch writes on the ingest path

Specification for `POST /api/sync`. Written so it can be checked against the
implementation by someone who did not write either.

## The defect

The ingest handler calls the database once per row, sequentially, holding one
pooled connection for the whole request.

Measured on a production tenant, one session:

| table | rows for one session |
|---|---|
| memory_chunks | 220 |
| secret_findings | 26 |
| kg_triples | 19 |
| compute_cache | 4 |
| memory_metadata | 1 |
| content_cache | 1 |
| session_metadata | 1 |
| raw_sessions | 1 |
| **total** | **273** |

Those 273 rows cost ~17 statements, because only `setItems`, `addChunksFTS` and
`addLinks` take a set; every other write is one row per statement. A batch of 50
sessions is therefore ~850 sequential statements. `importTriple` is worse: four
statements per triple (two entity upserts, a lookup, an insert).

The consequences, all measured:

- A batch took 124,997 ms, repeatedly and to the millisecond. That is not work.
  It is the connection pooler ending a queued request at its 120s default.
- The pooler serves 20 server connections. `PG_POOL_MAX` is 20 **per process**
  and the deployment autoscales to 6 replicas, so the app can demand 120.
- A local benchmark of the graph path: 1,200 triples took 12,094 ms one at a
  time and 99 ms batched, on a database with no network and no pooler in front.

The data is not the problem. The whole tenant is under 1 GB: 260,722 chunks
(499 MB), 16,314 metadata rows (19 MB), 17,176 triples (3.6 MB).

## Design

### 1. Delta detection stays in the client, per tool

| tool | transcript | how the delta is found |
|---|---|---|
| claude, codex, agy | append-only JSONL | last acked byte offset; parse from there, emit new turns only |
| cursor, opencode | SQLite | no offset is possible; hash the parsed content, emit the full row set when it differs |

Both paths emit the same wire shape — a flat array of rows per table. The
protocol carries no tool-specific branch.

### 2. Every table is written by key

A write is an upsert on a deterministic key. Never delete-then-insert.

| table | key | status |
|---|---|---|
| memory_metadata | (tenant, id, source_type) | exists |
| content_cache | (tenant, id, source_type) | exists |
| session_metadata | (tenant, session_id) | exists |
| compute_cache | (tenant, session_id, kind) | exists |
| secret_findings | (tenant, session_id, detector, rule, line) | exists |
| memory_chunks | (tenant, chunk_id) | exists |
| kg_entities | (tenant, id) | exists |
| kg_triples | (tenant, subject, predicate, object, valid_from, valid_to) | **to add** |

`kg_triples` is the only gap. Its primary key is `(tenant, id)` where `id`
contains `Date.now()`, so the same fact gets a new id on every import and
`ON CONFLICT` cannot dedupe it. That is why `importTriple` runs a SELECT first.

The index must be **partial on live rows**:

```sql
CREATE UNIQUE INDEX kg_triples_live_key
    ON kg_triples (tenant, subject, predicate, object, COALESCE(valid_from,''))
 WHERE valid_to IS NULL;
```

A full unique index including `valid_to` is wrong. `addTriple` and `invalidate`
supersede by setting `valid_to` on an existing row, which moves that row's key.
If an expired row already occupies the destination key the UPDATE raises a
unique violation and fails the request:

```
row A  (s,p,o, from=d1, to=d5)   expired, imported from a client
row B  (s,p,o, from=d1, to=NULL) live
supersede on d5 → B.valid_to = d5 → B's key becomes (d1,d5) = A's key → violation
```

Rows leave a partial index when they expire, so the move is always safe. The
import path, which must also match expired rows, uses a plain (non-unique) index
on the full tuple and a set-based anti-join.

### 3. A row that did not change is not written

Postgres suppresses the write itself:

```sql
INSERT INTO memory_chunks (tenant, chunk_id, item_id, text, chunk_type, ...)
VALUES (...), (...), (...)
ON CONFLICT (tenant, chunk_id) DO UPDATE
   SET text = excluded.text, chunk_type = excluded.chunk_type, ...
 WHERE memory_chunks.text       IS DISTINCT FROM excluded.text
    OR memory_chunks.chunk_type IS DISTINCT FROM excluded.chunk_type;
```

When the guard is false the statement writes nothing for that row: no new tuple,
no index update, no WAL. This is the whole "do not rewrite unchanged data"
requirement, enforced per row by the database, with no content hashing, no
manifest exchange, and no migration of existing ids.

Every table gets the same guard over the columns that carry content. Columns
that are pure bookkeeping (`indexed_at`, `updated_at`) are excluded from the
guard, or every row always differs and the guard does nothing.

### 4. One pass, eight statements

The handler collects the whole batch into eight arrays, then writes. No database
call occurs inside the per-session loop.

```
for each conversation in the batch:      (no awaits — pure computation)
    build its metadata row
    build its chunk rows
    build its finding rows
    build its compute rows
    …append to the batch arrays

then, in one transaction, one connection:
    8 × INSERT … VALUES (multi-row) … ON CONFLICT (key) DO UPDATE … WHERE …
```

State the handler needs from the database before the loop (prior content, max
chunk index, existing items) is fetched in **one query per kind**, keyed by the
whole batch, before the loop starts.

### 5. Deadlock avoidance

Each array is sorted by its key before its statement runs. Two concurrent
batches touching overlapping rows then acquire locks in the same order and
cannot deadlock.

### 6. Statement size

Cap a statement at 1,000 rows (≈11,000 bind parameters against a 65,535 limit)
and loop. Above 10,000 rows for one table in one request — which happens only on
a first sync — that table switches to `COPY` into an unlogged staging table
followed by one `INSERT … SELECT … ON CONFLICT`, using the same key and the same
guard.

### 7. Connections

`PG_POOL_MAX × replicas` must be less than or equal to the pooler's
`default_pool_size`. The deployment scales to 6 replicas with `PG_POOL_MAX` 20,
so the pooler needs 120. The database has `max_connections` 300 with ~150 free,
so the headroom exists. This is deployment configuration, not code.

## Measured result

Round trips per request, counted by wrapping `query` on the pg pool and client
prototypes — so this is what the application actually issued, not what the code
appears to do:

```
  1 session  ×  20 chunks =     28 rows → 21 statements   (first call warms the schema)
  5 sessions ×  20 chunks =    140 rows → 15 statements
 50 sessions ×  20 chunks =  1,400 rows → 15 statements
 50 sessions × 200 chunks = 10,400 rows → 17 statements
```

Flat in the number of sessions and in the number of rows. The two extra at
10,400 rows are `bulkInsert` splitting one table's rows across the bound-parameter
limit, which is §6. Before this change a 50-session batch issued roughly 850.

One transaction per request, not one per table.

## Acceptance criteria

Each is independently checkable.

1. **Statement count.** A batch of N sessions issues a fixed number of
   statements, for every N. Verified by wrapping `query` on the pg pool and
   client prototypes and counting round trips against a real Postgres — not by
   reading the code, which is how seven separate transactions went unnoticed.
2. **Unchanged rows are not written.** Syncing the same batch twice leaves every
   row's `ctid` — its physical location — where it was. NOT
   `pg_stat_user_tables`: those counters are flushed per backend, and the backend
   doing the writing is not the one doing the reading, so a test reads zeroes and
   passes whatever the code does. `ctid` moves exactly when a row is rewritten.
3. **Changed rows are written.** A session that gains one turn updates exactly
   the rows that differ, and the count of updated chunk rows is the number of
   new chunks, not the session's whole chunk set.
4. **Re-import does not duplicate.** Importing the same triples twice inserts 0
   the second time, matching `importTriple`'s existing behaviour, including for
   triples whose `valid_to` is set.
5. **Supersede still works with the index in place.** Recording a decision that
   contradicts a live one expires the old row and inserts the new one, with the
   reproduction above (`row A` expired at the same date the supersede uses) as a
   test case.
6. **Deadlock freedom.** Two concurrent batches carrying overlapping sessions
   both complete.
7. **No behaviour change in the response.** The counts the route returns
   (`uploaded`, `items`, `chunks`, `kgTriples`, …) match what the per-row
   implementation returned for the same input.

## Out of scope

- The client-side ledger and its delta detection are unchanged.
- `raw_sessions` bytes already live in object storage; that path is untouched.
- The metrics backlog query holding pooler connections is a separate defect with
  its own fix (one replica computes under an advisory lock).
