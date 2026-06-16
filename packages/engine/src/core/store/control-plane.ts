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
import { openPgPool, tenantQuery } from './pg-pool.js';
import { getCacheDbPath } from '../paths.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export interface AgentTokenInfo { tenant: string; deviceId: string }

/**
 * Per-tenant subscription state — the billing spine. A tenant is "entitled"
 * (may use the paid surface) when status is active/trialing AND the period
 * hasn't lapsed. Mirrors Stripe's subscription lifecycle so a webhook can map
 * straight onto it.
 *
 * `status: 'none'` is the explicit not-subscribed state (no Stripe customer
 * yet) — distinct from a row simply being absent, which getEntitlement returns
 * as null. Both mean "not entitled" on cloud; the enforcement lives in the
 * server's billing util, not here (the store is provider-agnostic).
 */
export type EntitlementStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';
export interface Entitlement {
  tenant: string;
  plan: string | null;
  status: EntitlementStatus;
  currentPeriodEnd: number | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}
export interface Membership { team_slug: string; name: string; role: 'owner' | 'member' }
export interface TeamMember { user_sub: string; email: string | null; role: string; created_at: number }

export interface ArtifactMeta {
  id: string;
  type: string;
  tool: string;
  name: string;
  version: number;
  authorId: string;
  sha256: string;
  pinnedTo: string | null;
  updatedAt: number;
  bytes: number;
}
export interface ArtifactBody extends ArtifactMeta { bodyB64: string }

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

  /**
   * Remove a tenant and everything keyed to it: control-plane rows (tokens,
   * team, memberships, invites, artifacts) AND the tenant's data rows in the
   * tenant-scoped stores. Admin-only surface — used to purge test tenants.
   * Returns false when the tenant doesn't exist.
   */
  deleteTenant(tenant: string): Promise<boolean>;

  // ── Team toolkit artifacts ──
  /** Publish (or re-publish: version bump in place) an artifact. */
  publishArtifact(teamSlug: string, a: { type: string; tool: string; name: string; bodyB64: string; pinnedTo?: string | null; authorSub: string }): Promise<ArtifactMeta>;
  /** Latest non-revoked artifacts (metadata only). */
  listArtifacts(teamSlug: string): Promise<ArtifactMeta[]>;
  /** Changes since `sinceMs`: updated artifacts with bodies + revoked ids. */
  pullArtifacts(teamSlug: string, sinceMs: number, limit?: number): Promise<{ pulled: ArtifactBody[]; removed: string[] }>;
  /** Soft-revoke; returns the artifact identity or null when unknown. */
  revokeArtifact(teamSlug: string, artifactId: string): Promise<{ id: string; type: string; name: string } | null>;

  // ── Billing / entitlement ──
  /** Current subscription state for a tenant, or null if never recorded. */
  getEntitlement(tenant: string): Promise<Entitlement | null>;
  /**
   * Upsert subscription state. Partial: only the supplied fields change, the
   * rest are preserved (Stripe webhooks arrive piecemeal — e.g. a
   * subscription.updated carries status + period but not the customer id we
   * already stored at checkout). `tenant` is the key and is required via the
   * method arg, so the patch never needs to carry it.
   */
  setEntitlement(tenant: string, e: Partial<Omit<Entitlement, 'tenant'>>): Promise<void>;

  // ── Tenant settings ──
  getTenantSetting(tenant: string, key: string): Promise<string | null>;
  setTenantSetting(tenant: string, key: string, value: string): Promise<void>;

  close(): Promise<void>;
}

/** Deterministic artifact id: same (team,type,tool,name) ⇒ same id, so
 *  re-publishing bumps the version instead of multiplying rows. */
function artifactId(teamSlug: string, type: string, tool: string, name: string): string {
  return 'a_' + sha256(`${teamSlug}|${type}|${tool}|${name}`).slice(0, 16);
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
      CREATE TABLE IF NOT EXISTS cp_team_artifacts (
        team_slug TEXT NOT NULL, id TEXT NOT NULL,
        type TEXT NOT NULL, tool TEXT NOT NULL, name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, author_sub TEXT NOT NULL,
        sha256 TEXT NOT NULL, pinned_to TEXT, body_b64 TEXT NOT NULL,
        bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL, revoked_at INTEGER,
        PRIMARY KEY (team_slug, id)
      );
      CREATE INDEX IF NOT EXISTS idx_cp_artifacts_updated ON cp_team_artifacts(team_slug, updated_at);
      CREATE TABLE IF NOT EXISTS cp_entitlements (
        tenant                 TEXT PRIMARY KEY,
        plan                   TEXT,
        status                 TEXT,
        current_period_end     INTEGER,
        stripe_customer_id     TEXT,
        stripe_subscription_id TEXT,
        updated_at             INTEGER
      );
      CREATE TABLE IF NOT EXISTS cp_tenant_settings (
        tenant     TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant, key)
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

  async publishArtifact(teamSlug: string, a: { type: string; tool: string; name: string; bodyB64: string; pinnedTo?: string | null; authorSub: string }): Promise<ArtifactMeta> {
    const id = artifactId(teamSlug, a.type, a.tool, a.name);
    const raw = Buffer.from(a.bodyB64, 'base64');
    const digest = sha256(raw.toString('binary'));
    const now = Date.now();
    const existing = this.db.prepare(`SELECT version FROM cp_team_artifacts WHERE team_slug = ? AND id = ?`).get(teamSlug, id) as { version: number } | undefined;
    const version = (existing?.version ?? 0) + 1;
    this.db.prepare(
      `INSERT INTO cp_team_artifacts (team_slug, id, type, tool, name, version, author_sub, sha256, pinned_to, body_b64, bytes, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (team_slug, id) DO UPDATE SET
         version=excluded.version, author_sub=excluded.author_sub, sha256=excluded.sha256,
         pinned_to=excluded.pinned_to, body_b64=excluded.body_b64, bytes=excluded.bytes,
         updated_at=excluded.updated_at, revoked_at=NULL`,
    ).run(teamSlug, id, a.type, a.tool, a.name, version, a.authorSub, digest, a.pinnedTo ?? null, a.bodyB64, raw.length, now);
    return { id, type: a.type, tool: a.tool, name: a.name, version, authorId: a.authorSub, sha256: digest, pinnedTo: a.pinnedTo ?? null, updatedAt: now, bytes: raw.length };
  }

  async listArtifacts(teamSlug: string): Promise<ArtifactMeta[]> {
    return (this.db.prepare(
      `SELECT id, type, tool, name, version, author_sub, sha256, pinned_to, updated_at, bytes
       FROM cp_team_artifacts WHERE team_slug = ? AND revoked_at IS NULL ORDER BY type, name`,
    ).all(teamSlug) as any[]).map(rowToMeta);
  }

  async pullArtifacts(teamSlug: string, sinceMs: number, limit = 500): Promise<{ pulled: ArtifactBody[]; removed: string[] }> {
    const pulled = (this.db.prepare(
      `SELECT id, type, tool, name, version, author_sub, sha256, pinned_to, updated_at, bytes, body_b64
       FROM cp_team_artifacts WHERE team_slug = ? AND revoked_at IS NULL AND updated_at > ?
       ORDER BY updated_at ASC LIMIT ?`,
    ).all(teamSlug, sinceMs, limit) as any[]).map((r) => ({ ...rowToMeta(r), bodyB64: r.body_b64 }));
    const removed = (this.db.prepare(
      `SELECT id FROM cp_team_artifacts WHERE team_slug = ? AND revoked_at IS NOT NULL AND revoked_at > ?`,
    ).all(teamSlug, sinceMs) as any[]).map((r) => r.id as string);
    return { pulled, removed };
  }

  async revokeArtifact(teamSlug: string, artifactIdArg: string): Promise<{ id: string; type: string; name: string } | null> {
    const row = this.db.prepare(`SELECT id, type, name FROM cp_team_artifacts WHERE team_slug = ? AND id = ?`).get(teamSlug, artifactIdArg) as { id: string; type: string; name: string } | undefined;
    if (!row) return null;
    this.db.prepare(`UPDATE cp_team_artifacts SET revoked_at = ? WHERE team_slug = ? AND id = ?`).run(Date.now(), teamSlug, artifactIdArg);
    return row;
  }

  async getEntitlement(tenant: string): Promise<Entitlement | null> {
    const r = this.db.prepare(
      `SELECT tenant, plan, status, current_period_end, stripe_customer_id, stripe_subscription_id
       FROM cp_entitlements WHERE tenant = ?`,
    ).get(tenant) as Record<string, unknown> | undefined;
    return r ? rowToEntitlement(r) : null;
  }

  async setEntitlement(tenant: string, e: Partial<Omit<Entitlement, 'tenant'>>): Promise<void> {
    // Read-modify-write so a partial patch preserves untouched columns. SQLite
    // is synchronous and single-writer here, so there's no interleaving to fear
    // between the SELECT and the upsert within this process.
    const prev = await this.getEntitlement(tenant);
    const next = mergeEntitlement(tenant, prev, e);
    this.db.prepare(
      `INSERT INTO cp_entitlements
         (tenant, plan, status, current_period_end, stripe_customer_id, stripe_subscription_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant) DO UPDATE SET
         plan=excluded.plan, status=excluded.status, current_period_end=excluded.current_period_end,
         stripe_customer_id=excluded.stripe_customer_id, stripe_subscription_id=excluded.stripe_subscription_id,
         updated_at=excluded.updated_at`,
    ).run(
      next.tenant, next.plan, next.status, next.currentPeriodEnd,
      next.stripeCustomerId, next.stripeSubscriptionId, Date.now(),
    );
  }

  async getTenantSetting(tenant: string, key: string): Promise<string | null> {
    const r = this.db.prepare(`SELECT value FROM cp_tenant_settings WHERE tenant = ? AND key = ?`).get(tenant, key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  async setTenantSetting(tenant: string, key: string, value: string): Promise<void> {
    this.db.prepare(`INSERT INTO cp_tenant_settings (tenant, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (tenant, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(tenant, key, value, Date.now());
  }

  async deleteTenant(tenant: string): Promise<boolean> {
    const exists = this.db.prepare(`SELECT 1 FROM cp_tenants WHERE tenant = ?`).get(tenant);
    if (!exists) return false;
    // Control-plane rows. The sqlite backend is single-box: tenant-scoped
    // data tables have no tenant column, so there is nothing more to purge —
    // documented limitation of sqlite mode (one logical tenant per volume).
    this.db.prepare(`DELETE FROM cp_agent_tokens     WHERE tenant = ?`).run(tenant);
    this.db.prepare(`DELETE FROM cp_memberships      WHERE team_slug = ?`).run(tenant);
    this.db.prepare(`DELETE FROM cp_invites          WHERE team_slug = ?`).run(tenant);
    this.db.prepare(`DELETE FROM cp_team_artifacts   WHERE team_slug = ?`).run(tenant);
    this.db.prepare(`DELETE FROM cp_entitlements     WHERE tenant = ?`).run(tenant);
    this.db.prepare(`DELETE FROM cp_tenant_settings  WHERE tenant = ?`).run(tenant);
    this.db.prepare(`DELETE FROM cp_teams            WHERE slug = ?`).run(tenant);
    this.db.prepare(`DELETE FROM cp_tenants          WHERE tenant = ?`).run(tenant);
    return true;
  }

  async close(): Promise<void> { this.db.close(); }
}

/** Shared row → ArtifactMeta mapping (column names match in both backends). */
function rowToMeta(r: any): ArtifactMeta {
  return {
    id: r.id, type: r.type, tool: r.tool, name: r.name, version: r.version,
    authorId: r.author_sub, sha256: r.sha256, pinnedTo: r.pinned_to ?? null,
    updatedAt: r.updated_at, bytes: r.bytes,
  };
}

const ENTITLEMENT_STATUSES: ReadonlySet<string> = new Set([
  'active', 'trialing', 'past_due', 'canceled', 'none',
]);

/** Narrow an untrusted DB/string value to a known status, defaulting to 'none'
 *  so a corrupt/unknown value fails CLOSED (not entitled) rather than open. */
function coerceStatus(s: unknown): EntitlementStatus {
  return typeof s === 'string' && ENTITLEMENT_STATUSES.has(s) ? (s as EntitlementStatus) : 'none';
}

/** Shared row → Entitlement mapping (column names match in both backends). */
function rowToEntitlement(r: Record<string, unknown>): Entitlement {
  return {
    tenant: String(r.tenant),
    plan: (r.plan as string | null) ?? null,
    status: coerceStatus(r.status),
    currentPeriodEnd: r.current_period_end == null ? null : Number(r.current_period_end),
    stripeCustomerId: (r.stripe_customer_id as string | null) ?? null,
    stripeSubscriptionId: (r.stripe_subscription_id as string | null) ?? null,
  };
}

/** Fold a partial patch onto the previous row (or sane defaults if none),
 *  shared by both backends so upsert semantics can't drift between them. */
function mergeEntitlement(
  tenant: string,
  prev: Entitlement | null,
  patch: Partial<Omit<Entitlement, 'tenant'>>,
): Entitlement {
  const base: Entitlement = prev ?? {
    tenant, plan: null, status: 'none', currentPeriodEnd: null,
    stripeCustomerId: null, stripeSubscriptionId: null,
  };
  return {
    tenant,
    plan: patch.plan !== undefined ? patch.plan : base.plan,
    status: patch.status !== undefined ? coerceStatus(patch.status) : base.status,
    currentPeriodEnd: patch.currentPeriodEnd !== undefined ? patch.currentPeriodEnd : base.currentPeriodEnd,
    stripeCustomerId: patch.stripeCustomerId !== undefined ? patch.stripeCustomerId : base.stripeCustomerId,
    stripeSubscriptionId: patch.stripeSubscriptionId !== undefined ? patch.stripeSubscriptionId : base.stripeSubscriptionId,
  };
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

  async publishArtifact(teamSlug: string, a: { type: string; tool: string; name: string; bodyB64: string; pinnedTo?: string | null; authorSub: string }): Promise<ArtifactMeta> {
    const id = artifactId(teamSlug, a.type, a.tool, a.name);
    const raw = Buffer.from(a.bodyB64, 'base64');
    const digest = sha256(raw.toString('binary'));
    const now = Date.now();
    const existing = (await this.q(`SELECT version FROM team_artifacts WHERE team_slug = $1 AND id = $2`, [teamSlug, id]))[0];
    const version = ((existing?.version as number) ?? 0) + 1;
    await this.q(
      `INSERT INTO team_artifacts (team_slug, id, type, tool, name, version, author_sub, sha256, pinned_to, body_b64, bytes, updated_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL)
       ON CONFLICT (team_slug, id) DO UPDATE SET
         version=excluded.version, author_sub=excluded.author_sub, sha256=excluded.sha256,
         pinned_to=excluded.pinned_to, body_b64=excluded.body_b64, bytes=excluded.bytes,
         updated_at=excluded.updated_at, revoked_at=NULL`,
      [teamSlug, id, a.type, a.tool, a.name, version, a.authorSub, digest, a.pinnedTo ?? null, a.bodyB64, raw.length, now],
    );
    return { id, type: a.type, tool: a.tool, name: a.name, version, authorId: a.authorSub, sha256: digest, pinnedTo: a.pinnedTo ?? null, updatedAt: now, bytes: raw.length };
  }

  async listArtifacts(teamSlug: string): Promise<ArtifactMeta[]> {
    const rows = await this.q(
      `SELECT id, type, tool, name, version, author_sub, sha256, pinned_to, updated_at, bytes
       FROM team_artifacts WHERE team_slug = $1 AND revoked_at IS NULL ORDER BY type, name`,
      [teamSlug],
    );
    return rows.map(rowToMeta);
  }

  async pullArtifacts(teamSlug: string, sinceMs: number, limit = 500): Promise<{ pulled: ArtifactBody[]; removed: string[] }> {
    const pulled = (await this.q(
      `SELECT id, type, tool, name, version, author_sub, sha256, pinned_to, updated_at, bytes, body_b64
       FROM team_artifacts WHERE team_slug = $1 AND revoked_at IS NULL AND updated_at > $2
       ORDER BY updated_at ASC LIMIT $3`,
      [teamSlug, sinceMs, limit],
    )).map((r: any) => ({ ...rowToMeta(r), bodyB64: r.body_b64 }));
    const removed = (await this.q(
      `SELECT id FROM team_artifacts WHERE team_slug = $1 AND revoked_at IS NOT NULL AND revoked_at > $2`,
      [teamSlug, sinceMs],
    )).map((r: any) => r.id as string);
    return { pulled, removed };
  }

  async revokeArtifact(teamSlug: string, artifactIdArg: string): Promise<{ id: string; type: string; name: string } | null> {
    const row = (await this.q(`SELECT id, type, name FROM team_artifacts WHERE team_slug = $1 AND id = $2`, [teamSlug, artifactIdArg]))[0];
    if (!row) return null;
    await this.q(`UPDATE team_artifacts SET revoked_at = $1 WHERE team_slug = $2 AND id = $3`, [Date.now(), teamSlug, artifactIdArg]);
    return { id: row.id, type: row.type, name: row.name };
  }

  async getEntitlement(tenant: string): Promise<Entitlement | null> {
    const r = (await this.q(
      `SELECT tenant, plan, status, current_period_end, stripe_customer_id, stripe_subscription_id
       FROM entitlements WHERE tenant = $1`,
      [tenant],
    ))[0] as Record<string, unknown> | undefined;
    return r ? rowToEntitlement(r) : null;
  }

  async setEntitlement(tenant: string, e: Partial<Omit<Entitlement, 'tenant'>>): Promise<void> {
    const prev = await this.getEntitlement(tenant);
    const next = mergeEntitlement(tenant, prev, e);
    await this.q(
      `INSERT INTO entitlements
         (tenant, plan, status, current_period_end, stripe_customer_id, stripe_subscription_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant) DO UPDATE SET
         plan=excluded.plan, status=excluded.status, current_period_end=excluded.current_period_end,
         stripe_customer_id=excluded.stripe_customer_id, stripe_subscription_id=excluded.stripe_subscription_id,
         updated_at=excluded.updated_at`,
      [
        next.tenant, next.plan, next.status, next.currentPeriodEnd,
        next.stripeCustomerId, next.stripeSubscriptionId, Date.now(),
      ],
    );
  }

  async getTenantSetting(tenant: string, key: string): Promise<string | null> {
    const r = (await this.q(`SELECT value FROM tenant_settings WHERE tenant = $1 AND key = $2`, [tenant, key]))[0] as { value: string } | undefined;
    return r?.value ?? null;
  }

  async setTenantSetting(tenant: string, key: string, value: string): Promise<void> {
    await this.q(
      `INSERT INTO tenant_settings (tenant, key, value, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [tenant, key, value, Date.now()],
    );
  }

  async deleteTenant(tenant: string): Promise<boolean> {
    const exists = (await this.q(`SELECT 1 FROM tenants WHERE tenant = $1`, [tenant]))[0];
    if (!exists) return false;
    // Tenant-scoped data tables (these all carry a `tenant` column in pg).
    // Connection role is the table owner / superuser-ish migrator, but rows
    // are deleted with an explicit predicate — no GUC games needed since we
    // bypass tenantQuery on purpose for this admin operation.
    for (const t of [
      'memory_metadata', 'memory_links', 'content_cache', 'kv_store', 'memory_chunks',
      'secret_findings', 'secret_rules', 'secret_dismissals', 'session_metadata',
      'summary_errors', 'compute_cache', 'session_outcome_cache', 'kg_entities',
      'kg_triples', 'wal_log', 'diary_entries',
    ]) {
      // FORCE RLS applies to the owner too — scope the GUC to this tenant so
      // the policy permits the delete.
      await tenantQuery(this.pool, tenant, `DELETE FROM ${t} WHERE tenant = $1`, [tenant]);
    }
    try { await tenantQuery(this.pool, tenant, `DELETE FROM memory_vectors WHERE tenant = $1`, [tenant]); } catch { /* table absent without pgvector */ }
    // Control-plane rows (not RLS-walled).
    await this.q(`DELETE FROM agent_tokens     WHERE tenant = $1`, [tenant]);
    await this.q(`DELETE FROM memberships      WHERE team_slug = $1`, [tenant]);
    await this.q(`DELETE FROM invites          WHERE team_slug = $1`, [tenant]);
    await this.q(`DELETE FROM team_artifacts   WHERE team_slug = $1`, [tenant]);
    await this.q(`DELETE FROM entitlements     WHERE tenant = $1`, [tenant]);
    await this.q(`DELETE FROM tenant_settings  WHERE tenant = $1`, [tenant]);
    await this.q(`DELETE FROM teams            WHERE slug = $1`, [tenant]);
    await this.q(`DELETE FROM tenants          WHERE tenant = $1`, [tenant]);
    return true;
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
