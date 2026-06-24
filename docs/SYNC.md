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

### DO NOT add a second writer.
The standalone **`chat-recall-watch` systemd/launchd/schtasks service**
(`auto-indexer/indexer.ts`) was a SECOND mechanism that also called
`syncIncremental()`. Two uncoordinated writers raced the lock-free ledger and
clobbered each other (oscillating coverage, 100% CPU re-scan loop). It is
**retired** — `chat-recall init` no longer installs it. If you reintroduce a
file-watcher, it MUST go through `syncIncremental()` (which now holds the lock);
never write the ledger from an unlocked path.

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
