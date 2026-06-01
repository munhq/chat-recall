-- Cleartrace cloud — shared Postgres, per-tenant via RLS.
-- Run as superuser (owns tables). The API connects as the NOBYPASSRLS role
-- `app_user`, which is subject to RLS and can never see another tenant's rows.

-- ── Control plane ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  slug         TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_slug  TEXT NOT NULL REFERENCES tenants(slug) ON DELETE CASCADE,
  device_id    TEXT NOT NULL,
  token_hash   TEXT NOT NULL,          -- argon2id(raw token); raw shown once
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  UNIQUE (tenant_slug, device_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens(token_hash);

-- ── Tenant data (Option A: redacted conversations + findings) ────────────
CREATE TABLE IF NOT EXISTS conversations (
  tenant_slug   TEXT NOT NULL REFERENCES tenants(slug) ON DELETE CASCADE,
  session_id    TEXT NOT NULL,
  tool          TEXT,
  project_path  TEXT,
  redacted_text TEXT NOT NULL,         -- conversation with secret VALUES masked
  mtime         BIGINT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_slug, session_id)
);

CREATE TABLE IF NOT EXISTS secret_findings (
  tenant_slug   TEXT NOT NULL REFERENCES tenants(slug) ON DELETE CASCADE,
  session_id    TEXT NOT NULL,
  detector      TEXT NOT NULL,
  rule          TEXT NOT NULL,
  line          INT  NOT NULL,
  preview       TEXT NOT NULL,         -- '*****QVGY' — never the raw secret
  project_path  TEXT,
  verified_at   TIMESTAMPTZ,           -- "verified live at T"; no standing bool
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_slug, session_id, detector, rule, line)
);

-- ── Row-Level Security: the wall between tenants ─────────────────────────
-- app.tenant_slug is set per-transaction from the verified agent token,
-- server-side only. Unset → current_setting returns NULL → zero rows (fail closed).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations','secret_findings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_slug = current_setting('app.tenant_slug', true))
        WITH CHECK (tenant_slug = current_setting('app.tenant_slug', true))
    $p$, t);
  END LOOP;
END $$;

-- ── The API role: subject to RLS, cannot bypass ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app' NOBYPASSRLS;
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON conversations, secret_findings, tenants, agent_tokens TO app_user;
