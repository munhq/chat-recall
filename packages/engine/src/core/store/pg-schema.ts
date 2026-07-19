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
-- Session-id PREFIX resolution (recall_show/summary/context/... accept a unique
-- short id). The text_pattern_ops opclass makes a LIKE 'prefix%' an index range
-- scan regardless of the database default collation (a plain btree only supports
-- LIKE-prefix under the C locale) -- so short-id lookups stay O(log n) instead of
-- scanning every one of a tenant's sessions. Partial (sessions only) keeps it
-- small. See expandSessionId() in routes/conversations.ts.
CREATE INDEX IF NOT EXISTS idx_mm_session_id_prefix
  ON memory_metadata (tenant, id text_pattern_ops)
  WHERE source_type = 'session';

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

-- Cross-tool sync intents (Model B queue). UI enqueues "copy X from Y to Z"
-- (or sync_all); the local CLI agent drains pending rows, copies on the
-- user's machine, and acks status. Tenant + device scoped (RLS-walled).
CREATE TABLE IF NOT EXISTS sync_intents (
  tenant        TEXT NOT NULL DEFAULT 'default',
  id            TEXT NOT NULL,
  device_id     TEXT,
  kind          TEXT NOT NULL,
  artifact_type TEXT,
  name          TEXT,
  from_tool     TEXT,
  to_tool       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  result        TEXT,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  created_by    TEXT,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS idx_sync_intents_pending ON sync_intents (tenant, status, created_at);

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
-- Importance feed (recall_wake_up / topImportantChunks): filter + order by the
-- imp digit parsed out of chunk_type. Expression index so the scan is an index
-- range, not a full table scan, on every wake-up. The expression is IMMUTABLE
-- (substring/nullif/coalesce/cast), so it's index-eligible.
CREATE INDEX IF NOT EXISTS idx_chunks_importance ON memory_chunks
  (tenant, (COALESCE(NULLIF(substring(chunk_type FROM 'imp([0-9])'), '')::int, 0)) DESC, mtime DESC);
-- Typo tolerance: pg_trgm + a trigram GIN index on chunk text powers the
-- word-similarity fallback in searchFTS (a misspelled query still finds the
-- right sessions). Best-effort: pg_trgm is a "trusted" extension (a non-super
-- DB owner can create it), but if the role can't, swallow it — searchFTS's
-- trigram fallback is itself try/wrapped, so search degrades to plain FTS.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS idx_chunks_text_trgm ON memory_chunks USING GIN (text gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm/trigram index unavailable (%) — search falls back to plain FTS', SQLERRM;
END $$;

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

-- Once-only ledger for verified-live secret alerts. The sync route
-- DELETE/re-INSERTs findings on every sync, so it can't tell "new" from
-- "re-seen"; an INSERT ... ON CONFLICT DO NOTHING here gives genuine
-- fire-once-per-(tenant,preview) semantics for the alert path.
CREATE TABLE IF NOT EXISTS alerted_secrets (
  tenant     TEXT NOT NULL DEFAULT 'default',
  preview    TEXT NOT NULL,
  alerted_at BIGINT NOT NULL,
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
-- User-assigned conversation name (mirrors Claude Code's /rename). Written
-- ONLY by setUserTitle; the sync/summary upsert (caches.ts PgMetadataCache.set)
-- deliberately omits this column so a name survives every re-sync.
ALTER TABLE session_metadata ADD COLUMN IF NOT EXISTS user_title TEXT;
-- Native title assigned by the originating tool (Claude ai-title, OpenCode
-- session.title, …), synced from the collector. Written only by setToolTitle.
ALTER TABLE session_metadata ADD COLUMN IF NOT EXISTS tool_title TEXT;
-- Summary work-queue LEASE — a SEPARATE table, deliberately NOT a column on the
-- hot session_metadata. The worker claims a batch in a short tx, writes a lease
-- row here, runs the LLM OUTSIDE any transaction, then writes the summary +
-- deletes the lease in a second short tx. A crashed worker's lease just expires
-- (claimed_at < now - SUMMARY_LEASE_MS) and another worker re-claims — nothing
-- strands. Kept out of session_metadata on purpose: ALTER-ing that continuously
-- written table needs an ACCESS EXCLUSIVE lock that fights sync ingest + the old
-- workers' long txns during a rollout (lock-timeout crash-on-boot). A brand-new
-- table has zero such contention. summary_leases only ever holds rows for the
-- few IN-FLIGHT claims (deleted on completion), so it stays tiny.
CREATE TABLE IF NOT EXISTS summary_leases (
  tenant      TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  claimed_at  BIGINT NOT NULL,
  PRIMARY KEY (tenant, session_id)
);
-- Work-queue index for the summary backfill (summary-worker SKIP-LOCKED claim).
-- The claim scans only un-summarised rows; this keeps it O(pending) instead of
-- O(all sessions) as the table grows. summary is NOT NULL DEFAULT empty-string,
-- so the empty-string predicate covers the whole pending backlog.
CREATE INDEX IF NOT EXISTS idx_session_metadata_pending
  ON session_metadata (tenant, mtime) WHERE summary = '';

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

-- Team toolkit library: one row per artifact (latest version only; publishing
-- the same (type,tool,name) bumps version in place). Bodies are small
-- (skills/commands/CLAUDE.md — capped at the API layer), base64-encoded.
-- Access is membership-checked at the route layer (control plane), not RLS.
CREATE TABLE IF NOT EXISTS team_artifacts (
  team_slug   TEXT NOT NULL,
  id          TEXT NOT NULL,          -- a_<sha256(team|type|tool|name)[:16]>
  type        TEXT NOT NULL,
  tool        TEXT NOT NULL,
  name        TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  author_sub  TEXT NOT NULL,
  sha256      TEXT NOT NULL,          -- of the raw (decoded) body
  pinned_to   TEXT,
  body_b64    TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  updated_at  BIGINT NOT NULL,
  revoked_at  BIGINT,
  PRIMARY KEY (team_slug, id)
);
CREATE INDEX IF NOT EXISTS idx_team_artifacts_updated ON team_artifacts(team_slug, updated_at);

-- Billing / entitlement: per-tenant subscription state, flipped by Stripe
-- webhooks. Control-plane (NOT RLS-walled): the billing gate reads it by
-- verified tenant id to decide access BEFORE running a tenant-scoped query,
-- and the webhook writes it with no tenant GUC in context (the tenant comes
-- from Stripe's client_reference_id / subscription metadata).
CREATE TABLE IF NOT EXISTS entitlements (
  tenant                 TEXT PRIMARY KEY,
  plan                   TEXT,
  status                 TEXT,
  current_period_end     BIGINT,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  updated_at             BIGINT
);

-- Per-tenant product settings (key/value, controlled from the dashboard).
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant       TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (tenant, key)
);
-- Not RLS-walled: read by the sync client before tenant context is established.

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
  origin         TEXT NOT NULL DEFAULT 'extracted',
  extracted_at   TEXT NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS'),
  PRIMARY KEY (tenant, id)
);
-- Backfill the origin column on pre-existing deployments (idempotent).
ALTER TABLE kg_triples ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'extracted';
CREATE INDEX IF NOT EXISTS idx_kgt_subject ON kg_triples(tenant, subject);
CREATE INDEX IF NOT EXISTS idx_kgt_object ON kg_triples(tenant, object);
CREATE INDEX IF NOT EXISTS idx_kgt_predicate ON kg_triples(tenant, predicate);

-- WAL audit + agent diary
CREATE TABLE IF NOT EXISTS session_tombstones (
  tenant     TEXT NOT NULL DEFAULT 'default',
  session_id TEXT NOT NULL,
  deleted_at BIGINT NOT NULL,
  PRIMARY KEY (tenant, session_id)
);

CREATE TABLE IF NOT EXISTS raw_sessions (
  tenant       TEXT NOT NULL DEFAULT 'default',
  session_id   TEXT NOT NULL,
  tool         TEXT NOT NULL,
  mtime        BIGINT NOT NULL,
  size         BIGINT NOT NULL,
  gz           BYTEA NOT NULL,
  captured_at  BIGINT NOT NULL,
  PRIMARY KEY (tenant, session_id)
);

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

-- ── Code intelligence (codeindex merge) ─────────────────────────────────
-- Produced by the local codeindex Zig engine + the TS collector (git churn,
-- AI-authorship, complexity, action-plan synthesis), synced via /api/sync.
-- Findings + hotspots are derived/regenerable (replaced wholesale per project
-- on each re-index); actions carry durable user state (queued/done/dismissed)
-- and are upserted by deterministic id.
CREATE TABLE IF NOT EXISTS code_projects (
  tenant          TEXT NOT NULL DEFAULT 'default',
  project_id      TEXT NOT NULL,
  root_path       TEXT NOT NULL DEFAULT '',
  file_count      INTEGER NOT NULL DEFAULT 0,
  symbol_count    INTEGER NOT NULL DEFAULT 0,
  langs_json      TEXT NOT NULL DEFAULT '{}',
  health_json     TEXT NOT NULL DEFAULT '{}',
  map_json        TEXT NOT NULL DEFAULT '{}',
  label           TEXT CHECK (label IN ('poc','production','engineering')),
  indexed_by      TEXT,
  last_indexed_at BIGINT NOT NULL DEFAULT 0,
  collector_version INTEGER,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (tenant, project_id)
);
-- Additive for databases created before collector_version existed (idempotent;
-- lets the watch daemon re-derive projects indexed by an older collector).
ALTER TABLE code_projects ADD COLUMN IF NOT EXISTS collector_version INTEGER;

CREATE TABLE IF NOT EXISTS code_findings (
  tenant        TEXT NOT NULL DEFAULT 'default',
  id            TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  category      TEXT NOT NULL,
  severity      TEXT NOT NULL,
  file          TEXT NOT NULL DEFAULT '',
  line          INTEGER,
  rule          TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  snippet       TEXT NOT NULL DEFAULT '',
  why           TEXT NOT NULL DEFAULT '',
  agent_prompt  TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open',
  first_seen_at BIGINT NOT NULL,
  last_seen_at  BIGINT NOT NULL,
  extra_json    TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS idx_code_findings_proj ON code_findings(tenant, project_id, severity);

CREATE TABLE IF NOT EXISTS code_hotspots (
  tenant       TEXT NOT NULL DEFAULT 'default',
  id           TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  file         TEXT NOT NULL DEFAULT '',
  churn        INTEGER NOT NULL DEFAULT 0,
  complexity   INTEGER NOT NULL DEFAULT 0,
  score        REAL NOT NULL DEFAULT 0,
  ai_authored  INTEGER NOT NULL DEFAULT 0,
  lines        INTEGER NOT NULL DEFAULT 0,
  suggestion   TEXT NOT NULL DEFAULT '',
  last_seen_at BIGINT NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS idx_code_hotspots_proj ON code_hotspots(tenant, project_id, score);
-- Added after initial code_hotspots shape — ALTER so existing tables get it
-- (CREATE TABLE IF NOT EXISTS won't add columns to a pre-existing table).
ALTER TABLE code_hotspots ADD COLUMN IF NOT EXISTS suggestion TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS code_actions (
  tenant       TEXT NOT NULL DEFAULT 'default',
  id           TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  pri          INTEGER NOT NULL DEFAULT 0,
  category     TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  fix          TEXT NOT NULL DEFAULT '',
  loc_json     TEXT NOT NULL DEFAULT '[]',
  agent_prompt TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'suggested',
  queued       INTEGER NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS idx_code_actions_proj ON code_actions(tenant, project_id, pri);

-- Client failure/health telemetry from collectors + MCP (crashes, sync
-- failures, auth failures, tool errors). Lets the operator see when a
-- customer's recall breaks instead of waiting to be told. Redacted at the
-- client; append-only, tenant-isolated.
CREATE TABLE IF NOT EXISTS client_events (
  id          BIGSERIAL PRIMARY KEY,
  tenant      TEXT NOT NULL DEFAULT 'default',
  ts          BIGINT NOT NULL,
  kind        TEXT NOT NULL,
  tool        TEXT NOT NULL DEFAULT '',
  cli_version TEXT NOT NULL DEFAULT '',
  os          TEXT NOT NULL DEFAULT '',
  device_id   TEXT NOT NULL DEFAULT '',
  message     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_client_events_tenant_ts ON client_events(tenant, ts DESC);
CREATE INDEX IF NOT EXISTS idx_client_events_tenant_kind ON client_events(tenant, kind);

-- ── Author attribution (team collaboration) ─────────────────────────────
-- Who produced each row within a team (= tenant): author_sub = the Keycloak
-- user that owns the syncing device (from agent_tokens.user_sub), author_device
-- = the syncing device id. Additive + nullable so pre-attribution rows stay
-- valid — a NULL author is "legacy/solo" and the team-visibility layer treats it
-- as team-visible (status quo), so turning attribution on never retroactively
-- hides existing data. Stamped SERVER-SIDE at ingest from the agent token
-- identity (no client change). Members re-attribute history with sync --full.
-- ADD COLUMN IF NOT EXISTS is a metadata-only, idempotent op (a no-op once the
-- column exists), same pattern as user_title/tool_title/collector_version above.
ALTER TABLE memory_metadata       ADD COLUMN IF NOT EXISTS author_sub TEXT;
ALTER TABLE memory_metadata       ADD COLUMN IF NOT EXISTS author_device TEXT;
ALTER TABLE memory_chunks         ADD COLUMN IF NOT EXISTS author_sub TEXT;
ALTER TABLE memory_chunks         ADD COLUMN IF NOT EXISTS author_device TEXT;
ALTER TABLE session_metadata      ADD COLUMN IF NOT EXISTS author_sub TEXT;
ALTER TABLE session_metadata      ADD COLUMN IF NOT EXISTS author_device TEXT;
ALTER TABLE session_outcome_cache ADD COLUMN IF NOT EXISTS author_sub TEXT;
ALTER TABLE secret_findings       ADD COLUMN IF NOT EXISTS author_sub TEXT;
ALTER TABLE secret_findings       ADD COLUMN IF NOT EXISTS author_device TEXT;
ALTER TABLE secret_dismissals     ADD COLUMN IF NOT EXISTS dismissed_by TEXT;
ALTER TABLE kg_triples            ADD COLUMN IF NOT EXISTS author_sub TEXT;
ALTER TABLE diary_entries         ADD COLUMN IF NOT EXISTS author_sub TEXT;
ALTER TABLE code_projects         ADD COLUMN IF NOT EXISTS author_sub TEXT;
ALTER TABLE code_findings         ADD COLUMN IF NOT EXISTS author_sub TEXT;
ALTER TABLE code_hotspots         ADD COLUMN IF NOT EXISTS author_sub TEXT;
ALTER TABLE code_actions          ADD COLUMN IF NOT EXISTS author_sub TEXT;
-- Per-author activity feed + the (author, project) membership test the
-- visibility predicate runs on every read.
CREATE INDEX IF NOT EXISTS idx_mm_tenant_author ON memory_metadata(tenant, author_sub);
CREATE INDEX IF NOT EXISTS idx_mm_tenant_author_proj ON memory_metadata(tenant, author_sub, project_id);
CREATE INDEX IF NOT EXISTS idx_chunks_tenant_author ON memory_chunks(tenant, author_sub);
-- The team-activity rollup groups sessions by (author, project); a partial
-- index on sessions keeps it off a full-tenant scan.
CREATE INDEX IF NOT EXISTS idx_mm_activity ON memory_metadata(tenant, author_sub, project_id) WHERE source_type = 'session';

-- ── Team collaboration control plane ─────────────────────────────────────
-- Per-project opt-in sharing: a member (owner_sub) opts THEIR work on a
-- project_id into team visibility. Default is private — nothing is visible to
-- teammates until shared. NOT RLS-walled (control-plane, keyed by team_slug),
-- checked at the route layer + read by the visibility predicate, exactly like
-- team_artifacts. scope: 'activity' = metadata only (titles, file lists, task
-- counts); 'full' = redacted content too.
CREATE TABLE IF NOT EXISTS team_project_shares (
  team_slug   TEXT NOT NULL,
  owner_sub   TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('activity','full')),
  shared_at   BIGINT NOT NULL,
  PRIMARY KEY (team_slug, owner_sub, project_id)
);
CREATE INDEX IF NOT EXISTS idx_tps_team ON team_project_shares(team_slug);

-- Collaborative tasks: server-authoritative board, team-visible within the
-- tenant (RLS-walled — tasks ARE the collaboration surface, independent of
-- per-project content sharing). Projected into an assignee's repo as
-- TEAM_TASKS.md via the sync-intent + project-tasks rails.
CREATE TABLE IF NOT EXISTS team_tasks (
  tenant            TEXT NOT NULL DEFAULT 'default',
  id                TEXT NOT NULL,
  project_id        TEXT NOT NULL DEFAULT '',
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','blocked','done')),
  assignee_sub      TEXT,
  created_by        TEXT NOT NULL,
  blocks            TEXT NOT NULL DEFAULT '[]',
  blocked_by        TEXT NOT NULL DEFAULT '[]',
  linked_session_id TEXT,
  due               BIGINT,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS idx_team_tasks_proj ON team_tasks(tenant, project_id, status);
CREATE INDEX IF NOT EXISTS idx_team_tasks_assignee ON team_tasks(tenant, assignee_sub, status);

CREATE TABLE IF NOT EXISTS team_task_comments (
  tenant     TEXT NOT NULL DEFAULT 'default',
  id         TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  author_sub TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS idx_team_task_comments_task ON team_task_comments(tenant, task_id, created_at);

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
    'secret_findings','secret_rules','secret_dismissals','alerted_secrets','session_metadata',
    'summary_errors','summary_leases','compute_cache','session_outcome_cache','kg_entities','kg_triples',
    'wal_log','diary_entries','sync_intents','raw_sessions',
    'code_projects','code_findings','code_hotspots','code_actions',
    'client_events','team_tasks','team_task_comments'
  ] LOOP
    -- IDEMPOTENT: only configure a table that isn't already locked down. The
    -- ALTER/DROP/CREATE POLICY statements each take an ACCESS EXCLUSIVE lock on
    -- the table; re-running them on every boot re-locks HOT tables (e.g.
    -- session_metadata), which during a rollout deadlocks against sync ingest +
    -- the old workers' long transactions → lock_timeout → crash-on-boot. Skipping
    -- already-configured tables means steady-state boots take NO locks; only a
    -- brand-new table (summary_leases) is ever touched, and it has no contention.
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      EXECUTE format($p$
        CREATE POLICY tenant_isolation ON %I
          USING (tenant = current_setting('app.tenant', true))
          WITH CHECK (tenant = current_setting('app.tenant', true))
      $p$, t);
    END IF;
  END LOOP;
END $$;

-- tenants is control-plane (identity-to-tenant mapping, queried BEFORE any
-- tenant context exists), so it must NOT be RLS-walled. Earlier versions
-- included it in the loop above — undo that on upgraded databases.
DROP POLICY IF EXISTS tenant_isolation ON tenants;
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;

-- ── Per-project team visibility (RLS, RESTRICTIVE, SELECT-only) ──────────
-- The member boundary WITHIN a team (=tenant): a viewer sees a row only if it
-- is their own, shared into the team, or legacy (NULL author). Enforced in the
-- DB with a RESTRICTIVE policy (which ANDs with the permissive tenant_isolation
-- policy), FOR SELECT only so writes + background workers are untouched.
--
-- memory_metadata is the SINGLE source of truth; every child table inherits its
-- visibility via EXISTS to its parent memory_metadata row — so no read path
-- (search, vector, secrets, KG, caches, raw SQL, or anything written later) can
-- bypass the boundary. The per-request app.viewer GUC is set by the pool
-- wrapper (pg-pool.ts setScopeGucs); UNSET (worker/CLI/solo) short-circuits to
-- "see all" via the IS NULL guard, so single-tenant/self-host is unchanged.
-- team_project_shares is control-plane (no RLS), so the EXISTS to it never
-- recurses. Idempotent: only creates a policy that isn't already present.
DO $$
DECLARE t TEXT;
BEGIN
  -- memory_metadata — the source of truth (self-referential: own / shared / legacy).
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='memory_metadata' AND policyname='author_visibility') THEN
    CREATE POLICY author_visibility ON memory_metadata AS RESTRICTIVE FOR SELECT USING (
      current_setting('app.viewer', true) = '*'
      OR memory_metadata.author_sub IS NULL
      OR memory_metadata.author_sub = current_setting('app.viewer', true)
      OR EXISTS (SELECT 1 FROM team_project_shares s
                 WHERE s.team_slug = memory_metadata.tenant
                   AND s.owner_sub = memory_metadata.author_sub
                   AND s.project_id = memory_metadata.project_id)
    );
  END IF;

  -- memory_chunks — item-keyed (join on item_id, source_type).
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='memory_chunks' AND policyname='author_visibility') THEN
    CREATE POLICY author_visibility ON memory_chunks AS RESTRICTIVE FOR SELECT USING (
      current_setting('app.viewer', true) = '*'
      OR EXISTS (SELECT 1 FROM memory_metadata m
                 WHERE m.tenant = memory_chunks.tenant AND m.id = memory_chunks.item_id AND m.source_type = memory_chunks.source_type)
    );
  END IF;

  -- content_cache — item-keyed, but its item column is id (PK: tenant,id,source_type).
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='content_cache' AND policyname='author_visibility') THEN
    CREATE POLICY author_visibility ON content_cache AS RESTRICTIVE FOR SELECT USING (
      current_setting('app.viewer', true) = '*'
      OR EXISTS (SELECT 1 FROM memory_metadata m
                 WHERE m.tenant = content_cache.tenant AND m.id = content_cache.id AND m.source_type = content_cache.source_type)
    );
  END IF;

  -- session-keyed children (visible iff the session is).
  FOREACH t IN ARRAY ARRAY['secret_findings','session_metadata','session_outcome_cache','compute_cache','raw_sessions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='author_visibility') THEN
      EXECUTE format($p$
        CREATE POLICY author_visibility ON %1$I AS RESTRICTIVE FOR SELECT USING (
          current_setting('app.viewer', true) = '*'
          OR EXISTS (SELECT 1 FROM memory_metadata m
                     WHERE m.tenant = %1$I.tenant AND m.id = %1$I.session_id AND m.source_type='session')
        )$p$, t);
    END IF;
  END LOOP;

  -- project-keyed children (code intel): visible iff the viewer sees any session in the project.
  FOREACH t IN ARRAY ARRAY['code_projects','code_findings','code_hotspots','code_actions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='author_visibility') THEN
      EXECUTE format($p$
        CREATE POLICY author_visibility ON %1$I AS RESTRICTIVE FOR SELECT USING (
          current_setting('app.viewer', true) = '*'
          OR EXISTS (SELECT 1 FROM memory_metadata m
                     WHERE m.tenant = %1$I.tenant AND m.project_id = %1$I.project_id)
        )$p$, t);
    END IF;
  END LOOP;

  -- kg_triples — a fact is visible if it's your own, legacy (NULL author), or
  -- extracted from a session you can see. An UNSOURCED fact is gated on author
  -- (NOT blanket-visible): recall_kg_add without a source must stay private to
  -- its author, else every member's ad-hoc facts leak to the team.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='kg_triples' AND policyname='author_visibility') THEN
    CREATE POLICY author_visibility ON kg_triples AS RESTRICTIVE FOR SELECT USING (
      current_setting('app.viewer', true) = '*'
      OR kg_triples.author_sub IS NULL
      OR kg_triples.author_sub = current_setting('app.viewer', true)
      OR (COALESCE(kg_triples.source_session,'') <> '' AND EXISTS (SELECT 1 FROM memory_metadata m
            WHERE m.tenant = kg_triples.tenant AND m.id = kg_triples.source_session AND m.source_type='session'))
    );
  END IF;

  -- diary_entries — same: own / legacy / from-a-visible-session. Unlinked
  -- entries are gated on author, not blanket-visible.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='diary_entries' AND policyname='author_visibility') THEN
    CREATE POLICY author_visibility ON diary_entries AS RESTRICTIVE FOR SELECT USING (
      current_setting('app.viewer', true) = '*'
      OR diary_entries.author_sub IS NULL
      OR diary_entries.author_sub = current_setting('app.viewer', true)
      OR (COALESCE(diary_entries.session_id,'') <> '' AND EXISTS (SELECT 1 FROM memory_metadata m
            WHERE m.tenant = diary_entries.tenant AND m.id = diary_entries.session_id AND m.source_type='session'))
    );
  END IF;
END $$;
`;
