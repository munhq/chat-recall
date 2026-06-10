/**
 * Control plane — identity → tenant mapping behind the storage flag.
 *
 * Holds what the server consults BEFORE any tenant-scoped query runs:
 *   - tenants        (slug + display name)
 *   - agent_tokens   (device sync tokens; sha256(raw) stored, raw shown once)
 *   - teams / memberships / invites (Keycloak `sub` → team → tenant)
 *
 * A team IS a tenant: `team.slug` doubles as the tenant id used by every
 * tenant-scoped store. Self-host single-user mode never creates teams —
 * everything lives under tenant 'default' and tokens are minted with the
 * admin key.
 *
 *   storage: sqlite   → tables in cache.db (single-box self-host)
 *   storage: postgres → tables from pg-schema.ts (SaaS / team self-host)
 *
 * Same factory pattern as the other drivers (store/index.ts). Token shapes
 * mirror the original cloud server.mjs: `ct_<48 hex>` device tokens,
 * `inv_<48 hex>` single-use invites (7-day expiry).
 */

import { createHash, randomBytes } from 'crypto';
import Database from 'better-sqlite3';
import { resolveBackend, type CreateStoreOptions } from './index.js';
import { openPgPool } from './pg-pool.js';
import { getCacheDbPath } from '../paths.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export interface AgentTokenInfo { tenant: string; deviceId: string }
export interface Membership { team_slug: string; name: string; role: 'owner' | 'member' }
export interface TeamMember { user_sub: string; email: string | null; role: string; created_at: number }

export interface ControlPlane {
  ensureTenant(tenant: string, displayName?: string): Promise<void>;
  /** Resolve a raw bearer token → tenant/device, or null (unknown / revoked). */
  resolveAgentToken(rawToken: string): Promise<AgentTokenInfo | null>;
  /** Mint (or rotate) a device token. Returns the raw token — shown once. */
  mintAgentToken(tenant: string, deviceId: string, userSub?: string): Promise<string>;
  revokeAgentToken(tenant: string, deviceId: string): Promise<boolean>;

  createTeam(name: string, ownerSub: string, ownerEmail?: string | null): Promise<{ slug: string; name: string }>;
  listMemberships(userSub: string): Promise<Membership[]>;
  roleOf(userSub: string, teamSlug: string): Promise<'owner' | 'member' | null>;
  createInvite(teamSlug: string, role: 'owner' | 'member', emailHint: string | null, createdBy: string): Promise<{ invite: string; expiresAt: number }>;
  redeemInvite(userSub: string, email: string | null, rawInvite: string): Promise<Membership | null>;
  listMembers(teamSlug: string): Promise<TeamMember[]>;
  close(): Promise<void>;
}

/** Team slug: readable prefix + 6 hex chars of entropy (matches server.mjs). */
function slugify(name: string): string {
  return (
    (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'team') +
    '-' + randomBytes(3).toString('hex')
  );
}

// ──────────────────────────────────────────────────────────────────
// SQLite
// ──────────────────────────────────────────────────────────────────

class SqliteControlPlane implements ControlPlane {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath || getCacheDbPath());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cp_tenants (
        tenant TEXT PRIMARY KEY, display_name TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cp_agent_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant TEXT NOT NULL, device_id TEXT NOT NULL, token_hash TEXT NOT NULL,
        user_sub TEXT, created_at INTEGER NOT NULL, revoked_at INTEGER,
        UNIQUE (tenant, device_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cp_tokens_hash ON cp_agent_tokens(token_hash);
      CREATE TABLE IF NOT EXISTS cp_teams (
        slug TEXT PRIMARY KEY, name TEXT NOT NULL, owner_sub TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cp_memberships (
        user_sub TEXT NOT NULL, team_slug TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member', email TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY (user_sub, team_slug)
      );
      CREATE TABLE IF NOT EXISTS cp_invites (
        token_hash TEXT PRIMARY KEY, team_slug TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member', email_hint TEXT, created_by TEXT NOT NULL,
        expires_at INTEGER NOT NULL, used_at INTEGER
      );
    `);
  }

  async ensureTenant(tenant: string, displayName?: string): Promise<void> {
    this.db.prepare(`INSERT OR IGNORE INTO cp_tenants (tenant, display_name, created_at) VALUES (?, ?, ?)`)
      .run(tenant, displayName ?? tenant, Date.now());
  }

  async resolveAgentToken(rawToken: string): Promise<AgentTokenInfo | null> {
    const r = this.db.prepare(
      `SELECT tenant, device_id FROM cp_agent_tokens WHERE token_hash = ? AND revoked_at IS NULL`,
    ).get(sha256(rawToken)) as { tenant: string; device_id: string } | undefined;
    return r ? { tenant: r.tenant, deviceId: r.device_id } : null;
  }

  async mintAgentToken(tenant: string, deviceId: string, userSub?: string): Promise<string> {
    await this.ensureTenant(tenant);
    const token = 'ct_' + randomBytes(24).toString('hex');
    this.db.prepare(
      `INSERT INTO cp_agent_tokens (tenant, device_id, token_hash, user_sub, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT (tenant, device_id) DO UPDATE SET token_hash=excluded.token_hash, user_sub=excluded.user_sub, revoked_at=NULL`,
    ).run(tenant, deviceId, sha256(token), userSub ?? null, Date.now());
    return token;
  }

  async revokeAgentToken(tenant: string, deviceId: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE cp_agent_tokens SET revoked_at = ? WHERE tenant = ? AND device_id = ? AND revoked_at IS NULL`,
    ).run(Date.now(), tenant, deviceId);
    return r.changes > 0;
  }

  async createTeam(name: string, ownerSub: string, ownerEmail?: string | null): Promise<{ slug: string; name: string }> {
    const slug = slugify(name);
    const now = Date.now();
    await this.ensureTenant(slug, name);
    this.db.prepare(`INSERT INTO cp_teams (slug, name, owner_sub, created_at) VALUES (?, ?, ?, ?)`)
      .run(slug, name, ownerSub, now);
    this.db.prepare(`INSERT INTO cp_memberships (user_sub, team_slug, role, email, created_at) VALUES (?, ?, 'owner', ?, ?)`)
      .run(ownerSub, slug, ownerEmail ?? null, now);
    return { slug, name };
  }

  async listMemberships(userSub: string): Promise<Membership[]> {
    return this.db.prepare(
      `SELECT m.team_slug, t.name, m.role FROM cp_memberships m JOIN cp_teams t ON t.slug = m.team_slug
       WHERE m.user_sub = ? ORDER BY t.name`,
    ).all(userSub) as Membership[];
  }

  async roleOf(userSub: string, teamSlug: string): Promise<'owner' | 'member' | null> {
    const r = this.db.prepare(`SELECT role FROM cp_memberships WHERE user_sub = ? AND team_slug = ?`)
      .get(userSub, teamSlug) as { role: 'owner' | 'member' } | undefined;
    return r?.role ?? null;
  }

  async createInvite(teamSlug: string, role: 'owner' | 'member', emailHint: string | null, createdBy: string): Promise<{ invite: string; expiresAt: number }> {
    const token = 'inv_' + randomBytes(24).toString('hex');
    const expiresAt = Date.now() + INVITE_TTL_MS;
    this.db.prepare(
      `INSERT INTO cp_invites (token_hash, team_slug, role, email_hint, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sha256(token), teamSlug, role, emailHint, createdBy, expiresAt);
    return { invite: token, expiresAt };
  }

  async redeemInvite(userSub: string, email: string | null, rawInvite: string): Promise<Membership | null> {
    const inv = this.db.prepare(
      `SELECT team_slug, role FROM cp_invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
    ).get(sha256(rawInvite), Date.now()) as { team_slug: string; role: 'owner' | 'member' } | undefined;
    if (!inv) return null;
    this.db.prepare(
      `INSERT OR IGNORE INTO cp_memberships (user_sub, team_slug, role, email, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(userSub, inv.team_slug, inv.role, email, Date.now());
    this.db.prepare(`UPDATE cp_invites SET used_at = ? WHERE token_hash = ?`).run(Date.now(), sha256(rawInvite));
    const team = this.db.prepare(`SELECT name FROM cp_teams WHERE slug = ?`).get(inv.team_slug) as { name: string } | undefined;
    return { team_slug: inv.team_slug, name: team?.name ?? inv.team_slug, role: inv.role };
  }

  async listMembers(teamSlug: string): Promise<TeamMember[]> {
    return this.db.prepare(
      `SELECT user_sub, email, role, created_at FROM cp_memberships WHERE team_slug = ? ORDER BY role DESC, created_at`,
    ).all(teamSlug) as TeamMember[];
  }

  async close(): Promise<void> { this.db.close(); }
}

// ──────────────────────────────────────────────────────────────────
// Postgres
// ──────────────────────────────────────────────────────────────────

class PgControlPlane implements ControlPlane {
  private pool: any;
  constructor(private readonly databaseUrl?: string) {}
  async init(): Promise<void> { this.pool = await openPgPool(this.databaseUrl); }
  private async q(sql: string, params: unknown[] = []): Promise<any[]> {
    return (await this.pool.query(sql, params)).rows;
  }

  async ensureTenant(tenant: string, displayName?: string): Promise<void> {
    await this.q(
      `INSERT INTO tenants (tenant, display_name, created_at) VALUES ($1, $2, $3) ON CONFLICT (tenant) DO NOTHING`,
      [tenant, displayName ?? tenant, Date.now()],
    );
  }

  async resolveAgentToken(rawToken: string): Promise<AgentTokenInfo | null> {
    const r = (await this.q(
      `SELECT tenant, device_id FROM agent_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
      [sha256(rawToken)],
    ))[0];
    return r ? { tenant: r.tenant, deviceId: r.device_id } : null;
  }

  async mintAgentToken(tenant: string, deviceId: string, userSub?: string): Promise<string> {
    await this.ensureTenant(tenant);
    const token = 'ct_' + randomBytes(24).toString('hex');
    await this.q(
      `INSERT INTO agent_tokens (tenant, device_id, token_hash, user_sub, created_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, NULL)
       ON CONFLICT (tenant, device_id) DO UPDATE SET token_hash=excluded.token_hash, user_sub=excluded.user_sub, revoked_at=NULL`,
      [tenant, deviceId, sha256(token), userSub ?? null, Date.now()],
    );
    return token;
  }

  async revokeAgentToken(tenant: string, deviceId: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE agent_tokens SET revoked_at = $1 WHERE tenant = $2 AND device_id = $3 AND revoked_at IS NULL`,
      [Date.now(), tenant, deviceId],
    );
    return (r.rowCount || 0) > 0;
  }

  async createTeam(name: string, ownerSub: string, ownerEmail?: string | null): Promise<{ slug: string; name: string }> {
    const slug = slugify(name);
    const now = Date.now();
    await this.ensureTenant(slug, name);
    await this.q(`INSERT INTO teams (slug, name, owner_sub, created_at) VALUES ($1, $2, $3, $4)`, [slug, name, ownerSub, now]);
    await this.q(
      `INSERT INTO memberships (user_sub, team_slug, role, email, created_at) VALUES ($1, $2, 'owner', $3, $4)`,
      [ownerSub, slug, ownerEmail ?? null, now],
    );
    return { slug, name };
  }

  async listMemberships(userSub: string): Promise<Membership[]> {
    return this.q(
      `SELECT m.team_slug, t.name, m.role FROM memberships m JOIN teams t ON t.slug = m.team_slug
       WHERE m.user_sub = $1 ORDER BY t.name`,
      [userSub],
    ) as Promise<Membership[]>;
  }

  async roleOf(userSub: string, teamSlug: string): Promise<'owner' | 'member' | null> {
    const r = (await this.q(`SELECT role FROM memberships WHERE user_sub = $1 AND team_slug = $2`, [userSub, teamSlug]))[0];
    return r?.role ?? null;
  }

  async createInvite(teamSlug: string, role: 'owner' | 'member', emailHint: string | null, createdBy: string): Promise<{ invite: string; expiresAt: number }> {
    const token = 'inv_' + randomBytes(24).toString('hex');
    const expiresAt = Date.now() + INVITE_TTL_MS;
    await this.q(
      `INSERT INTO invites (token_hash, team_slug, role, email_hint, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [sha256(token), teamSlug, role, emailHint, createdBy, expiresAt],
    );
    return { invite: token, expiresAt };
  }

  async redeemInvite(userSub: string, email: string | null, rawInvite: string): Promise<Membership | null> {
    const inv = (await this.q(
      `SELECT team_slug, role FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2`,
      [sha256(rawInvite), Date.now()],
    ))[0];
    if (!inv) return null;
    await this.q(
      `INSERT INTO memberships (user_sub, team_slug, role, email, created_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_sub, team_slug) DO NOTHING`,
      [userSub, inv.team_slug, inv.role, email, Date.now()],
    );
    await this.q(`UPDATE invites SET used_at = $1 WHERE token_hash = $2`, [Date.now(), sha256(rawInvite)]);
    const team = (await this.q(`SELECT name FROM teams WHERE slug = $1`, [inv.team_slug]))[0];
    return { team_slug: inv.team_slug, name: team?.name ?? inv.team_slug, role: inv.role };
  }

  async listMembers(teamSlug: string): Promise<TeamMember[]> {
    return this.q(
      `SELECT user_sub, email, role, created_at FROM memberships WHERE team_slug = $1 ORDER BY role DESC, created_at`,
      [teamSlug],
    ) as Promise<TeamMember[]>;
  }

  async close(): Promise<void> { /* shared pool — see pg-pool.ts closePgPools */ }
}

export async function createControlPlane(opts: CreateStoreOptions = {}): Promise<ControlPlane> {
  if (resolveBackend(opts) === 'postgres') {
    const cp = new PgControlPlane(opts.databaseUrl);
    await cp.init();
    return cp;
  }
  return new SqliteControlPlane(opts.sqlitePath);
}
