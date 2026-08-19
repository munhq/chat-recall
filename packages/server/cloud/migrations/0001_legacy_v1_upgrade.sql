-- 0001: upgrade a LEGACY cloud-v1 database to the unified server's shapes.
--
-- ── What owns the schema ────────────────────────────────────────────────────
--
-- Not this directory. `engine/src/core/store/pg-schema.ts` creates every table
-- (38 CREATE TABLE IF NOT EXISTS), enables and FORCEs row-level security, and
-- installs every policy — idempotently, on every server boot. A fresh database
-- gets its entire structure from there.
--
-- These files therefore exist for exactly two things: upgrading a database that
-- predates that bootstrap (this file), and one-off DATA repairs the bootstrap
-- cannot express (0002).
--
-- ── What this file is ──────────────────────────────────────────────────────
--
-- The legacy sync API (server.mjs, image v1) used different column shapes:
--   tenants(slug PK, display_name, created_at timestamptz)
--   agent_tokens(tenant_slug, …, timestamptz)
--   teams/memberships/invites(… timestamptz)
--   secret_findings(tenant_slug, …, verified_at timestamptz)
-- The unified server (image v2) reads the engine shapes: `tenant` everywhere,
-- BIGINT millisecond epochs, and secret_findings carrying scanned_at BIGINT +
-- verified INTEGER.
--
-- This consolidates what were four files. The three that CREATED the v1 shapes
-- are gone: nothing needs to create them any more, because the only database
-- that ever had them was upgraded in June 2026, and any new database gets modern
-- shapes from the bootstrap instead.
--
-- Every statement is guarded on the old table or column existing, so this is
-- idempotent and a complete no-op on any database that never ran v1 — including
-- an empty one, where it runs BEFORE the bootstrap has created anything.
--
-- Conversation content is deliberately NOT migrated: the legacy `conversations`
-- blob table stays as an archive, and clients repopulate the engine index with
-- `chat-recall sync --full`, which flows through the v2 ingest pipeline
-- (chunking + classification + FTS).

-- ── tenants ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='tenants') THEN
    RETURN;   -- fresh database: the bootstrap will create the modern shape
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tenants' AND column_name='slug') THEN
    ALTER TABLE tenants RENAME COLUMN slug TO tenant;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='tenants' AND column_name='created_at' AND data_type LIKE 'timestamp%') THEN
    ALTER TABLE tenants ALTER COLUMN created_at DROP DEFAULT;  -- DEFAULT now() cannot cast to bigint
    ALTER TABLE tenants ALTER COLUMN created_at TYPE BIGINT USING (extract(epoch FROM created_at) * 1000)::bigint;
  END IF;

  ALTER TABLE tenants ADD COLUMN IF NOT EXISTS display_name TEXT;
  -- v1 declared display_name NOT NULL; the engine treats it as optional metadata
  -- and its bootstrap inserts (tenant, created_at) only.
  ALTER TABLE tenants ALTER COLUMN display_name DROP NOT NULL;

  -- Control-plane tables are not tenant-scoped. This is also what lets 0002 walk
  -- the tenant list in order to set the tenant GUC per iteration.
  DROP POLICY IF EXISTS tenant_isolation ON tenants;
  ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
END $$;

-- ── agent_tokens ───────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='agent_tokens') THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agent_tokens' AND column_name='tenant_slug') THEN
    ALTER TABLE agent_tokens RENAME COLUMN tenant_slug TO tenant;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='agent_tokens' AND column_name='created_at' AND data_type LIKE 'timestamp%') THEN
    ALTER TABLE agent_tokens ALTER COLUMN created_at DROP DEFAULT;
    ALTER TABLE agent_tokens ALTER COLUMN created_at TYPE BIGINT USING (extract(epoch FROM created_at) * 1000)::bigint;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='agent_tokens' AND column_name='revoked_at' AND data_type LIKE 'timestamp%') THEN
    ALTER TABLE agent_tokens ALTER COLUMN revoked_at DROP DEFAULT;
    ALTER TABLE agent_tokens ALTER COLUMN revoked_at TYPE BIGINT USING (extract(epoch FROM revoked_at) * 1000)::bigint;
  END IF;
  ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS user_sub TEXT;
END $$;

-- ── teams / memberships / invites ──────────────────────────────────────────
DO $$
DECLARE
  spec TEXT[][] := ARRAY[['teams','created_at'],['memberships','created_at'],
                         ['invites','expires_at'],['invites','used_at']];
  i INT;
BEGIN
  FOR i IN 1 .. array_length(spec, 1) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = spec[i][1] AND column_name = spec[i][2]
                 AND data_type LIKE 'timestamp%') THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', spec[i][1], spec[i][2]);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE BIGINT USING (extract(epoch FROM %I) * 1000)::bigint',
                     spec[i][1], spec[i][2], spec[i][2]);
    END IF;
  END LOOP;
END $$;

-- ── secret_findings ────────────────────────────────────────────────────────
-- Engine shape: (tenant, session_id, detector, rule, line, preview,
-- scanned_at BIGINT, verified INTEGER). verified_at maps onto the verified flag;
-- verified_at / created_at / project_path stay as legacy extras.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='secret_findings') THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='secret_findings' AND column_name='tenant_slug') THEN
    ALTER TABLE secret_findings RENAME COLUMN tenant_slug TO tenant;
  END IF;
  ALTER TABLE secret_findings ADD COLUMN IF NOT EXISTS scanned_at BIGINT;
  UPDATE secret_findings SET scanned_at = (extract(epoch FROM now()) * 1000)::bigint WHERE scanned_at IS NULL;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='secret_findings' AND column_name='verified' AND data_type='integer') THEN
    ALTER TABLE secret_findings ADD COLUMN verified INTEGER;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='secret_findings' AND column_name='verified_at') THEN
      UPDATE secret_findings SET verified = CASE WHEN verified_at IS NOT NULL THEN 1 ELSE NULL END;
    END IF;
  END IF;
END $$;

-- ── RLS policies on the renamed legacy tables ──────────────────────────────
-- Move them onto the engine's GUC name. The bootstrap re-applies these on every
-- boot, but the migrate step should leave a consistent state on its own.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations','secret_findings'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = t AND column_name='tenant_slug') THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN tenant_slug TO tenant', t);
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant = current_setting('app.tenant', true))
        WITH CHECK (tenant = current_setting('app.tenant', true))
    $p$, t);
  END LOOP;
END $$;

-- ── legacy role grants ─────────────────────────────────────────────────────
-- The v2 server may connect as the database owner (the CNPG app role): FORCE RLS
-- keeps policies binding for the owner, and tenantQuery() sets the GUC per
-- transaction. Grants for the legacy app_user role are refreshed so either DSN
-- works during a cutover window.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
  END IF;
END $$;
