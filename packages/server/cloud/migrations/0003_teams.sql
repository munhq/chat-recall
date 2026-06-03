-- Control plane for self-serve teams. A "team" reuses a tenant (tenant_slug);
-- users (Keycloak `sub`) belong to teams via memberships; invites are one-time
-- tokens. These are NOT tenant-RLS-walled — they map identity -> tenant, so the
-- server queries them by the verified user_sub / team_slug directly.

CREATE TABLE IF NOT EXISTS teams (
  slug        TEXT PRIMARY KEY REFERENCES tenants(slug) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  owner_sub   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  user_sub    TEXT NOT NULL,
  team_slug   TEXT NOT NULL REFERENCES teams(slug) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  email       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_sub, team_slug)
);
CREATE INDEX IF NOT EXISTS idx_memberships_team ON memberships(team_slug);

CREATE TABLE IF NOT EXISTS invites (
  token_hash  TEXT PRIMARY KEY,                 -- sha256(raw invite token)
  team_slug   TEXT NOT NULL REFERENCES teams(slug) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  email_hint  TEXT,
  created_by  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_invites_team ON invites(team_slug);

-- agent_tokens links a device token to a tenant; record which user minted it so
-- members can list/revoke their own devices.
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS user_sub TEXT;

GRANT SELECT, INSERT, UPDATE, DELETE ON teams, memberships, invites TO app_user;
