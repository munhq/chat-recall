# Sync architecture — READ THIS BEFORE TOUCHING SYNC

The client is a **thin collector**: it reads the AI tools' transcripts off disk,
redacts, and ships rows to the server over HTTP. The server stores/indexes
everything. There is **no local index** on the client.

## ONE writer. One mechanism. One lock.

There is exactly **one** background sync path and it must stay that way:

- **`syncIncremental()`** (`sync-client.ts`) is THE entrypoint. It acquires the
  cross-platform **index lock** (`acquireIndexLock`, an O_EXCL lockfile that
  works on Linux/macOS/Windows) for the whole run. If it can't get the lock,
  another writer is active → it **returns null and skips this tick**. This is
  what makes concurrent writers safe: only one process touches the sync ledger
  at a time, ever.
- It is driven by the **MCP background sync** (`mcp.ts startBackgroundSync`):
  every Claude-spawned MCP process ticks every 3 min. Claude Code spawns the MCP
  on every OS, so this is the cross-platform, **zero-install** writer — "the
  binary IS the daemon."

### DO NOT add a second UNLOCKED writer.
The standalone **`chat-recall-watch` systemd/launchd/schtasks service**
(`auto-indexer/indexer.ts`) still ships, and `chat-recall watch
--install-service` installs it for a headless box with no assistant running.
It is safe now for one reason only: it reaches the ledger through
`syncIncremental()`, under the same index lock. Before that lock existed the two
writers raced the lock-free ledger and clobbered each other — oscillating
coverage and a 100% CPU re-scan loop.

What changed is the DEFAULT, not the daemon: `chat-recall init` no longer
installs the service, because the MCP process already ticks every 3 minutes on
every OS. The daemon is opt-in.

If you add another file-watcher, it MUST go through `syncIncremental()`. Never
write the ledger from an unlocked path.

Any new caller that writes the sync ledger MUST hold the index lock.

## Incremental model — by mtime + version, NOT by hash

A session is re-synced only when **its file mtime advances** OR the
**`EXTRACTOR_VERSION`** bumps. The per-server ledger (`sync-ledger.json`) records
`{ m: mtime, v: extractorVersion }` per session; the gate is
`ack.m >= file.mtime && ack.v >= EXTRACTOR_VERSION`. There is **no content
hashing** in the sync path (the only `createHash` is `hashPath`, which privacy-
hashes project *paths*, unrelated).

## Adding a field (e.g. a session name) — sync ONLY the missing data

**Never** bump `EXTRACTOR_VERSION` to add a small derived field — that re-pushes
every whole conversation (chunks, envelope, derived compute, multi-MB uploads).
Instead use the **derived-field framework**:

1. Register the field in **`engine/core/sync-fields.ts`**:
   `{ name, version, mtimeSensitive, scan(ref) -> value | null }`.
2. Add its server-side setter to **`FIELD_SETTERS`** in `routes/sync.ts`.

Reconciliation (`reconcileFieldsForTarget`, runs inside every `syncIncremental`,
BEFORE the heavy conversation walk) then:
- scans **only** sessions whose per-`(session, field)` coverage is missing/stale,
- pushes **only** `{ session_id, field, value }` (never a conversation),
- records coverage in the ledger: **present** or **absent**. An **absent** field
  is never re-scanned (no retries) until the field's `version` bumps or a re-scan
  is forced (`forceFieldRescan`, the UI "re-scan" hook).

The ledger's per-`(session,field)` coverage map is `f`. **Any code that writes a
session's ledger entry (e.g. `markSynced`) MUST preserve `f`** — overwriting it
makes reconciliation re-scan everything. There are regression tests for this in
`sync-ledger.test.ts`; keep them green.

## The lock is the invariant
If you remember one thing: **all ledger writes happen under `acquireIndexLock`,
through `syncIncremental`. One writer. mtime+version for conversations,
per-field coverage for fields. No second daemon.**

## When the server is at its limit: 413 and 429
The append route holds memory while it parses one body. Two bounds protect the
API pod, so a slow client cannot take the pod down and turn every other sync
into a Cloudflare 502:

1. **Size.** A body larger than `CHAT_RECALL_INGEST_MAX_BODY_BYTES` (default
   16 MiB, decompressed) gets `413` with `{"code":"body_too_large"}`.
2. **Concurrency.** At most `CHAT_RECALL_INGEST_MAX_INFLIGHT` appends (default
   `2`) and at most `CHAT_RECALL_INGEST_MAX_INFLIGHT_BYTES` in total (default
   8 MiB) may run at the same time. Above the cap the route answers
   `429` with `{"code":"ingest_busy"}` and `Retry-After: 2`. One body larger
   than the byte budget runs alone, so two large bodies never overlap.

The collector treats both answers as a request to wait, not as a fault:

- it waits for `Retry-After` (or a short back-off), then sends the same batch
  again;
- it does NOT add the target to the failure cooldown, and it does NOT advance
  the consecutive-failure counter. A 429 or a 413 is the server asking for a
  pause; counting it would silence a healthy collector exactly while the server
  recovers.

## When a session is tombstoned
The server keeps a tombstone for a session and refuses the session afterwards.
On 2026-11-12 one walk sent 11,977 tombstones for sessions that were on disk,
because the walk did not list them, and the server stored 479 of 12,199 sessions
afterwards.

After a complete walk the collector takes each ledger session that the walk did
not visit and asks the backend that owns it (`getBackendForId`) for the source:

- the backend finds the source: nothing is sent;
- the backend is available and finds no source: the session is a candidate;
- no backend owns the id, the backend is not available (a folder that is not
  mounted, a database that cannot be read) or the lookup throws: nothing is sent.

A batch of more than 50 candidates that is also more than 5% of the ledger is not
sent. `CHAT_RECALL_TOMBSTONES` picks what happens to the rest: `report` (the
default) logs the count and the first five ids, `act` sends the tombstones and
`off` does nothing. The rule is in `packages/cli/src/tombstone-rule.ts`.

A walk is also bounded by count: `CHAT_RECALL_SYNC_WALK_MAX` (default `2000`)
sessions per walk, with unacked sessions first. A restart reads
`~/.chat-recall/walk-state.json`: when the last successful walk is younger than
six hours, the startup walk covers only changed sessions.
