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
import { isEmptyBatch, type IngestBatch, type IngestCounts, type IngestMetaWriter } from './ingest-batch.js';

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
  // Team activity is a cloud/multi-user (Postgres) concept — sqlite is single-user.
  async teamActivity(): Promise<Array<{ authorSub: string | null; projectId: string; sessions: number; lastMtime: number }>> { return []; }

  // Collaborative tasks are a cloud/team (Postgres) feature; sqlite is single-user.
  async createTeamTask(): Promise<never> { throw new Error('team tasks require the Postgres backend (cloud/team mode)'); }
  async listTeamTasks(): Promise<[]> { return []; }
  async getTeamTask(): Promise<null> { return null; }
  async updateTeamTask(): Promise<null> { return null; }
  async addTeamTaskComment(): Promise<null> { return null; }
  async teamTasksByFindingIds(): Promise<never[]> { return []; }

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
  /**
   * One ingest request's writes, ROW BY ROW.
   *
   * The Postgres driver runs this as set-based statements in one transaction,
   * because its cost is network round trips. This store is a local file used by
   * the unit tests, where a loop costs microseconds — so the loop is the right
   * shape here, and any test that measures statement counts must run against
   * Postgres. The ORDER is the same in both, and it matters: writing items
   * clears each session's cached summary, so the session-metadata rows go in
   * after it. See docs/SYNC-BATCH-WRITES.md §4.
   *
   * `meta` is required here and ignored by the Postgres driver. session_metadata
   * and compute_cache live in the metadata cache, which for SQLite is a SEPARATE
   * FILE this store cannot reach; in Postgres they are tables in the same
   * database, so that driver writes them inside its own transaction and needs no
   * collaborator. Omitting it here silently skips those two tables.
   */
  async writeIngestBatch(batch: IngestBatch, meta?: IngestMetaWriter): Promise<IngestCounts> {
    const counts: IngestCounts = { chunks: 0, findings: 0, computeOffered: 0 };
    if (isEmptyBatch(batch)) return counts;
    if (batch.items?.length) this.inner.setItems(batch.items);
    for (const t of batch.touchMtime ?? []) this.inner.touchSessionMtime(t.sessionId, t.mtime);
    for (const m of batch.sessionMeta ?? []) await meta?.setMany([m]);
    for (const c of batch.cachedContent ?? []) this.inner.setCachedContent(c.id, c.sourceType, c.mtime, c.content);
    if (batch.chunks?.length) counts.chunks += this.inner.addChunksFTS(batch.chunks);
    if (batch.appendChunks?.length) counts.chunks += this.inner.appendChunksFTS(batch.appendChunks);
    for (const f of batch.findings ?? []) counts.findings += this.inner.replaceSecretFindings(f.sessionId, f.findings).written;
    if (batch.compute?.length && meta) counts.computeOffered += await meta.setComputeMany(batch.compute);
    if (batch.links?.length) this.inner.addLinks(batch.links);
    return counts;
  }

  async rawSessionMetaMany(sessionIds: string[]) {
    const out = new Map<string, { size: number; mtime: number; project_id: string }>();
    for (const id of sessionIds) {
      const r = this.inner.getRawSession(id);
      if (r) out.set(id, { size: Number(r.size), mtime: Number(r.mtime), project_id: '' });
    }
    return out;
  }
  async getCachedContentStaleMany(sourceType: string, ids: string[]) {
    const out = new Map<string, { content: string; mtime: number }>();
    for (const id of ids) {
      const r = this.inner.getCachedContentStale(id, sourceType);
      if (r) out.set(id, r);
    }
    return out;
  }
  async maxSyncChunkIndexMany(itemIds: string[]) {
    const out = new Map<string, number>();
    for (const id of itemIds) out.set(id, this.inner.maxSyncChunkIndex(id));
    return out;
  }
  async existingItemIds(sourceType: string, ids: string[]) {
    const out = new Set<string>();
    for (const id of ids) if (this.inner.getItem(id, sourceType as never)) out.add(id);
    return out;
  }

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
  async addSecretFindings(...a: Args<'addSecretFindings'>) { return this.inner.addSecretFindings(...a); }

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
  async topImportantChunks(...a: Args<'topImportantChunks'>) { return this.inner.topImportantChunks(...a); }
  async countItemChunks(...a: Args<'countItemChunks'>) { return this.inner.countItemChunks(...a); }
  async getFTSCount(...a: Args<'getFTSCount'>) { return this.inner.getFTSCount(...a); }

  async approxStoredBytes(...a: Args<'approxStoredBytes'>) { return this.inner.approxStoredBytes(...a); }
  async countDistinctItemsMatching(...a: Args<'countDistinctItemsMatching'>) { return this.inner.countDistinctItemsMatching(...a); }

  // ── tombstones / purge ──
  async addTombstone(...a: Args<'addTombstone'>) { return this.inner.addTombstone(...a); }
  async listTombstones(...a: Args<'listTombstones'>) { return this.inner.listTombstones(...a); }
  async removeTombstone(...a: Args<'removeTombstone'>) { return this.inner.removeTombstone(...a); }
  async purgeSession(...a: Args<'purgeSession'>) { return this.inner.purgeSession(...a); }
  // Row by row, per the driver contract: this is the unit-test driver and its
  // store is a local file, so a loop costs microseconds. Statement counts mean
  // nothing here — measure them against Postgres.
  async purgeSessionsMany(sessionIds: string[]) {
    for (const id of sessionIds) this.inner.purgeSession(id);
  }
  async addTombstonesMany(sessionIds: string[]) {
    for (const id of sessionIds) this.inner.addTombstone(id);
  }
  // No pooling and no row-level security here, so there is no per-statement
  // transaction to save: the calls already run against one local file.
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
  // No row-level security here, so nothing reads an author back.
  async itemAuthor(_id: string, _sourceType: string) { return null; }
  async sourceToolCounts() {
    const out: Record<string, Record<string, number>> = {};
    const types = ['session', 'plan', 'task', 'claude_md', 'paste', 'history', 'diary',
      'skill', 'mcp', 'command', 'agent', 'hook', 'plugin'];
    for (const t of types) {
      const items = this.inner.listItems(t as never, 50_000, 0);
      if (items.length === 0) continue;
      const m: Record<string, number> = {};
      for (const it of items) {
        let tool = 'claude';
        try { tool = JSON.parse((it as { extra_json?: string }).extra_json || '{}').tool || 'claude'; } catch { /* default */ }
        m[tool] = (m[tool] || 0) + 1;
      }
      out[t] = m;
    }
    return out;
  }
  async sessionProjectCounts() {
    const projects: Record<string, number> = {};
    let total = 0;
    for (const it of this.inner.listItems('session' as never, 100_000, 0)) {
      total++;
      const p = (it as { project_path?: string }).project_path || '';
      if (p) projects[p] = (projects[p] || 0) + 1;
    }
    return { projects, total };
  }
  async countRawSessions() { return this.inner.listRawSessionVersions().length; }
  async projectsWithOpenCodeActions() {
    const out = new Set<string>();
    for (const a of this.inner.listCodeActions(undefined, { limit: 100000 })) {
      if (a.status !== 'dismissed' && a.projectId) out.add(a.projectId);
    }
    return out;
  }
  async tombstonedWithRemains(limit: number) { return this.inner.tombstonedWithRemains(limit); }
  async tombstonedAmong(sessionIds: string[]) {
    const want = new Set(sessionIds.filter(Boolean));
    const out = new Set<string>();
    for (const t of this.inner.listTombstones()) if (want.has(t.session_id)) out.add(t.session_id);
    return out;
  }

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
  async listAllPendingSyncIntents(...a: Args<'listAllPendingSyncIntents'>) { return this.inner.listAllPendingSyncIntents(...a); }
  async ackSyncIntent(...a: Args<'ackSyncIntent'>) { return this.inner.ackSyncIntent(...a); }
  async expireStaleSyncIntents(...a: Args<'expireStaleSyncIntents'>) { return this.inner.expireStaleSyncIntents(...a); }
  async listSyncIntents(...a: Args<'listSyncIntents'>) { return this.inner.listSyncIntents(...a); }

  // ── code intelligence (codeindex merge) ──
  async upsertCodeProject(...a: Args<'upsertCodeProject'>) { return this.inner.upsertCodeProject(...a); }
  async getCodeProject(...a: Args<'getCodeProject'>) { return this.inner.getCodeProject(...a); }
  async listCodeProjects(...a: Args<'listCodeProjects'>) { return this.inner.listCodeProjects(...a); }
  async setCodeProjectLabel(...a: Args<'setCodeProjectLabel'>) { return this.inner.setCodeProjectLabel(...a); }
  async deleteCodeProject(...a: Args<'deleteCodeProject'>) { return this.inner.deleteCodeProject(...a); }
  async replaceCodeFindings(...a: Args<'replaceCodeFindings'>) { return this.inner.replaceCodeFindings(...a); }
  async listCodeFindings(...a: Args<'listCodeFindings'>) { return this.inner.listCodeFindings(...a); }
  async codeFindingsByIds(...a: Args<'codeFindingsByIds'>) { return this.inner.codeFindingsByIds(...a); }
  async codeFindingsSummary(...a: Args<'codeFindingsSummary'>) { return this.inner.codeFindingsSummary(...a); }
  async replaceCodeHotspots(...a: Args<'replaceCodeHotspots'>) { return this.inner.replaceCodeHotspots(...a); }
  async listCodeHotspots(...a: Args<'listCodeHotspots'>) { return this.inner.listCodeHotspots(...a); }
  async upsertCodeActions(...a: Args<'upsertCodeActions'>) { return this.inner.upsertCodeActions(...a); }
  async listCodeActions(...a: Args<'listCodeActions'>) { return this.inner.listCodeActions(...a); }
  async setCodeActionStatus(...a: Args<'setCodeActionStatus'>) { return this.inner.setCodeActionStatus(...a); }

  // ── lifecycle ──
  async close(...a: Args<'close'>) { return this.inner.close(...a); }
}
