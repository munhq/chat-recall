/**
 * Bounded, paged listItems — the one way server routes bulk-read store rows.
 *
 * Several endpoints used to call `store.listItems(type, 10_000..100_000, 0)`
 * and materialize the whole result set in one driver round-trip. On a large
 * tenant that's an unbounded single allocation (and a giant query result to
 * deserialize at once). This helper pages in fixed-size chunks so peak driver
 * memory stays flat, enforces a hard cap, and warns once when the cap
 * truncates the scan — so "analytics silently missing sessions" is visible in
 * the logs instead of a mystery.
 *
 * Note the returned array still holds up to `cap` rows (callers aggregate over
 * them); the cap is what bounds total memory, the paging is what bounds the
 * per-query transfer.
 */
import { createLogger } from '@chat-recall/engine/core/logger.js';
import type { SourceType, MemoryMetadataRow } from '../imports.js';

const log = createLogger('paged-items');

/** Minimal structural view of the store — keeps the helper testable and
 *  independent of which StorageDriver backs `createStore()`. */
export interface ListItemsStore {
  listItems(
    sourceType: SourceType,
    limit?: number,
    offset?: number,
  ): Promise<MemoryMetadataRow[]> | MemoryMetadataRow[];
}

export interface ListItemsPagedOpts {
  /** Hard upper bound on total rows returned. */
  cap: number;
  /** Rows per driver round-trip. Default 1000. */
  pageSize?: number;
  /** Label used in the truncation warning (e.g. 'analytics'). */
  context?: string;
}

/**
 * Page through `store.listItems(type, …)` in `pageSize` chunks up to `cap`
 * rows. listItems orders by mtime DESC, so a truncated scan keeps the newest
 * rows — the right bias for every current caller (analytics, matrix, diary).
 * Logs a single warn per call when the cap truncated the result.
 */
export async function listItemsPaged(
  store: ListItemsStore,
  type: SourceType,
  { cap, pageSize = 1000, context }: ListItemsPagedOpts,
): Promise<MemoryMetadataRow[]> {
  const out: MemoryMetadataRow[] = [];
  let offset = 0;
  while (out.length < cap) {
    const want = Math.min(pageSize, cap - out.length);
    const page = await store.listItems(type, want, offset);
    out.push(...page);
    offset += page.length;
    if (page.length < want) return out; // drained the table — under the cap
  }
  // Cap reached with every page full so far — check whether rows remain.
  const probe = await store.listItems(type, 1, offset);
  if (probe.length > 0) {
    log.warn(
      { type, cap, context: context ?? null },
      'listItems scan truncated at cap — results are incomplete for this tenant',
    );
  }
  return out;
}
