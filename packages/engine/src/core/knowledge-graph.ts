/**
 * Temporal Knowledge Graph for chat-recall.
 *
 * SQLite-backed entity-relationship graph with temporal validity.
 * Entities (people, projects, tools, concepts) are connected by typed
 * relationship triples that have valid_from / valid_to windows.
 *
 * Query "what was true about X on date Y", invalidate stale facts,
 * and traverse entity timelines.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';
import { getKnowledgeGraphDbPath } from './paths.js';

// ── Types ────────────────────────────────────────────────────────

export interface KGEntity {
  id: string;
  name: string;
  type: string;
  properties: Record<string, unknown>;
  created_at: string;
}

export interface KGTriple {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
  source_session: string | null;
  source_file: string | null;
  extracted_at: string;
}

export interface KGQueryResult {
  direction: 'outgoing' | 'incoming';
  subject: string;
  predicate: string;
  object: string;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
  source_session: string | null;
  current: boolean;
}

export interface KGTimelineEntry {
  subject: string;
  predicate: string;
  object: string;
  valid_from: string | null;
  valid_to: string | null;
  current: boolean;
  confidence: number;
  /** 'extracted' (auto-mined from chat) or 'asserted' (a human/agent recorded it). */
  origin: string;
}

/**
 * Normalize a KG date to date-only `YYYY-MM-DD`. Facts are day-granular, and
 * storing a mix of full ISO timestamps and date-only strings broke lexical
 * comparison (`'2026-01-01T10:00Z' <= '2026-01-01'` is false), so `as_of`
 * queries silently dropped facts. Canonical date-only makes string compare
 * chronological again.
 */
export function normalizeKgDate(d?: string | null): string | null {
  if (!d) return null;
  const m = d.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : d;
}

export interface KGStats {
  entities: number;
  triples: number;
  current_facts: number;
  expired_facts: number;
  relationship_types: string[];
}

// ── Knowledge Graph ──────────────────────────────────────────────

export class KnowledgeGraph {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath || getKnowledgeGraphDbPath();

    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'unknown',
        properties TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS triples (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        source_session TEXT,
        source_file TEXT,
        origin TEXT NOT NULL DEFAULT 'extracted',
        extracted_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (subject) REFERENCES entities(id),
        FOREIGN KEY (object) REFERENCES entities(id)
      );

      CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject);
      CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object);
      CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate);
      CREATE INDEX IF NOT EXISTS idx_triples_valid ON triples(valid_from, valid_to);
    `);
  }

  // ── Helpers ──────────────────────────────────────────────────

  private entityId(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_');
  }

  private tripleId(subject: string, predicate: string, object: string): string {
    const hash = createHash('sha256')
      .update(`${subject}|${predicate}|${object}|${Date.now()}`)
      .digest('hex')
      .slice(0, 12);
    return `t_${this.entityId(subject)}_${predicate}_${this.entityId(object)}_${hash}`;
  }

  // ── Write operations ─────────────────────────────────────────

  /** Add or update an entity node. */
  addEntity(
    name: string,
    entityType: string = 'unknown',
    properties: Record<string, unknown> = {}
  ): string {
    const eid = this.entityId(name);
    const props = JSON.stringify(properties);

    this.db.prepare(`
      INSERT OR REPLACE INTO entities (id, name, type, properties)
      VALUES (?, ?, ?, ?)
    `).run(eid, name, entityType, props);

    return eid;
  }

  /**
   * Add a relationship triple: subject → predicate → object.
   *
   * Auto-creates entities if they don't exist.
   * Deduplicates: won't add if an identical active triple exists.
   */
  addTriple(
    subject: string,
    predicate: string,
    object: string,
    options: {
      validFrom?: string;
      validTo?: string;
      confidence?: number;
      sourceSession?: string;
      sourceFile?: string;
      /** When true, a new object for this (subject, predicate) invalidates the
       *  prior one — so contradictory facts don't both stay "current". Opt-in:
       *  human assertions / single-valued predicates pass it; auto-extraction
       *  leaves it off (facts like `uses` are legitimately multi-valued). */
      supersede?: boolean;
      /** Provenance: 'extracted' (auto) vs 'asserted' (human/agent recorded). */
      origin?: string;
    } = {}
  ): string {
    const subId = this.entityId(subject);
    const objId = this.entityId(object);
    const pred = predicate.toLowerCase().replace(/\s+/g, '_');

    // Auto-create entities
    this.db.prepare(
      'INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)'
    ).run(subId, subject);
    this.db.prepare(
      'INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)'
    ).run(objId, object);

    // Check for existing identical active triple
    const existing = this.db.prepare(`
      SELECT id FROM triples
      WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL
    `).get(subId, pred, objId) as { id: string } | undefined;

    if (existing) return existing.id;

    // Supersede any contradictory active fact (same subject+predicate, different
    // object) so "current" never holds two conflicting values at once.
    const validFrom = normalizeKgDate(options.validFrom);
    const validTo = normalizeKgDate(options.validTo);
    if (options.supersede) {
      const asOf = validFrom || new Date().toISOString().slice(0, 10);
      this.db.prepare(`
        UPDATE triples SET valid_to = ?
        WHERE subject = ? AND predicate = ? AND object != ? AND valid_to IS NULL
      `).run(asOf, subId, pred, objId);
    }

    const tripleId = this.tripleId(subject, pred, object);

    this.db.prepare(`
      INSERT INTO triples (id, subject, predicate, object, valid_from, valid_to, confidence, source_session, source_file, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tripleId,
      subId,
      pred,
      objId,
      validFrom,
      validTo,
      options.confidence ?? 1.0,
      options.sourceSession || null,
      options.sourceFile || null,
      options.origin || 'extracted',
    );

    return tripleId;
  }

  /**
   * Idempotent triple import for sync ingest: inserts only when no triple
   * with the same (subject, predicate, object, valid_from, valid_to)
   * exists — unlike addTriple, expired facts (valid_to set) are matched
   * too, so re-syncing the same export never duplicates rows.
   */
  importTriple(t: {
    subject: string;
    predicate: string;
    object: string;
    valid_from?: string | null;
    valid_to?: string | null;
    confidence?: number;
    source_session?: string | null;
  }): 'inserted' | 'exists' {
    const subId = this.entityId(t.subject);
    const objId = this.entityId(t.object);
    const pred = t.predicate.toLowerCase().replace(/\s+/g, '_');

    this.db.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)').run(subId, t.subject);
    this.db.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)').run(objId, t.object);

    const existing = this.db.prepare(`
      SELECT id FROM triples
      WHERE subject = ? AND predicate = ? AND object = ?
        AND COALESCE(valid_from, '') = ? AND COALESCE(valid_to, '') = ?
    `).get(subId, pred, objId, t.valid_from ?? '', t.valid_to ?? '') as { id: string } | undefined;
    if (existing) return 'exists';

    this.db.prepare(`
      INSERT INTO triples (id, subject, predicate, object, valid_from, valid_to, confidence, source_session, source_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      this.tripleId(t.subject, pred, t.object),
      subId, pred, objId,
      t.valid_from ?? null, t.valid_to ?? null,
      t.confidence ?? 1.0, t.source_session ?? null,
    );
    return 'inserted';
  }

  /** Mark a relationship as no longer valid (set valid_to date). */
  invalidate(
    subject: string,
    predicate: string,
    object: string,
    ended?: string
  ): number {
    const subId = this.entityId(subject);
    const objId = this.entityId(object);
    const pred = predicate.toLowerCase().replace(/\s+/g, '_');
    const endDate = ended || new Date().toISOString().split('T')[0];

    const result = this.db.prepare(`
      UPDATE triples SET valid_to = ?
      WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL
    `).run(endDate, subId, pred, objId);

    return result.changes;
  }

  // ── Query operations ─────────────────────────────────────────

  /**
   * Get all relationships for an entity.
   *
   * @param name Entity name
   * @param asOf Date string — only return facts valid at that time
   * @param direction "outgoing" (entity→?), "incoming" (?→entity), "both"
   */
  queryEntity(
    name: string,
    asOf?: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'both'
  ): KGQueryResult[] {
    const eid = this.entityId(name);
    const results: KGQueryResult[] = [];

    if (direction === 'outgoing' || direction === 'both') {
      let sql = `
        SELECT t.*, e.name as obj_name
        FROM triples t
        JOIN entities e ON t.object = e.id
        WHERE t.subject = ?
      `;
      const params: (string)[] = [eid];

      if (asOf) {
        sql += ` AND (t.valid_from IS NULL OR t.valid_from <= ?)
                 AND (t.valid_to IS NULL OR t.valid_to >= ?)`;
        params.push(asOf, asOf);
      }

      const rows = this.db.prepare(sql).all(...params) as Array<{
        predicate: string; obj_name: string;
        valid_from: string | null; valid_to: string | null;
        confidence: number; source_session: string | null;
      }>;

      for (const row of rows) {
        results.push({
          direction: 'outgoing',
          subject: name,
          predicate: row.predicate,
          object: row.obj_name,
          valid_from: row.valid_from,
          valid_to: row.valid_to,
          confidence: row.confidence,
          source_session: row.source_session,
          current: row.valid_to === null,
        });
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      let sql = `
        SELECT t.*, e.name as sub_name
        FROM triples t
        JOIN entities e ON t.subject = e.id
        WHERE t.object = ?
      `;
      const params: (string)[] = [eid];

      if (asOf) {
        sql += ` AND (t.valid_from IS NULL OR t.valid_from <= ?)
                 AND (t.valid_to IS NULL OR t.valid_to >= ?)`;
        params.push(asOf, asOf);
      }

      const rows = this.db.prepare(sql).all(...params) as Array<{
        sub_name: string; predicate: string;
        valid_from: string | null; valid_to: string | null;
        confidence: number; source_session: string | null;
      }>;

      for (const row of rows) {
        results.push({
          direction: 'incoming',
          subject: row.sub_name,
          predicate: row.predicate,
          object: name,
          valid_from: row.valid_from,
          valid_to: row.valid_to,
          confidence: row.confidence,
          source_session: row.source_session,
          current: row.valid_to === null,
        });
      }
    }

    return results;
  }

  /** Get all triples with a given relationship type. */
  queryRelationship(predicate: string, asOf?: string): KGQueryResult[] {
    const pred = predicate.toLowerCase().replace(/\s+/g, '_');

    let sql = `
      SELECT t.*, s.name as sub_name, o.name as obj_name
      FROM triples t
      JOIN entities s ON t.subject = s.id
      JOIN entities o ON t.object = o.id
      WHERE t.predicate = ?
    `;
    const params: string[] = [pred];

    if (asOf) {
      sql += ` AND (t.valid_from IS NULL OR t.valid_from <= ?)
               AND (t.valid_to IS NULL OR t.valid_to >= ?)`;
      params.push(asOf, asOf);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      sub_name: string; obj_name: string; predicate: string;
      valid_from: string | null; valid_to: string | null;
      confidence: number; source_session: string | null;
    }>;

    return rows.map(row => ({
      direction: 'outgoing' as const,
      subject: row.sub_name,
      predicate: pred,
      object: row.obj_name,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      confidence: row.confidence,
      source_session: row.source_session,
      current: row.valid_to === null,
    }));
  }

  /** Get all facts in chronological order, optionally filtered by entity. */
  timeline(entityName?: string, limit = 100): KGTimelineEntry[] {
    let sql: string;
    let params: (string | number)[];

    if (entityName) {
      const eid = this.entityId(entityName);
      sql = `
        SELECT t.*, s.name as sub_name, o.name as obj_name
        FROM triples t
        JOIN entities s ON t.subject = s.id
        JOIN entities o ON t.object = o.id
        WHERE t.subject = ? OR t.object = ?
        ORDER BY t.valid_from ASC NULLS LAST
        LIMIT ?
      `;
      params = [eid, eid, limit];
    } else {
      sql = `
        SELECT t.*, s.name as sub_name, o.name as obj_name
        FROM triples t
        JOIN entities s ON t.subject = s.id
        JOIN entities o ON t.object = o.id
        ORDER BY t.valid_from ASC NULLS LAST
        LIMIT ?
      `;
      params = [limit];
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      sub_name: string; obj_name: string; predicate: string;
      valid_from: string | null; valid_to: string | null;
      confidence: number; origin: string | null;
    }>;

    return rows.map(r => ({
      subject: r.sub_name,
      predicate: r.predicate,
      object: r.obj_name,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      current: r.valid_to === null,
      confidence: r.confidence ?? 1.0,
      origin: r.origin ?? 'extracted',
    }));
  }

  // ── Stats ────────────────────────────────────────────────────

  stats(): KGStats {
    const entities = (this.db.prepare(
      'SELECT COUNT(*) as cnt FROM entities'
    ).get() as { cnt: number }).cnt;

    const triples = (this.db.prepare(
      'SELECT COUNT(*) as cnt FROM triples'
    ).get() as { cnt: number }).cnt;

    const current = (this.db.prepare(
      'SELECT COUNT(*) as cnt FROM triples WHERE valid_to IS NULL'
    ).get() as { cnt: number }).cnt;

    const predicates = (this.db.prepare(
      'SELECT DISTINCT predicate FROM triples ORDER BY predicate'
    ).all() as Array<{ predicate: string }>).map(r => r.predicate);

    return {
      entities,
      triples,
      current_facts: current,
      expired_facts: triples - current,
      relationship_types: predicates,
    };
  }

  /** List all entities. */
  listEntities(limit = 100): KGEntity[] {
    const rows = this.db.prepare(`
      SELECT * FROM entities ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Array<{
      id: string; name: string; type: string; properties: string; created_at: string;
    }>;

    return rows.map(r => ({
      ...r,
      properties: JSON.parse(r.properties),
    }));
  }

  close(): void {
    this.db.close();
  }
}
