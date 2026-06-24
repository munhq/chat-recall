/**
 * Version of the session-extraction logic — the code that turns a raw
 * transcript (main .jsonl + any subagents/) into chunks, summaries,
 * metadata, and the derived rows (diff / commits / markers / outcome).
 *
 * This is the freshness dimension that file mtime CANNOT capture: when the
 * extraction code changes, every previously-synced row is potentially wrong
 * even though the source transcript is byte-for-byte unchanged. The sync
 * ledger records the version each session was synced under and re-pushes any
 * session whose recorded version is older than this constant — so an
 * extraction fix self-heals on the next `chat-recall sync`, with no manual
 * ledger surgery and no blanket --full backfill.
 *
 * BUMP THIS whenever you change what the parser/replay extracts:
 *   - parseSessionFile / readEvents file-set or field handling
 *   - replaySession / getCommits / computeOutcome / markers logic
 *   - chunking or metadata extraction that alters synced output
 *
 * History:
 *   1 — implicit original (pre-versioning).
 *   2 — include the main transcript alongside subagents/ in both
 *       parseSessionFile and resolveSessionContentPaths. Sessions that
 *       spawned sub-agents previously dropped their entire main thread
 *       (all Edit/Write/Bash work) from chunks, summaries, and diffs.
 */
export const EXTRACTOR_VERSION = 2;

// Per-FIELD versions (native title, …) used to live here. They now live with
// each field in the derived-field registry (core/sync-fields.ts), so adding or
// re-versioning a field is one local edit and the sync/ledger stay generic.
// A field re-scan pushes only that field — it never re-pushes conversations.
