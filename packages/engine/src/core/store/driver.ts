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
/**
 * `rejected` is the human verdict: not a real problem, stop showing it. `done`
 * is the machine's: the work happened and can be checked. A person can reject a
 * card; a person cannot declare one done, because "done" here claims a code
 * change exists. `blocked` stays only so rows written before this still load —
 * nothing writes it.
 */
/**
 * `done` is EARNED — the API refuses it without the session that did the work.
 * `closed` is the honest alternative for a card that stopped being relevant:
 * its finding is no longer reported, or it duplicates another card. `rejected`
 * stays the human verdict "this is not a real problem".
 */
/**
 * What the closer offers as proof of the fix, scoped to the card's own project.
 * `commits` are the checkable half — a sha exists or it does not.
 */
export interface DoneEvidence {
  /**
   * THE CHANGE ITSELF, as a unified diff, recorded by whoever closed the card.
   *
   * This is the evidence. Everything else on this object describes it. The first
   * design required commits and re-derived the diff from the session's Edit/Write
   * records or a git scan — and both are blind to an agent that edits through a
   * shell or works in a repository the session never tool-touched, which is most
   * of them. The closer knows exactly what it changed; asking it is not only
   * simpler, it is the only source that is always right.
   */
  diff?: string;
  /** The commits carrying that change, if it was committed. */
  commits?: string[];
  files?: string[];
  /** Free text: what changed, in one line. */
  summary?: string;
}

export type TeamTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'rejected' | 'closed';
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
  /** The finding/code-action this card was auto-materialized from, or null. */
  linkedFindingId: string | null;
  /**
   * The finding's IDENTITY, which survives its id changing. Null on cards filed
   * before this existed, and on anything a person created.
   *
   * linkedFindingId is a hash over data that moves, so its absence from the open
   * set means either "fixed" or "renamed" and the close sweep could not tell
   * which. It guessed fixed, 93 times out of 97, while every finding was open.
   */
  linkedFindingIdentity: string | null;
  /** Why a `closed` card was closed. Required when closing; null otherwise. */
  closedReason: string | null;
  /** What proves a `done` card was done: commits, and the files they touched. */
  doneEvidence: DoneEvidence | null;
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
  linkedFindingId?: string | null;
  linkedFindingIdentity?: string | null;
}
export interface UpdateTeamTaskPatch {
  title?: string;
  description?: string;
  status?: TeamTaskStatus;
  assigneeSub?: string | null;
  due?: number | null;
  blocks?: string[];
  blockedBy?: string[];
  linkedSessionId?: string | null;
  linkedFindingId?: string | null;
  linkedFindingIdentity?: string | null;
  /** Why the card was closed. The API requires it when status becomes 'closed'. */
  closedReason?: string | null;
  /** Proof for a `done`. The API requires at least one commit with it. */
  doneEvidence?: DoneEvidence | null;
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
  /** Cards materialized from findings — the auto-task dedup + auto-close set.
   *  Empty `ids` returns every finding-linked card (for the close sweep). */
  teamTasksByFindingIds(ids?: string[]): Promise<TeamTask[]>;

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
  approxStoredBytes: AsyncMethod<MemoryStore['approxStoredBytes']>;

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
  /** Findings by exact id. Needed because listCodeFindings is CAPPED, and a
   *  capped list cannot answer "does this card's finding still exist" — beyond
   *  the cap every finding looks deleted. */
  codeFindingsByIds: AsyncMethod<MemoryStore['codeFindingsByIds']>;
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
