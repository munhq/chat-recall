/**
 * Postgres schema for the StorageDriver — mirrors the SQLite tables but adds a
 * `tenant` column to every table so one Postgres instance serves many teams
 * (the cloud/self-host multi-tenant model). Local/solo Postgres just uses the
 * default tenant. Idempotent: safe to run on every connection.
 *
 * FTS: SQLite's FTS5 virtual table becomes a real `memory_chunks` table with a
 * generated `tsv tsvector` column + GIN index (Postgres full-text search).
 * Vectors (pgvector) are added by PgVectorStore separately.
 */
export const PG_SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS memory_metadata (
  tenant          TEXT NOT NULL DEFAULT 'default',
  id              TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  title           TEXT NOT NULL,
  project_path    TEXT NOT NULL DEFAULT '',
  project_id      TEXT NOT NULL DEFAULT '',
  content_preview TEXT NOT NULL DEFAULT '',
  file_path       TEXT NOT NULL DEFAULT '',
  mtime           BIGINT NOT NULL DEFAULT 0,
  indexed_at      BIGINT NOT NULL,
  extra_json      TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant, id, source_type)
);
CREATE INDEX IF NOT EXISTS idx_mm_tenant_source ON memory_metadata(tenant, source_type);
CREATE INDEX IF NOT EXISTS idx_mm_tenant_project ON memory_metadata(tenant, project_path);
CREATE INDEX IF NOT EXISTS idx_mm_tenant_projid ON memory_metadata(tenant, project_id);
CREATE INDEX IF NOT EXISTS idx_mm_tenant_mtime ON memory_metadata(tenant, mtime);

CREATE TABLE IF NOT EXISTS memory_links (
  id           BIGSERIAL PRIMARY KEY,
  tenant       TEXT NOT NULL DEFAULT 'default',
  source_type  TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  link_type    TEXT NOT NULL,
  confidence   REAL NOT NULL DEFAULT 1.0,
  created_at   BIGINT NOT NULL,
  UNIQUE (tenant, source_type, source_id, target_type, target_id, link_type)
);
CREATE INDEX IF NOT EXISTS idx_links_src ON memory_links(tenant, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_links_tgt ON memory_links(tenant, target_type, target_id);

CREATE TABLE IF NOT EXISTS content_cache (
  tenant       TEXT NOT NULL DEFAULT 'default',
  id           TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  content_json TEXT NOT NULL,
  mtime        BIGINT NOT NULL,
  PRIMARY KEY (tenant, id, source_type)
);

CREATE TABLE IF NOT EXISTS kv_store (
  tenant      TEXT NOT NULL DEFAULT 'default',
  scope       TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  BIGINT NOT NULL,
  PRIMARY KEY (tenant, scope, key)
);

CREATE TABLE IF NOT EXISTS memory_chunks (
  tenant       TEXT NOT NULL DEFAULT 'default',
  chunk_id     TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  text         TEXT NOT NULL DEFAULT '',
  chunk_type   TEXT NOT NULL DEFAULT '',
  project_path TEXT NOT NULL DEFAULT '',
  project_id   TEXT NOT NULL DEFAULT '',
  file_path    TEXT NOT NULL DEFAULT '',
  mtime        BIGINT NOT NULL DEFAULT 0,
  tsv          tsvector GENERATED ALWAYS AS (
                 to_tsvector('english', coalesce(title,'') || ' ' || coalesce(text,''))
               ) STORED,
  PRIMARY KEY (tenant, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON memory_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS idx_chunks_item ON memory_chunks(tenant, source_type, item_id);

CREATE TABLE IF NOT EXISTS secret_findings (
  id          BIGSERIAL PRIMARY KEY,
  tenant      TEXT NOT NULL DEFAULT 'default',
  session_id  TEXT NOT NULL,
  detector    TEXT NOT NULL,
  rule        TEXT NOT NULL,
  line        INTEGER,
  preview     TEXT,
  scanned_at  BIGINT NOT NULL,
  verified    INTEGER,
  UNIQUE (tenant, session_id, detector, rule, line)
);
CREATE INDEX IF NOT EXISTS idx_sf_tenant_session ON secret_findings(tenant, session_id);

CREATE TABLE IF NOT EXISTS secret_rules (
  id          BIGSERIAL PRIMARY KEY,
  tenant      TEXT NOT NULL DEFAULT 'default',
  name        TEXT NOT NULL,
  regex       TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  description TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  UNIQUE (tenant, name)
);

CREATE TABLE IF NOT EXISTS secret_dismissals (
  tenant       TEXT NOT NULL DEFAULT 'default',
  preview      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('rotated','false_positive','dismissed')),
  reason       TEXT,
  dismissed_at BIGINT NOT NULL,
  PRIMARY KEY (tenant, preview)
);

CREATE TABLE IF NOT EXISTS session_metadata (
  tenant         TEXT NOT NULL DEFAULT 'default',
  session_id     TEXT NOT NULL,
  first_prompt   TEXT NOT NULL DEFAULT '',
  summary        TEXT NOT NULL DEFAULT '',
  summary_source TEXT NOT NULL DEFAULT 'original',
  mtime          BIGINT NOT NULL DEFAULT 0,
  indexed_at     BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, session_id)
);

CREATE TABLE IF NOT EXISTS tenants (
  tenant      TEXT PRIMARY KEY,
  created_at  BIGINT NOT NULL
);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS display_name TEXT;

-- ── Control plane: identity → tenant mapping ────────────────────────────
-- Deliberately NOT in the RLS loop below: these rows are looked up BEFORE a
-- tenant is established (token → tenant, user → memberships). The server
-- queries them by verified token hash / Keycloak sub only.
CREATE TABLE IF NOT EXISTS agent_tokens (
  id          BIGSERIAL PRIMARY KEY,
  tenant      TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  token_hash  TEXT NOT NULL,          -- sha256(raw token); raw shown once
  user_sub    TEXT,
  created_at  BIGINT NOT NULL,
  revoked_at  BIGINT,
  UNIQUE (tenant, device_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens(token_hash);

CREATE TABLE IF NOT EXISTS teams (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  owner_sub   TEXT NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  user_sub    TEXT NOT NULL,
  team_slug   TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  email       TEXT,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (user_sub, team_slug)
);
CREATE INDEX IF NOT EXISTS idx_memberships_team ON memberships(team_slug);
CREATE TABLE IF NOT EXISTS invites (
  token_hash  TEXT PRIMARY KEY,       -- sha256(raw invite)
  team_slug   TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  email_hint  TEXT,
  created_by  TEXT NOT NULL,
  expires_at  BIGINT NOT NULL,
  used_at     BIGINT
);

-- MetadataCache: per-session compute cache + summary-error tracking.
CREATE TABLE IF NOT EXISTS summary_errors (
  tenant          TEXT NOT NULL DEFAULT 'default',
  session_id      TEXT NOT NULL,
  error           TEXT NOT NULL,
  attempt_count   INTEGER NOT NULL DEFAULT 1,
  first_failed_at BIGINT NOT NULL,
  last_failed_at  BIGINT NOT NULL,
  PRIMARY KEY (tenant, session_id)
);
CREATE TABLE IF NOT EXISTS compute_cache (
  tenant        TEXT NOT NULL DEFAULT 'default',
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  mtime         BIGINT NOT NULL,
  payload_json  TEXT,
  payload_gz    BYTEA,
  computed_at   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, session_id, kind)
);

-- OutcomeCache
CREATE TABLE IF NOT EXISTS session_outcome_cache (
  tenant              TEXT NOT NULL DEFAULT 'default',
  session_id          TEXT NOT NULL,
  tool                TEXT NOT NULL,
  status              TEXT NOT NULL,
  reason              TEXT NOT NULL,
  file_mtime          BIGINT NOT NULL,
  file_size           BIGINT NOT NULL,
  content_hash        TEXT NOT NULL DEFAULT '',
  file_count          INTEGER NOT NULL DEFAULT 0,
  lines_added         INTEGER NOT NULL DEFAULT 0,
  lines_removed       INTEGER NOT NULL DEFAULT 0,
  commits             INTEGER NOT NULL DEFAULT 0,
  is_full             INTEGER NOT NULL DEFAULT 0,
  classified_at       BIGINT NOT NULL,
  last_scanned_offset BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant, session_id)
);

-- KnowledgeGraph
CREATE TABLE IF NOT EXISTS kg_entities (
  tenant     TEXT NOT NULL DEFAULT 'default',
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'unknown',
  properties TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, id)
);
CREATE TABLE IF NOT EXISTS kg_triples (
  tenant         TEXT NOT NULL DEFAULT 'default',
  id             TEXT NOT NULL,
  subject        TEXT NOT NULL,
  predicate      TEXT NOT NULL,
  object         TEXT NOT NULL,
  valid_from     TEXT,
  valid_to       TEXT,
  confidence     REAL NOT NULL DEFAULT 1.0,
  source_session TEXT,
  source_file    TEXT,
  extracted_at   TEXT NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS'),
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS idx_kgt_subject ON kg_triples(tenant, subject);
CREATE INDEX IF NOT EXISTS idx_kgt_object ON kg_triples(tenant, object);
CREATE INDEX IF NOT EXISTS idx_kgt_predicate ON kg_triples(tenant, predicate);

-- WAL audit + agent diary
CREATE TABLE IF NOT EXISTS wal_log (
  tenant     TEXT NOT NULL DEFAULT 'default',
  id         BIGSERIAL PRIMARY KEY,
  ts         BIGINT NOT NULL,
  operation  TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS diary_entries (
  tenant       TEXT NOT NULL DEFAULT 'default',
  id           TEXT NOT NULL,
  agent        TEXT NOT NULL,
  topic        TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL,
  ts           TEXT NOT NULL,
  session_id   TEXT,
  project_path TEXT,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS idx_diary_agent ON diary_entries(tenant, agent);

-- ── Row-Level Security: the wall between tenants ─────────────────────────
-- Every tenant-bearing table is force-RLS'd and isolated by the per-transaction
-- 'app.tenant' GUC the drivers set (see pg-pool.ts tenantQuery). A non-superuser
-- DATABASE_URL role is required in multi-tenant cloud mode for FORCE RLS to
-- bind; self-host pins tenant='default' (and a superuser DSN simply bypasses,
-- which is harmless for a single tenant). memory_vectors is handled in vector.ts.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memory_metadata','memory_links','content_cache','kv_store','memory_chunks',
    'secret_findings','secret_rules','secret_dismissals','session_metadata','tenants',
    'summary_errors','compute_cache','session_outcome_cache','kg_entities','kg_triples',
    'wal_log','diary_entries'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant = current_setting('app.tenant', true))
        WITH CHECK (tenant = current_setting('app.tenant', true))
    $p$, t);
  END LOOP;
END $$;
`;
