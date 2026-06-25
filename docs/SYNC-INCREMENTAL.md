# Incremental tail-only conversation sync

> ✅ **ENABLED (default on; `CHAT_RECALL_TAIL_APPEND=0` is the emergency off).**
> The first cut corrupted actively-growing sessions: it merged the tail into the
> server's stored base but couldn't detect a *truncated* base (the
> `full_resync_needed` handshake only fired on an EMPTY envelope), so a 1079-msg
> session was stored as 65. **Fixed by an OFFSET-CONTINUITY GUARD:** the server
> records the byte offset its envelope is synced *through* (`o` in the content_cache
> envelope), and an append merges ONLY when its `base_offset` equals that `o` —
> otherwise it returns `full_resync_needed` and the client falls back to FULL. A
> truncated/stale/re-ordered base no longer matches, so it can never be silently
> extended. The full-sync ledger offset and the server's stored `o` use the SAME
> value (`conv.from_offset` = build-time file size) so an active session's appends
> match exactly. Tested: `sync.test.ts` CONTINUITY GUARD (mismatch → full, match →
> merge) + `sync-ledger.test.ts` syncMode branches.


## Problem
A growing active session re-processes its WHOLE transcript every sync tick:
parse whole file → redact whole envelope → gzip whole raw_b64 → replay whole
session for diff/outcome/markers → re-scan whole raw text for secrets. As a
session grows to N messages this is O(N) per tick → O(N²) total. The ledger
correctly skips UNCHANGED sessions; the cost is concentrated in the ONE active
session whose mtime advances every tick.

## Goal
On an append-only transcript that grew since last sync, ship ONLY the new tail.
O(new bytes) per tick, not O(whole file).

---

## Design

### 1. Ledger — track byte offset

`SyncedRow` gains two fields (sync-ledger.ts):
- `o: number` — last byte offset shipped (0 = none / full needed)
- `s: number` — file size at ship time

Freshness gate (willBuild):
- unchanged: `ack.m >= mtime && ack.v >= EXTRACTOR_VERSION && ack.o >= fileSize`
  → skip
- append-eligible: `ack.v >= EXTRACTOR_VERSION && fileSize > ack.s && ack.o > 0`
  → APPEND sync from offset `ack.o`
- everything else (version bump, file shrank, first sync, OpenCode) → FULL sync

### 2. ToolBackend — append-only capability

New optional methods on the backend interface (tool-backend.ts):
- `isAppendOnly(): boolean` — true for Claude/Gemini/Codex (JSONL files); false
  for OpenCode (SQLite, no byte offset).
- `readFromOffset(prefixedId, offset): Promise<{ text: string; newOffset: number }>`
  — reads file bytes from `offset` to EOF and returns the tail text + new offset.
  **`newOffset` is the byte position of the LAST newline in the read window, NOT
  EOF.** A sync tick can fire mid-write while the AI tool has flushed only part
  of a trailing JSONL line; advancing to EOF would resume next tick inside that
  torn line → permanent misalignment + parse failures forever. Snapping to the
  last `\n` means the partial trailing line is simply re-read (and completed) on
  the next tick. If the window contains no newline (offset already past the last
  complete line), return `text: ''` and `newOffset: offset` — nothing to ship
  this tick. Only implemented by append-only backends.

### 3. Client — tail builder

New `buildConversationTail(ref, fromOffset)` (sync-client.ts):
- `backend.readFromOffset()` → tail text (raw JSONL lines) + new offset
- Parse tail lines through the SAME per-tool line parser
  (`parseClaudeTranscriptText` / `parseGeminiTranscriptText` / etc.) — reuse the
  existing text parser, no new parsing logic
- `trimTranscriptForSync` + `redactDeep` on the tail envelope only
- Ship with `append: true` + `from_offset` (the new offset to persist on ack).
  **No `chunk_index_start`** — the client does NOT number chunks. Sessions ship
  `redacted_text` + `envelope`; the SERVER builds chunks (`chunksFromTurns`,
  sync.ts) and owns their numbering. The client cannot predict the server's
  chunk count: chunking filters to text-only turns and splits on `MAX_CHARS`,
  so a client-side counter would drift and collide. The server assigns the
  starting index on append (see §4).
- **Skip raw_b64** — server already has the prior archive; only re-ship on FULL
- **Skip whole-session telemetry meta** (tokens/cost/peakContext/duration/
  models/tools). It comes from `parseSessionFile` over the ENTIRE file
  (buildConversationSync, sync-client.ts) — itself O(N), so re-running it on
  every tick would defeat the goal. Append ships only `messageCount` (cheap,
  derivable from the tail count + prior count) and the `oneShot` flag stays
  whatever the head set. Consequence: the active session's token/cost/context
  numbers are STALE between append ticks; they refresh on the FULL re-sync that
  fires when the session goes quiet. This is an explicit, accepted tradeoff —
  see §5. (Future: make telemetry incrementally accumulable — tokens additive,
  peak = max, models/tools = union — and ship a telemetry delta on append. Out
  of scope here.)
- **Preserve head-derived metadata.** `title` / `first_prompt` / `contentPreview`
  derive from the FIRST user message, which lives in the head, not the tail. The
  append payload MUST NOT carry these — the server keeps the values it already
  stored (see §4). The tail has no first user message; recomputing would clobber
  the title with an empty/wrong value.
- **Skip derived (diff/outcome/commits/markers)** on append ticks — these are
  whole-session computations; defer to the FULL re-sync that fires when the
  session goes quiet (mtime stops advancing) or on extractor version bump.
  Markers for new prompts can ship as a cheap append if wanted (TBD).
- Secret scan: scan only the tail text (builtin regex + tenant rules — cheap,
  in-memory). External detectors (gitleaks/trufflehog) skip append ticks —
  they already scanned the head; a full re-sync covers the whole file when the
  session closes.

### 4. Server — append path

`POST /api/sync` honors `append: true` on a conversation (sync.ts):
- Read existing envelope from `content_cache` (`getCachedContent`).
- If missing (data loss, first sync, server rotation) → respond
  `{ full_resync_needed: true }`; client falls back to FULL for this session.
- Build envelope messages from the tail (`envelopeFromTurns` over the tail
  turns), continuing `line` numbers from the stored envelope's last line, and
  append to the stored `messages[]`; write back via `setCachedContent`.
- **Server owns chunk numbering.** Chunk the tail's text turns with the SAME
  `chunksFromTurns`, but start `i` at `(MAX existing :sync: index for this
  session) + 1` — a single query, not a client-supplied counter. Insert via a
  NEW append-only store method (`appendChunksFTS`) that does the bulk INSERT
  WITHOUT the per-item DELETE that `addChunksFTS` performs (`pg.ts` deletes all
  of an item's chunks first — fine for FULL replace, fatal for append). ON
  CONFLICT (tenant,chunk_id) DO UPDATE keeps it idempotent on retry.
- **Update only mtime** on the metadata row. Do NOT overwrite `title` /
  `content_preview` (head-derived; the append payload omits them) and do NOT
  overwrite the telemetry `extra` keys (the append payload omits them; the head
  values stand until the next FULL re-sync). A targeted `touchSessionMtime` /
  partial update — not the full `setItem` upsert, which clobbers.
- `metaCache.set` (first-prompt cache) is also head-derived — skip on append.
- No raw_b64 expected on append; if present, ignore (server keeps prior).

FULL sync (append:false or absent) = current behavior (delete + insert, raw_b64,
derived, telemetry, title, the works).

### 5. Correctness guarantees

- **File rotated/truncated** (size < offset) → fall back to FULL. Detected by
  `fileSize < ack.o` in the freshness gate.
- **Extractor version bump** → FULL (existing ledger behavior; `ack.v <
  EXTRACTOR_VERSION` overrides append-eligibility).
- **Server lost prior envelope** → server requests full; client complies.
- **Compaction stitching** (Claude): a compact moves prior history into
  sidecars and the main JSONL keeps only the tail. The main file SHRINKS →
  `fileSize < ack.o` → FULL re-sync, which re-runs compaction stitching. Safe.
- **Cross-tick tool_result**: a `tool_use` in the prior tick whose
  `tool_result` lands in the new tail folds into the tail's preceding assistant
  message (the parser handles this per-message-pair). The prior tick's
  assistant message already shipped without the result — a FULL re-sync on
  session close fixes the seam. Acceptable: tool results are view-only, not
  search-indexed.
- **OpenCode** (SQLite): never append-eligible; always FULL. No regression.
- **Torn trailing line**: a tick firing mid-write reads a partial last JSONL
  line. `readFromOffset` returns `newOffset` at the last `\n`, so the partial
  line is excluded this tick and re-read whole next tick. No misalignment.
- **Stale telemetry on the active session**: tokens/cost/peakContext/duration
  lag between append ticks (telemetry is whole-file, deliberately skipped). They
  refresh on the FULL re-sync when the session goes quiet. Accepted tradeoff —
  the search/envelope content is current every tick; only the numeric badges lag
  for the one live session.
- **Chunk-id collision**: impossible — the server, not the client, assigns the
  starting index from `MAX(existing :sync: index)+1`, and inserts are
  ON CONFLICT idempotent. A retried append re-inserts the same ids harmlessly.

---

## Implementation order

1. **Ledger**: add `o`, `s` to `SyncedRow` + freshness gate logic. `markSynced`
   must persist `o`/`s` (preserving `f`, as it already preserves it today).
   Unit test the three branches (skip / append / full) in sync-ledger.test.ts.
2. **Backend**: `isAppendOnly()` + `readFromOffset()` on Claude/Gemini/Codex
   backends, with the last-newline snap. OpenCode returns `isAppendOnly: false`.
   Unit test: torn trailing line re-reads whole; no-newline window ships nothing.
3. **Store**: `appendChunksFTS()` (bulk insert, no per-item delete) + a
   `maxSyncChunkIndex(sessionId)` query + a partial mtime-only metadata update
   (`touchSessionMtime`). On both pg and sqlite drivers.
4. **Client**: `buildConversationTail()` (tail-only envelope, no telemetry, no
   title, no raw_b64) + wire the append branch into `syncToTarget`
   (append-eligible sessions use it; everything else unchanged). Persist the
   returned `o`/`s` only after the server acks (mirror `markSynced` timing).
5. **Server**: `append: true` handling in `/api/sync` — read+merge envelope,
   server-assigned chunk index, append-only insert, mtime-only metadata update,
   skip first-prompt cache + the `full_resync_needed` handshake when the prior
   envelope is gone.
6. **Tests**: end-to-end append sync (seed full → grow → append → verify chunk
   ids continue without collision, envelope messages merged, title + telemetry
   preserved from the head) in sync-client.test.ts + sync.test.ts. Plus the
   shrink→FULL and missing-envelope→full_resync_needed paths.

## What this does NOT change
- Non-session sources (plan/task/claude_md/…) — unchanged.
- Derived-field reconciliation (titles) — unchanged (already cheap, head-only).
- The lock, the single-writer model, the watch service — unchanged.

## Follow-up (not in this change)
- Incremental derived: resume replay from last offset instead of full replay.
  Deeper engine change; defer until the conversation-sync win lands and the
  backlog clears.
- Incremental telemetry: accumulate tokens (additive), peakContext (max), and
  models/tools (union) across append ticks and ship a telemetry delta, so the
  active session's badges stay live without re-parsing the whole file. Removes
  the only user-visible staleness this change introduces.
- Incremental KG: the append path does not extract knowledge-graph triples
  from the tail (the FULL path's `accumulateKg` is skipped on append ticks).
  Triples from new turns land on the FULL re-sync when the session goes quiet
  — eventually consistent, but the KG lags for active sessions like telemetry.