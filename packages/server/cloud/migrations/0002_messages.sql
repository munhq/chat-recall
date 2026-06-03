-- Full conversations in the cloud: one row per redacted turn, tenant-walled.
CREATE TABLE IF NOT EXISTS messages (
  tenant_slug   TEXT NOT NULL REFERENCES tenants(slug) ON DELETE CASCADE,
  session_id    TEXT NOT NULL,
  seq           INT  NOT NULL,
  role          TEXT NOT NULL,         -- user|assistant|tool
  tool          TEXT,                  -- tool name for tool turns
  redacted_text TEXT NOT NULL,         -- secrets masked client-side
  ts            BIGINT,
  PRIMARY KEY (tenant_slug, session_id, seq)
);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON messages;
CREATE POLICY tenant_isolation ON messages
  USING (tenant_slug = current_setting('app.tenant_slug', true))
  WITH CHECK (tenant_slug = current_setting('app.tenant_slug', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON messages TO app_user;
