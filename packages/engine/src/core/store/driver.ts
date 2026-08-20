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

// ── Collaborative tasks (Phase 3) ────────────────────────────────────────
export type TeamTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
export interface TeamTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TeamTaskStatus;
  assigneeSub: string | null;
  createdBy: string;
  blocks: string[];
  blockedBy: string[];
  linkedSessionId: string | null;
  due: number | null;
  createdAt: number;
  updatedAt: number;
}
export interface TeamTaskComment { id: string; taskId: string; authorSub: string; body: string; createdAt: number; }
export interface CreateTeamTaskInput {
  title: string;
  createdBy: string;
  projectId?: string;
  description?: string;
  assigneeSub?: string | null;
  due?: number | null;
  linkedSessionId?: string | null;
}
export interface UpdateTeamTaskPatch {
  title?: string;
  description?: string;
  status?: TeamTaskStatus;
  assigneeSub?: string | null;
  due?: number | null;
  blocks?: string[];
  blockedBy?: string[];
}

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

  /**
   * Per-(author, project) session-activity rollup for the team view (Phase 2).
   * RLS-scoped to what the current viewer may see (own + shared), so a member's
   * team activity naturally shows their own work plus teammates' work on
   * projects shared into the team — never a private project.
   */
  teamActivity(opts?: { projectId?: string; author?: string; sinceMs?: number; limit?: number }):
    Promise<Array<{ authorSub: string | null; projectId: string; sessions: number; lastMtime: number }>>;

  // ── Collaborative tasks (Phase 3). Team-visible within the tenant (RLS by
  //    tenant only — tasks ARE the collaboration surface, independent of the
  //    per-project content boundary). Cloud/Postgres only; the sqlite driver
  //    (single-user) throws on writes and returns empty on reads. ──
  createTeamTask(input: CreateTeamTaskInput): Promise<TeamTask>;
  listTeamTasks(opts?: { projectId?: string; assigneeSub?: string; status?: TeamTaskStatus }): Promise<TeamTask[]>;
  getTeamTask(id: string): Promise<{ task: TeamTask; comments: TeamTaskComment[] } | null>;
  updateTeamTask(id: string, patch: UpdateTeamTaskPatch): Promise<TeamTask | null>;
  addTeamTaskComment(taskId: string, authorSub: string, body: string): Promise<TeamTaskComment | null>;

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
  /** Sessions + newest activity per device (fleet health). Optional: only the
   *  pg driver implements it; the sqlite test driver has no fleet. */
  sessionCountsByDevice?: () => Promise<Array<{ device: string | null; sessions: number; lastIndexedAt: number }>>;
  secretFindingsTrend: AsyncMethod<MemoryStore['secretFindingsTrend']>;
  secretFindingsByRule: AsyncMethod<MemoryStore['secretFindingsByRule']>;
  secretFindingsByDistinctSecret: AsyncMethod<MemoryStore['secretFindingsByDistinctSecret']>;
  secretCrossSessionCount: AsyncMethod<MemoryStore['secretCrossSessionCount']>;
  secretFindingsForSession: AsyncMethod<MemoryStore['secretFindingsForSession']>;

  // ── secret findings writer (scanner) ──
  ensureSecretFindingsTable: AsyncMethod<MemoryStore['ensureSecretFindingsTable']>;
  replaceSecretFindings: AsyncMethod<MemoryStore['replaceSecretFindings']>;
  addSecretFindings: AsyncMethod<MemoryStore['addSecretFindings']>;

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
  topImportantChunks: AsyncMethod<MemoryStore['topImportantChunks']>;
  countItemChunks: AsyncMethod<MemoryStore['countItemChunks']>;
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
  listEnvelopesMissingRawArchive: AsyncMethod<MemoryStore['listEnvelopesMissingRawArchive']>;

  // ── KV store ──
  kvSet: AsyncMethod<MemoryStore['kvSet']>;
  kvGet: AsyncMethod<MemoryStore['kvGet']>;
  kvDelete: AsyncMethod<MemoryStore['kvDelete']>;
  kvList: AsyncMethod<MemoryStore['kvList']>;

  // ── cross-tool sync intents (Model B queue) ──
  enqueueSyncIntent: AsyncMethod<MemoryStore['enqueueSyncIntent']>;
  listPendingSyncIntents: AsyncMethod<MemoryStore['listPendingSyncIntents']>;
  listAllPendingSyncIntents: AsyncMethod<MemoryStore['listAllPendingSyncIntents']>;
  ackSyncIntent: AsyncMethod<MemoryStore['ackSyncIntent']>;
  listSyncIntents: AsyncMethod<MemoryStore['listSyncIntents']>;

  // ── code intelligence (codeindex merge) ──
  upsertCodeProject: AsyncMethod<MemoryStore['upsertCodeProject']>;
  getCodeProject: AsyncMethod<MemoryStore['getCodeProject']>;
  listCodeProjects: AsyncMethod<MemoryStore['listCodeProjects']>;
  setCodeProjectLabel: AsyncMethod<MemoryStore['setCodeProjectLabel']>;
  deleteCodeProject: AsyncMethod<MemoryStore['deleteCodeProject']>;
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
