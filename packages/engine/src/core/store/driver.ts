/**
 * StorageDriver — the async storage contract the whole app talks to.
 *
 * Why this exists: `MemoryStore` is hard-wired to synchronous better-sqlite3.
 * To let `storage: sqlite | postgres` be a config flag (solo-local vs
 * team/cloud), every store call must be `await`-able so a Postgres driver
 * (node-postgres, inherently async) can satisfy the same interface.
 *
 * The interface is *derived* from `MemoryStore`'s public method types — each
 * method keeps its exact parameters and return type, just wrapped in a Promise.
 * That keeps this file DRY and impossible to drift from the SQLite source of
 * truth: change a signature on MemoryStore and this interface follows.
 *
 * Implementations:
 *   - SqliteStore (store/sqlite.ts) — wraps the existing MemoryStore. Default.
 *   - PgStore     (store/pg.ts)     — Postgres + pgvector. Team / cloud.
 */

import type { MemoryStore } from '../memory-store.js';

/** Any method → the same method returning a Promise of its (awaited) result. */
type AsyncMethod<M> = M extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

/**
 * Async mirror of MemoryStore's public surface. Listed explicitly (not a
 * mapped type over `keyof MemoryStore`) so private fields/methods don't leak
 * into the contract and break `implements` on the Postgres side.
 */
export interface StorageDriver {
  // ── metadata / items ──
  setItem: AsyncMethod<MemoryStore['setItem']>;
  setItems: AsyncMethod<MemoryStore['setItems']>;
  getItem: AsyncMethod<MemoryStore['getItem']>;
  needsUpdate: AsyncMethod<MemoryStore['needsUpdate']>;
  listItems: AsyncMethod<MemoryStore['listItems']>;
  listItemsByProject: AsyncMethod<MemoryStore['listItemsByProject']>;
  listItemsByProjectId: AsyncMethod<MemoryStore['listItemsByProjectId']>;
  listAllProjectIdPaths: AsyncMethod<MemoryStore['listAllProjectIdPaths']>;
  listProjectsSummary: AsyncMethod<MemoryStore['listProjectsSummary']>;
  listAllSessionsForPrecompute: AsyncMethod<MemoryStore['listAllSessionsForPrecompute']>;
  listAllSessionProjectPaths: AsyncMethod<MemoryStore['listAllSessionProjectPaths']>;
  listSessionsModifiedSince: AsyncMethod<MemoryStore['listSessionsModifiedSince']>;
  listAllSessionPaths: AsyncMethod<MemoryStore['listAllSessionPaths']>;
  querySessionIndex: AsyncMethod<MemoryStore['querySessionIndex']>;
  getStats: AsyncMethod<MemoryStore['getStats']>;
  clearSourceType: AsyncMethod<MemoryStore['clearSourceType']>;
  deleteItem: AsyncMethod<MemoryStore['deleteItem']>;
  updateItemProjectPath: AsyncMethod<MemoryStore['updateItemProjectPath']>;

  // ── links ──
  addLink: AsyncMethod<MemoryStore['addLink']>;
  addLinks: AsyncMethod<MemoryStore['addLinks']>;
  getLinksFrom: AsyncMethod<MemoryStore['getLinksFrom']>;
  getLinksTo: AsyncMethod<MemoryStore['getLinksTo']>;
  getAllLinks: AsyncMethod<MemoryStore['getAllLinks']>;
  getLinkCount: AsyncMethod<MemoryStore['getLinkCount']>;

  // ── content cache ──
  getCachedContent: AsyncMethod<MemoryStore['getCachedContent']>;
  getCachedContentStale: AsyncMethod<MemoryStore['getCachedContentStale']>;
  setCachedContent: AsyncMethod<MemoryStore['setCachedContent']>;

  // ── secret findings (security dashboard) ──
  secretFindingsSummary: AsyncMethod<MemoryStore['secretFindingsSummary']>;
  secretFindingsBySession: AsyncMethod<MemoryStore['secretFindingsBySession']>;
  secretFindingsByProject: AsyncMethod<MemoryStore['secretFindingsByProject']>;
  secretFindingsTrend: AsyncMethod<MemoryStore['secretFindingsTrend']>;
  secretFindingsByRule: AsyncMethod<MemoryStore['secretFindingsByRule']>;
  secretFindingsByDistinctSecret: AsyncMethod<MemoryStore['secretFindingsByDistinctSecret']>;
  secretCrossSessionCount: AsyncMethod<MemoryStore['secretCrossSessionCount']>;
  secretFindingsForSession: AsyncMethod<MemoryStore['secretFindingsForSession']>;

  // ── secret findings writer (scanner) ──
  ensureSecretFindingsTable: AsyncMethod<MemoryStore['ensureSecretFindingsTable']>;
  replaceSecretFindings: AsyncMethod<MemoryStore['replaceSecretFindings']>;

  // ── secret rules + dismissals ──
  ensureSecretRulesTable: AsyncMethod<MemoryStore['ensureSecretRulesTable']>;
  listSecretRules: AsyncMethod<MemoryStore['listSecretRules']>;
  upsertSecretRule: AsyncMethod<MemoryStore['upsertSecretRule']>;
  deleteSecretRule: AsyncMethod<MemoryStore['deleteSecretRule']>;
  ensureSecretDismissalsTable: AsyncMethod<MemoryStore['ensureSecretDismissalsTable']>;
  setSecretDismissal: AsyncMethod<MemoryStore['setSecretDismissal']>;
  clearSecretDismissal: AsyncMethod<MemoryStore['clearSecretDismissal']>;
  getSecretDismissals: AsyncMethod<MemoryStore['getSecretDismissals']>;

  // ── FTS5 full-text search ──
  addChunksFTS: AsyncMethod<MemoryStore['addChunksFTS']>;
  appendChunksFTS: AsyncMethod<MemoryStore['appendChunksFTS']>;
  maxSyncChunkIndex: AsyncMethod<MemoryStore['maxSyncChunkIndex']>;
  touchSessionMtime: AsyncMethod<MemoryStore['touchSessionMtime']>;
  listChunksByItem: AsyncMethod<MemoryStore['listChunksByItem']>;
  pruneEmptySessions: AsyncMethod<MemoryStore['pruneEmptySessions']>;
  deleteItemFTS: AsyncMethod<MemoryStore['deleteItemFTS']>;
  rebuildFTS: AsyncMethod<MemoryStore['rebuildFTS']>;
  clearFTS: AsyncMethod<MemoryStore['clearFTS']>;
  searchFTS: AsyncMethod<MemoryStore['searchFTS']>;
  getFTSCount: AsyncMethod<MemoryStore['getFTSCount']>;
  countDistinctItemsMatching: AsyncMethod<MemoryStore['countDistinctItemsMatching']>;

  // ── tombstones / purge ──
  addTombstone: AsyncMethod<MemoryStore['addTombstone']>;
  listTombstones: AsyncMethod<MemoryStore['listTombstones']>;
  purgeSession: AsyncMethod<MemoryStore['purgeSession']>;

  // ── raw session archive ──
  putRawSession: AsyncMethod<MemoryStore['putRawSession']>;
  getRawSession: AsyncMethod<MemoryStore['getRawSession']>;
  listRawSessionVersions: AsyncMethod<MemoryStore['listRawSessionVersions']>;

  // ── KV store ──
  kvSet: AsyncMethod<MemoryStore['kvSet']>;
  kvGet: AsyncMethod<MemoryStore['kvGet']>;
  kvDelete: AsyncMethod<MemoryStore['kvDelete']>;
  kvList: AsyncMethod<MemoryStore['kvList']>;

  // ── cross-tool sync intents (Model B queue) ──
  enqueueSyncIntent: AsyncMethod<MemoryStore['enqueueSyncIntent']>;
  listPendingSyncIntents: AsyncMethod<MemoryStore['listPendingSyncIntents']>;
  ackSyncIntent: AsyncMethod<MemoryStore['ackSyncIntent']>;
  listSyncIntents: AsyncMethod<MemoryStore['listSyncIntents']>;

  // ── code intelligence (codeindex merge) ──
  upsertCodeProject: AsyncMethod<MemoryStore['upsertCodeProject']>;
  getCodeProject: AsyncMethod<MemoryStore['getCodeProject']>;
  listCodeProjects: AsyncMethod<MemoryStore['listCodeProjects']>;
  setCodeProjectLabel: AsyncMethod<MemoryStore['setCodeProjectLabel']>;
  replaceCodeFindings: AsyncMethod<MemoryStore['replaceCodeFindings']>;
  listCodeFindings: AsyncMethod<MemoryStore['listCodeFindings']>;
  codeFindingsSummary: AsyncMethod<MemoryStore['codeFindingsSummary']>;
  replaceCodeHotspots: AsyncMethod<MemoryStore['replaceCodeHotspots']>;
  listCodeHotspots: AsyncMethod<MemoryStore['listCodeHotspots']>;
  upsertCodeActions: AsyncMethod<MemoryStore['upsertCodeActions']>;
  listCodeActions: AsyncMethod<MemoryStore['listCodeActions']>;
  setCodeActionStatus: AsyncMethod<MemoryStore['setCodeActionStatus']>;

  // ── lifecycle ──
  close: AsyncMethod<MemoryStore['close']>;
}

export type StorageBackend = 'sqlite' | 'postgres';
