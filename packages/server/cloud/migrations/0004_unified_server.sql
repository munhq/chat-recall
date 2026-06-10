-- 0004: cut the live cloud DB over to the unified server's engine schema.
--
-- The legacy sync API (server.mjs, image v1) used its own column shapes:
--   tenants(slug PK, display_name, created_at timestamptz)
--   agent_tokens(tenant_slug, …, timestamptz)
--   teams/memberships/invites(…timestamptz)
--   secret_findings(tenant_slug, …, verified_at timestamptz)
-- The unified server (image v2) reads/writes the engine shapes:
--   tenant column name everywhere, BIGINT ms epochs, secret_findings carries
--   scanned_at BIGINT + verified INTEGER.
--
-- Everything here is guarded on the OLD column existing, so the migration is
-- idempotent and a no-op on fresh databases (where the engine bootstrap
-- creates the new shapes directly).
--
-- Conversation content is NOT migrated: the legacy `conversations` blob table
-- stays as an archive; clients repopulate the engine index by re-running
-- `chat-recall sync --full`, which flows through the v2 ingest pipeline
-- (chunking + classification + FTS).

-- ── tenants ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tenants' AND column_name='slug') THEN
    ALTER TABLE tenants RENAME COLUMN slug TO tenant;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='tenants' AND column_name='created_at' AND data_type LIKE 'timestamp%') THEN
    ALTER TABLE tenants ALTER COLUMN created_at DROP DEFAULT;  -- DEFAULT now() cannot cast to bigint
    ALTER TABLE tenants ALTER COLUMN created_at TYPE BIGINT USING (extract(epoch FROM created_at) * 1000)::bigint;
  END IF;
END $$;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS display_name TEXT;
-- Legacy schema declared display_name NOT NULL; the engine treats it as
-- optional metadata and its bootstrap inserts (tenant, created_at) only.
ALTER TABLE tenants ALTER COLUMN display_name DROP NOT NULL;

-- The old schema RLS-walled nothing on tenants, but be explicit (the engine
-- bootstrap also enforces this): control-plane tables are not tenant-scoped.
DROP POLICY IF EXISTS tenant_isolation ON tenants;
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;

-- ── agent_tokens ───────────────────────────────────────────────────────────
DO $$ BEGIN
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
END $$;
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS user_sub TEXT;

-- ── teams / memberships / invites ──────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='teams' AND column_name='created_at' AND data_type LIKE 'timestamp%') THEN
    ALTER TABLE teams ALTER COLUMN created_at DROP DEFAULT;
    ALTER TABLE teams ALTER COLUMN created_at TYPE BIGINT USING (extract(epoch FROM created_at) * 1000)::bigint;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='memberships' AND column_name='created_at' AND data_type LIKE 'timestamp%') THEN
    ALTER TABLE memberships ALTER COLUMN created_at DROP DEFAULT;
    ALTER TABLE memberships ALTER COLUMN created_at TYPE BIGINT USING (extract(epoch FROM created_at) * 1000)::bigint;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='invites' AND column_name='expires_at' AND data_type LIKE 'timestamp%') THEN
    ALTER TABLE invites ALTER COLUMN expires_at DROP DEFAULT;
    ALTER TABLE invites ALTER COLUMN expires_at TYPE BIGINT USING (extract(epoch FROM expires_at) * 1000)::bigint;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='invites' AND column_name='used_at' AND data_type LIKE 'timestamp%') THEN
    ALTER TABLE invites ALTER COLUMN used_at DROP DEFAULT;
    ALTER TABLE invites ALTER COLUMN used_at TYPE BIGINT USING (extract(epoch FROM used_at) * 1000)::bigint;
  END IF;
END $$;

-- ── secret_findings ────────────────────────────────────────────────────────
-- Engine shape: (tenant, session_id, detector, rule, line, preview,
-- scanned_at BIGINT, verified INTEGER). Map verified_at → verified flag and
-- keep verified_at/created_at/project_path as legacy extras.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='secret_findings' AND column_name='tenant_slug') THEN
    ALTER TABLE secret_findings RENAME COLUMN tenant_slug TO tenant;
  END IF;
END $$;
ALTER TABLE secret_findings ADD COLUMN IF NOT EXISTS scanned_at BIGINT;
UPDATE secret_findings SET scanned_at = (extract(epoch FROM now()) * 1000)::bigint WHERE scanned_at IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='secret_findings' AND column_name='verified' AND data_type='integer') THEN
    ALTER TABLE secret_findings ADD COLUMN verified INTEGER;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='secret_findings' AND column_name='verified_at') THEN
      UPDATE secret_findings SET verified = CASE WHEN verified_at IS NOT NULL THEN 1 ELSE NULL END;
    END IF;
  END IF;
END $$;

-- Update the RLS policies on the renamed tables to the engine GUC name
-- ('app.tenant'); the engine bootstrap re-applies these on every boot too,
-- but the migrate step should leave a consistent state on its own.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations','secret_findings'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name=t AND column_name='tenant_slug') THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN tenant_slug TO tenant', t);
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name=t) THEN
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format($p$
        CREATE POLICY tenant_isolation ON %I
          USING (tenant = current_setting('app.tenant', true))
          WITH CHECK (tenant = current_setting('app.tenant', true))
      $p$, t);
    END IF;
  END LOOP;
END $$;

-- The v2 server may connect as the database owner (CNPG app role): FORCE RLS
-- keeps policies binding for the owner, and tenantQuery() sets the GUC per
-- transaction. Grants for the legacy app_user role are refreshed so either
-- DSN works during the cutover window.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
  END IF;
END $$;
