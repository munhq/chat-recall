/**
 * SqliteStore — the default StorageDriver. Wraps the existing synchronous
 * `MemoryStore` (better-sqlite3) and exposes every method as async, so the
 * same call sites work unchanged against SQLite (solo/local) or Postgres
 * (team/cloud) once they `await`.
 *
 * better-sqlite3 is synchronous by design (fast, single-process); wrapping
 * each call in `async` adds a microtask but no real latency. Behavior is
 * identical to MemoryStore — this is delegation, not a reimplementation.
 */

import { MemoryStore } from '../memory-store.js';
import type { StorageDriver } from './driver.js';

type Args<M extends keyof MemoryStore> = MemoryStore[M] extends (...a: infer A) => any ? A : never;

export class SqliteStore implements StorageDriver {
  /** The wrapped synchronous store. Exposed for the few SQLite-only call
   *  sites (e.g. backends that share the same db file) during migration. */
  readonly inner: MemoryStore;

  constructor(dbPath?: string) {
    this.inner = new MemoryStore(dbPath);
  }

  // ── metadata / items ──
  async setItem(...a: Args<'setItem'>) { return this.inner.setItem(...a); }
  async setItems(...a: Args<'setItems'>) { return this.inner.setItems(...a); }
  async getItem(...a: Args<'getItem'>) { return this.inner.getItem(...a); }
  async needsUpdate(...a: Args<'needsUpdate'>) { return this.inner.needsUpdate(...a); }
  async listItems(...a: Args<'listItems'>) { return this.inner.listItems(...a); }
  async listItemsByProject(...a: Args<'listItemsByProject'>) { return this.inner.listItemsByProject(...a); }
  async listItemsByProjectId(...a: Args<'listItemsByProjectId'>) { return this.inner.listItemsByProjectId(...a); }
  async listAllProjectIdPaths(...a: Args<'listAllProjectIdPaths'>) { return this.inner.listAllProjectIdPaths(...a); }
  async listProjectsSummary(...a: Args<'listProjectsSummary'>) { return this.inner.listProjectsSummary(...a); }
  async listAllSessionsForPrecompute(...a: Args<'listAllSessionsForPrecompute'>) { return this.inner.listAllSessionsForPrecompute(...a); }
  async listAllSessionProjectPaths(...a: Args<'listAllSessionProjectPaths'>) { return this.inner.listAllSessionProjectPaths(...a); }
  async listSessionsModifiedSince(...a: Args<'listSessionsModifiedSince'>) { return this.inner.listSessionsModifiedSince(...a); }
  async listAllSessionPaths(...a: Args<'listAllSessionPaths'>) { return this.inner.listAllSessionPaths(...a); }
  async querySessionIndex(...a: Args<'querySessionIndex'>) { return this.inner.querySessionIndex(...a); }
  async getStats(...a: Args<'getStats'>) { return this.inner.getStats(...a); }
  async clearSourceType(...a: Args<'clearSourceType'>) { return this.inner.clearSourceType(...a); }
  async deleteItem(...a: Args<'deleteItem'>) { return this.inner.deleteItem(...a); }
  async updateItemProjectPath(...a: Args<'updateItemProjectPath'>) { return this.inner.updateItemProjectPath(...a); }

  // ── links ──
  async addLink(...a: Args<'addLink'>) { return this.inner.addLink(...a); }
  async addLinks(...a: Args<'addLinks'>) { return this.inner.addLinks(...a); }
  async getLinksFrom(...a: Args<'getLinksFrom'>) { return this.inner.getLinksFrom(...a); }
  async getLinksTo(...a: Args<'getLinksTo'>) { return this.inner.getLinksTo(...a); }
  async getAllLinks(...a: Args<'getAllLinks'>) { return this.inner.getAllLinks(...a); }
  async getLinkCount(...a: Args<'getLinkCount'>) { return this.inner.getLinkCount(...a); }

  // ── content cache ──
  async getCachedContent(...a: Args<'getCachedContent'>) { return this.inner.getCachedContent(...a); }
  async getCachedContentStale(...a: Args<'getCachedContentStale'>) { return this.inner.getCachedContentStale(...a); }
  async setCachedContent(...a: Args<'setCachedContent'>) { return this.inner.setCachedContent(...a); }

  // ── secret findings ──
  async secretFindingsSummary(...a: Args<'secretFindingsSummary'>) { return this.inner.secretFindingsSummary(...a); }
  async secretFindingsBySession(...a: Args<'secretFindingsBySession'>) { return this.inner.secretFindingsBySession(...a); }
  async secretFindingsByProject(...a: Args<'secretFindingsByProject'>) { return this.inner.secretFindingsByProject(...a); }
  async secretFindingsTrend(...a: Args<'secretFindingsTrend'>) { return this.inner.secretFindingsTrend(...a); }
  async secretFindingsByRule(...a: Args<'secretFindingsByRule'>) { return this.inner.secretFindingsByRule(...a); }
  async secretFindingsByDistinctSecret(...a: Args<'secretFindingsByDistinctSecret'>) { return this.inner.secretFindingsByDistinctSecret(...a); }
  async secretCrossSessionCount(...a: Args<'secretCrossSessionCount'>) { return this.inner.secretCrossSessionCount(...a); }
  async secretFindingsForSession(...a: Args<'secretFindingsForSession'>) { return this.inner.secretFindingsForSession(...a); }

  // ── secret findings writer ──
  async ensureSecretFindingsTable(...a: Args<'ensureSecretFindingsTable'>) { return this.inner.ensureSecretFindingsTable(...a); }
  async replaceSecretFindings(...a: Args<'replaceSecretFindings'>) { return this.inner.replaceSecretFindings(...a); }

  // ── secret rules + dismissals ──
  async ensureSecretRulesTable(...a: Args<'ensureSecretRulesTable'>) { return this.inner.ensureSecretRulesTable(...a); }
  async listSecretRules(...a: Args<'listSecretRules'>) { return this.inner.listSecretRules(...a); }
  async upsertSecretRule(...a: Args<'upsertSecretRule'>) { return this.inner.upsertSecretRule(...a); }
  async deleteSecretRule(...a: Args<'deleteSecretRule'>) { return this.inner.deleteSecretRule(...a); }
  async ensureSecretDismissalsTable(...a: Args<'ensureSecretDismissalsTable'>) { return this.inner.ensureSecretDismissalsTable(...a); }
  async setSecretDismissal(...a: Args<'setSecretDismissal'>) { return this.inner.setSecretDismissal(...a); }
  async clearSecretDismissal(...a: Args<'clearSecretDismissal'>) { return this.inner.clearSecretDismissal(...a); }
  async getSecretDismissals(...a: Args<'getSecretDismissals'>) { return this.inner.getSecretDismissals(...a); }

  // ── FTS5 ──
  async addChunksFTS(...a: Args<'addChunksFTS'>) { return this.inner.addChunksFTS(...a); }
  async appendChunksFTS(...a: Args<'appendChunksFTS'>) { return this.inner.appendChunksFTS(...a); }
  async maxSyncChunkIndex(...a: Args<'maxSyncChunkIndex'>) { return this.inner.maxSyncChunkIndex(...a); }
  async touchSessionMtime(...a: Args<'touchSessionMtime'>) { return this.inner.touchSessionMtime(...a); }
  async listChunksByItem(...a: Args<'listChunksByItem'>) { return this.inner.listChunksByItem(...a); }
  async pruneEmptySessions(...a: Args<'pruneEmptySessions'>) { return this.inner.pruneEmptySessions(...a); }
  async deleteItemFTS(...a: Args<'deleteItemFTS'>) { return this.inner.deleteItemFTS(...a); }
  async rebuildFTS(...a: Args<'rebuildFTS'>) { return this.inner.rebuildFTS(...a); }
  async clearFTS(...a: Args<'clearFTS'>) { return this.inner.clearFTS(...a); }
  async searchFTS(...a: Args<'searchFTS'>) { return this.inner.searchFTS(...a); }
  async getFTSCount(...a: Args<'getFTSCount'>) { return this.inner.getFTSCount(...a); }
  async countDistinctItemsMatching(...a: Args<'countDistinctItemsMatching'>) { return this.inner.countDistinctItemsMatching(...a); }

  // ── tombstones / purge ──
  async addTombstone(...a: Args<'addTombstone'>) { return this.inner.addTombstone(...a); }
  async listTombstones(...a: Args<'listTombstones'>) { return this.inner.listTombstones(...a); }
  async purgeSession(...a: Args<'purgeSession'>) { return this.inner.purgeSession(...a); }

  // ── raw archive ──
  async putRawSession(...a: Args<'putRawSession'>) { return this.inner.putRawSession(...a); }
  async getRawSession(...a: Args<'getRawSession'>) { return this.inner.getRawSession(...a); }
  async listRawSessionVersions(...a: Args<'listRawSessionVersions'>) { return this.inner.listRawSessionVersions(...a); }
  async listEnvelopesMissingRawArchive(...a: Args<'listEnvelopesMissingRawArchive'>) { return this.inner.listEnvelopesMissingRawArchive(...a); }

  // ── KV ──
  async kvSet(...a: Args<'kvSet'>) { return this.inner.kvSet(...a); }
  async kvGet(...a: Args<'kvGet'>) { return this.inner.kvGet(...a); }
  async kvDelete(...a: Args<'kvDelete'>) { return this.inner.kvDelete(...a); }
  async kvList(...a: Args<'kvList'>) { return this.inner.kvList(...a); }

  // ── cross-tool sync intents (Model B queue) ──
  async enqueueSyncIntent(...a: Args<'enqueueSyncIntent'>) { return this.inner.enqueueSyncIntent(...a); }
  async listPendingSyncIntents(...a: Args<'listPendingSyncIntents'>) { return this.inner.listPendingSyncIntents(...a); }
  async ackSyncIntent(...a: Args<'ackSyncIntent'>) { return this.inner.ackSyncIntent(...a); }
  async listSyncIntents(...a: Args<'listSyncIntents'>) { return this.inner.listSyncIntents(...a); }

  // ── code intelligence (codeindex merge) ──
  async upsertCodeProject(...a: Args<'upsertCodeProject'>) { return this.inner.upsertCodeProject(...a); }
  async getCodeProject(...a: Args<'getCodeProject'>) { return this.inner.getCodeProject(...a); }
  async listCodeProjects(...a: Args<'listCodeProjects'>) { return this.inner.listCodeProjects(...a); }
  async setCodeProjectLabel(...a: Args<'setCodeProjectLabel'>) { return this.inner.setCodeProjectLabel(...a); }
  async deleteCodeProject(...a: Args<'deleteCodeProject'>) { return this.inner.deleteCodeProject(...a); }
  async replaceCodeFindings(...a: Args<'replaceCodeFindings'>) { return this.inner.replaceCodeFindings(...a); }
  async listCodeFindings(...a: Args<'listCodeFindings'>) { return this.inner.listCodeFindings(...a); }
  async codeFindingsSummary(...a: Args<'codeFindingsSummary'>) { return this.inner.codeFindingsSummary(...a); }
  async replaceCodeHotspots(...a: Args<'replaceCodeHotspots'>) { return this.inner.replaceCodeHotspots(...a); }
  async listCodeHotspots(...a: Args<'listCodeHotspots'>) { return this.inner.listCodeHotspots(...a); }
  async upsertCodeActions(...a: Args<'upsertCodeActions'>) { return this.inner.upsertCodeActions(...a); }
  async listCodeActions(...a: Args<'listCodeActions'>) { return this.inner.listCodeActions(...a); }
  async setCodeActionStatus(...a: Args<'setCodeActionStatus'>) { return this.inner.setCodeActionStatus(...a); }

  // ── lifecycle ──
  async close(...a: Args<'close'>) { return this.inner.close(...a); }
}
