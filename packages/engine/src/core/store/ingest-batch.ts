/**
 * One ingest request's writes, as data.
 *
 * ── Why this type exists ────────────────────────────────────────────────────
 *
 * The ingest handler used to call the store once per row. Batching it by adding
 * a `*Many` method per table replaced 850 statements with 8 — and left seven
 * near-identical methods on the driver, each with its own de-dupe, its own sort,
 * and its own transaction. Seven transactions per request is not one write: the
 * connection is taken and released seven times, and a failure halfway leaves the
 * tables disagreeing with each other.
 *
 * So the batch is a value. The handler fills it in as it walks the conversations
 * and hands it over once; `writeIngestBatch` owns the order, the de-duping, the
 * lock ordering and the single transaction. See docs/SYNC-BATCH-WRITES.md §4.
 *
 * Every field is optional and an absent one is not written at all — a request
 * carrying only tombstones touches nothing else.
 */
import type { MemoryItem, MemoryChunk, MemoryLink } from '../../types/memory.js';
import type { MetadataCache } from '../metadata-cache.js';

/**
 * A session-metadata row, as the metadata cache defines it.
 *
 * Derived, not restated: a hand-copied version of this type missed the `ai`
 * summary source and rejected a row the cache accepts.
 */
export type IngestSessionMeta = Parameters<MetadataCache['set']>[0];

/** One derived computation (diff / outcome / commits / markers) for a session. */
export interface IngestCompute {
  sessionId: string;
  kind: string;
  mtime: number;
  data: unknown;
}

/** The client-owned secret findings for one session, replacing what is stored. */
export interface IngestFindings {
  sessionId: string;
  findings: Array<{ detector: string; rule: string; line: number; preview: string; verified?: boolean }>;
}

export interface IngestBatch {
  /** Metadata rows. Clears each session's cached summary, so it runs first. */
  items?: MemoryItem[];
  /** The COMPLETE chunk set for each item named. Anything missing is deleted. */
  chunks?: MemoryChunk[];
  /** Tail chunks only — appended, never replacing the head's. */
  appendChunks?: MemoryChunk[];
  cachedContent?: Array<{ id: string; sourceType: string; mtime: number; content: string }>;
  sessionMeta?: IngestSessionMeta[];
  /** Appended sessions: move mtime, leave head-derived columns alone. */
  touchMtime?: Array<{ sessionId: string; mtime: number }>;
  compute?: IngestCompute[];
  findings?: IngestFindings[];
  links?: MemoryLink[];
}

/**
 * What the write actually did, for the counts the ingest reports back.
 *
 * `computeOffered` is the number of compute rows the batch asked to store,
 * after the markers shrink guard refused any. It is deliberately NOT a count of
 * rows the database changed: a row whose payload already matches is skipped by
 * the guard on DO UPDATE, and the ingest has always reported what it offered.
 */
export interface IngestCounts {
  chunks: number;
  findings: number;
  computeOffered: number;
}

/**
 * The metadata-cache writes an ingest batch carries.
 *
 * session_metadata and compute_cache belong to the metadata cache. In Postgres
 * that is the same database as everything else, so the batch writer handles
 * them itself. In SQLite it is a separate file, so that driver is handed the
 * cache to write them through — hence a collaborator rather than an assumption.
 */
export interface IngestMetaWriter {
  setMany(rows: IngestSessionMeta[]): Promise<void>;
  setComputeMany(rows: IngestCompute[]): Promise<number>;
}

/** Nothing to write — used to skip opening a transaction at all. */
export function isEmptyBatch(b: IngestBatch): boolean {
  return !b.items?.length && !b.chunks?.length && !b.appendChunks?.length
    && !b.cachedContent?.length && !b.sessionMeta?.length && !b.touchMtime?.length
    && !b.compute?.length && !b.findings?.length && !b.links?.length;
}
