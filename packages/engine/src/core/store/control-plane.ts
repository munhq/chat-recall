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
import { openPgPool, ensurePgSchema, tenantQuery } from './pg-pool.js';
import { getCacheDbPath } from '../paths.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export interface AgentTokenInfo { tenant: string; deviceId: string; userSub: string | null }
/**
 * Device metadata for the Account "Devices" card.
 *
 * `lastSeenAt` / `cliVersion` / `os` are stamped by the server on every
 * authenticated data-plane request (see touchAgentToken) — without them a stale
 * or dead machine is invisible: it simply stops syncing and nothing anywhere
 * says so. They are nullable because a device that hasn't checked in since the
 * columns were added has never reported.
 */
export interface AgentTokenMeta {
  deviceId: string;
  createdAt: number;
  revoked: boolean;
  lastSeenAt: number | null;
  cliVersion: string | null;
  os: string | null;
}

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
  /**
   * Seats the subscription is billed for. Null when nothing has recorded one —
   * a trial, or a subscription predating this column.
   *
   * It exists because checkout was the ONLY place seats were ever checked: the
   * count was validated against real members when buying and then forgotten, so
   * a team could buy two seats and invite twenty. Persisting the quantity is
   * what lets the invite path enforce it.
   */
  seats: number | null;
}
/**
 * A self-host licence. The SERIAL is what the customer holds; it carries no grant,
 * so issuing one needs no signing key. The grant is assembled at activation.
 *
 * Not tenant-scoped: a self-hosted customer has no tenant on our side. That is why
 * these rows live in the control plane and carry no `tenant` column.
 */
export interface Licence {
  serial: string;
  email: string | null;
  holder: string | null;
  /** Comma-separated feature names, as issued. */
  features: string;
  seats: number | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  status: 'active' | 'revoked';
  createdAt: number;
  updatedAt: number;
}

/** One appended audit record. `payload` is already redacted by the writer. */
export interface AuditEntry {
  id: number;
  ts: number;
  operation: string;
  payload: unknown;
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

/**
 * Where a tenant came from, captured on the marketing site before the tenant
 * existed. Written on the INSERT and never on a conflict — see ensureTenant.
 */
export interface SignupAttribution {
  source: string;
  referrer?: string | null;
  campaign?: string | null;
  /** Joins this tenant to the analytics session that preceded its signup. */
  anonId?: string | null;
}

export interface ControlPlane {
  /**
   * Create the tenant row if absent.
   *
   * `attribution` is applied ONLY when this call actually inserts. ensureTenant
   * is called on nearly every authenticated path (mintAgentToken calls it too),
   * so applying it on conflict would overwrite the first touch with whatever
   * cookie the current request happens to carry — which is last-touch
   * attribution wearing a first-touch label, and it would quietly credit
   * `direct` for everything.
   */
  ensureTenant(tenant: string, displayName?: string, attribution?: SignupAttribution): Promise<void>;
  /** Resolve a raw bearer token → tenant/device, or null (unknown / revoked). */
  resolveAgentToken(rawToken: string): Promise<AgentTokenInfo | null>;
  /** Mint (or rotate) a device token. Returns the raw token — shown once. */
  mintAgentToken(tenant: string, deviceId: string, userSub?: string): Promise<string>;
  revokeAgentToken(tenant: string, deviceId: string): Promise<boolean>;
  /**
   * Record that `deviceId` just talked to us, and with which CLI. Called
   * (throttled) from the auth layer on every device-token request — this is the
   * ONLY source of "is that machine alive, and is it current?".
   */
  touchAgentToken(tenant: string, deviceId: string, meta?: { cliVersion?: string | null; os?: string | null }): Promise<void>;
  /** Devices with a token (active or revoked) — metadata only, never hashes. */
  listAgentTokens(tenant: string): Promise<AgentTokenMeta[]>;

  /**
   * Create a team, which IS a tenant — this is where a SaaS tenant is born.
   *
   * `attribution` reaches `ensureTenant`, which applies it only on the INSERT.
   * The overwhelming majority of tenants are created by the auto-provision in
   * middleware/auth.ts on a user's first authenticated request, so that is the
   * call site whose cookie actually decides a launch's numbers.
   */
  createTeam(
    name: string,
    ownerSub: string,
    ownerEmail?: string | null,
    attribution?: SignupAttribution,
    /** Derive the slug from the owner instead of randomly, so a concurrent
     *  duplicate collides on the primary key rather than creating a second
     *  workspace. Used by the first-request auto-provision; never by an explicit
     *  "create a team" action, where two same-named teams must be allowed. */
    ownerKeyed?: boolean,
  ): Promise<{ slug: string; name: string }>;
  listMemberships(userSub: string): Promise<Membership[]>;
  roleOf(userSub: string, teamSlug: string): Promise<'owner' | 'member' | null>;
  createInvite(teamSlug: string, role: 'owner' | 'member', emailHint: string | null, createdBy: string): Promise<{ invite: string; expiresAt: number }>;
  /**
   * Resolve an invite WITHOUT consuming it, so the caller can check the target
   * tenant's entitlement before adding a person to it. Redeeming is the moment
   * a tenant gains a second member, and an invite outlives the entitlement that
   * minted it — a lapsed licence or a cancelled subscription left every
   * outstanding invite redeemable. Same validity rules as redeemInvite: unused
   * and unexpired, or null.
   */
  peekInvite(rawInvite: string): Promise<{ team_slug: string; role: 'owner' | 'member' } | null>;
  redeemInvite(userSub: string, email: string | null, rawInvite: string): Promise<Membership | null>;
  listMembers(teamSlug: string): Promise<TeamMember[]>;

  /**
   * Does this team have at least one member whose email address is confirmed?
   *
   * Gates the no-card trial. Sign-up and sign-in stay open to an unconfirmed
   * address — better-auth's own requireEmailVerification would block the FIRST
   * login, so one flaky SMTP send locks a new user out of an account they just
   * created. What an unconfirmed address must not do is spend money: the trial
   * is what grants ingest, embeddings and summaries, so it waits for a confirmed
   * address instead.
   *
   * Social sign-ins arrive verified from the provider, so they are unaffected.
   * Self-host has no auth provider to ask, and returns true.
   */
  hasVerifiedMember(teamSlug: string): Promise<boolean>;

  /**
   * Tenants whose access lapsed before `before` and are therefore eligible for
   * data deletion.
   *
   * Eligible means status 'trialing', 'canceled' or 'unpaid' with a period end
   * already past — the expired trial that never converted, and the subscription
   * that ended. 'past_due' is deliberately EXCLUDED: that is Stripe still
   * retrying a card, which can run for weeks, and a card that merely expired is
   * not a decision to leave. Deleting there would destroy the history of someone
   * who fully intends to keep paying, and it is the one deletion that cannot be
   * undone.
   */
  listLapsedTenants(before: number, limit?: number): Promise<Array<{ tenant: string; lapsedAt: number; status: string }>>;

  /**
   * Remove a tenant and everything keyed to it: control-plane rows (tokens,
   * team, memberships, invites, artifacts) AND the tenant's data rows in the
   * tenant-scoped stores. Admin-only surface — used to purge test tenants.
   * Returns false when the tenant doesn't exist.
   */
  deleteTenant(tenant: string): Promise<boolean>;

  /**
   * Delete a PERSON: the identity rows better-auth owns, by email.
   *
   * deleteTenant purges a workspace and everything in it, and leaves the human
   * behind — memberships, teams and entitlements gone, the `user` row still
   * there. That orphan can sign in, gets a fresh workspace auto-created, and can
   * never sign UP again because the address is taken. For a product that ships
   * `recall_forget` and a delete-everything control, "we cannot delete an
   * account" was the one hole, and it left psql as the only way out.
   *
   * REFUSES while the person still owns a workspace: deleting the identity first
   * would strand tenant rows nothing can reach. Delete the tenants, then the
   * account — and the refusal says so rather than half-doing it.
   */
  deleteAccount(email: string): Promise<{ deleted: boolean; reason?: string; tenants?: string[] }>;

  /** All tenant slugs. For cross-tenant background sweeps (e.g. the vector
   *  backfill worker), since RLS hides other tenants from a scoped query. */
  listTenants(): Promise<string[]>;

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

  // ── Sync usage metering (free-tier quotas) ──
  /**
   * Add `bytes` to the tenant's counter for `month` ('YYYY-MM'). Atomic upsert:
   * two API pods ingesting for the same tenant must not lose increments.
   */
  addSyncUsage(tenant: string, month: string, bytes: number): Promise<void>;
  /** Bytes recorded for `month`, plus the all-time total (the storage cap). */
  getSyncUsage(tenant: string, month: string): Promise<{ monthBytes: number; totalBytes: number }>;
  /**
   * Does a usage row EXIST for any of `months`? Existence, not bytes: a refused
   * batch records a zero-byte presence row, and this is what tells "still here,
   * refused by a meter" apart from "left" — the retention sweep's question.
   */
  hasSyncActivity(tenant: string, months: string[]): Promise<boolean>;
  /**
   * Zero the tenant's counters — except `keepMonth` when given. Called when the
   * tenant wipes their data (data-controls delete-all): the STORAGE total must
   * restart with the data, but the current month's QUOTA consumption must
   * survive, or delete-all + re-sync becomes an infinite-quota loop.
   * Partial deletes deliberately do NOT credit the counter.
   */
  resetSyncUsage(tenant: string, keepMonth?: string): Promise<void>;

  // ── Self-host licences ──
  /** By serial, or null. */
  findLicence(serial: string): Promise<Licence | null>;
  /** By Stripe subscription — the idempotency key when a webhook fires twice. */
  findLicenceBySubscription(subscriptionId: string): Promise<Licence | null>;
  upsertLicence(l: Omit<Licence, 'createdAt' | 'updatedAt'>): Promise<void>;
  /** Note that an instance activated. Counting installs is the point of going
   *  online — an offline key cannot tell you it runs on forty servers. */
  recordLicenceInstance(serial: string, instanceId: string): Promise<void>;
  /** How many distinct instances have ever activated this serial. */
  countLicenceInstances(serial: string): Promise<number>;

  // ── Audit log (Enterprise) ──
  /**
   * Read the write-ahead audit log, newest first. Keyset-paginated on `before`
   * (exclusive upper bound on id) rather than an offset: the log is append-only and
   * grows while it is being paged, so OFFSET would skip or repeat rows.
   *
   * Read-only on purpose — an audit trail its subject can edit is not one.
   */
  readAuditLog(opts: {
    tenant: string; limit: number; before?: number | null; operation?: string | null;
  }): Promise<AuditEntry[]>;

  // ── Tenant settings ──
  getTenantSetting(tenant: string, key: string): Promise<string | null>;
  setTenantSetting(tenant: string, key: string, value: string): Promise<void>;

  // ── Per-project team sharing (team collaboration) ──
  /** Every share in the team (all members). Powers the owner's overview. */
  listShares(teamSlug: string): Promise<ProjectShare[]>;
  /** The projects one member has shared into the team. */
  listSharesForUser(teamSlug: string, ownerSub: string): Promise<ProjectShare[]>;
  /** Opt a member's project into team visibility (upsert scope). */
  setShare(teamSlug: string, ownerSub: string, projectId: string, scope: ShareScope): Promise<void>;
  /** Stop sharing a member's project; false when it wasn't shared. */
  removeShare(teamSlug: string, ownerSub: string, projectId: string): Promise<boolean>;

  close(): Promise<void>;
}

export type ShareScope = 'activity' | 'full';
export interface ProjectShare {
  teamSlug: string;
  ownerSub: string;
  projectId: string;
  scope: ShareScope;
  sharedAt: number;
}

/** Shared row -> Licence mapping; column names match in both backends. */
function rowToLicence(r: any): Licence {
  return {
    serial: String(r.serial),
    email: r.email ?? null,
    holder: r.holder ?? null,
    features: String(r.features ?? ''),
    seats: r.seats == null ? null : Number(r.seats),
    stripeCustomerId: r.stripe_customer_id ?? null,
    stripeSubscriptionId: r.stripe_subscription_id ?? null,
    status: r.status === 'revoked' ? 'revoked' : 'active',
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

/** Parse a JSON column, tolerating a driver that already parsed it. */
function safeJson(v: string): unknown {
  try { return JSON.parse(v); } catch { return v; }
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

/**
 * A slug DERIVED from the owner, for the workspace auto-provisioned on a user's
 * first authenticated request.
 *
 * The random suffix above is right for a team someone deliberately creates —
 * two teams called "backend" must be able to coexist. It is wrong for the
 * auto-provision path, and the failure is not theoretical: a client that fires
 * two requests at once on first login (a dashboard load, or an OAuth connector
 * doing sign-in and a tool call together) produced TWO workspaces, both owned by
 * the same user, at the same second. Every request after that answered
 * `400 multiple teams — pass the x-team header`, and the client reads a
 * tenant-resolution failure as "subscribe" — so a brand-new user was shown a
 * paywall for a product they had not been charged for.
 *
 * middleware/auth.ts already handles losing this race: it catches the create
 * error, re-reads memberships, and uses whichever one won. That recovery was
 * simply unreachable, because two random slugs never collide. Deriving the
 * suffix from the owner makes the second insert violate the primary key, which
 * is what turns the comment's claim — "two concurrent first requests converge on
 * one workspace" — from an assumption into something the database enforces.
 */
function ownerSlug(name: string, ownerSub: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'team';
  return `${base}-${createHash('sha256').update(ownerSub).digest('hex').slice(0, 6)}`;
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
        last_seen_at INTEGER, cli_version TEXT, os TEXT,
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
        seats                  INTEGER,
        updated_at             INTEGER
      );
      CREATE TABLE IF NOT EXISTS cp_tenant_settings (
        tenant     TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant, key)
      );
      CREATE TABLE IF NOT EXISTS sync_usage (
        tenant TEXT NOT NULL,
        month  TEXT NOT NULL,
        bytes  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant, month)
      );
      CREATE TABLE IF NOT EXISTS team_project_shares (
        team_slug  TEXT NOT NULL,
        owner_sub  TEXT NOT NULL,
        project_id TEXT NOT NULL,
        scope      TEXT NOT NULL DEFAULT 'full',
        shared_at  INTEGER NOT NULL,
        PRIMARY KEY (team_slug, owner_sub, project_id)
      );
    `);
    // Device liveness columns on a table that may predate them. SQLite has no
    // ADD COLUMN IF NOT EXISTS — a duplicate-column error is the no-op case.
    for (const col of ['last_seen_at INTEGER', 'cli_version TEXT', 'os TEXT']) {
      try { this.db.exec(`ALTER TABLE cp_agent_tokens ADD COLUMN ${col}`); } catch { /* already there */ }
    }
  }

  async ensureTenant(tenant: string, displayName?: string, attribution?: SignupAttribution): Promise<void> {
    // INSERT OR IGNORE already means "first write wins", which is exactly the
    // first-touch rule — so attribution goes in the same statement and a later
    // call with a different cookie is ignored along with the rest of the row.
    for (const col of ['signup_source TEXT', 'signup_referrer TEXT', 'signup_campaign TEXT', 'signup_anon_id TEXT']) {
      try { this.db.exec(`ALTER TABLE cp_tenants ADD COLUMN ${col}`); } catch { /* already there */ }
    }
    this.db.prepare(
      `INSERT OR IGNORE INTO cp_tenants
         (tenant, display_name, created_at, signup_source, signup_referrer, signup_campaign, signup_anon_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tenant, displayName ?? tenant, Date.now(),
      attribution?.source ?? null,
      attribution?.referrer ?? null,
      attribution?.campaign ?? null,
      attribution?.anonId ?? null,
    );
  }

  async resolveAgentToken(rawToken: string): Promise<AgentTokenInfo | null> {
    const r = this.db.prepare(
      `SELECT tenant, device_id, user_sub FROM cp_agent_tokens WHERE token_hash = ? AND revoked_at IS NULL`,
    ).get(sha256(rawToken)) as { tenant: string; device_id: string; user_sub: string | null } | undefined;
    return r ? { tenant: r.tenant, deviceId: r.device_id, userSub: r.user_sub ?? null } : null;
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

  async touchAgentToken(tenant: string, deviceId: string, meta?: { cliVersion?: string | null; os?: string | null }): Promise<void> {
    // COALESCE: a request that carries no version header must not erase the
    // version a previous one reported.
    this.db.prepare(
      `UPDATE cp_agent_tokens SET last_seen_at = ?, cli_version = COALESCE(?, cli_version), os = COALESCE(?, os)
       WHERE tenant = ? AND device_id = ?`,
    ).run(Date.now(), meta?.cliVersion ?? null, meta?.os ?? null, tenant, deviceId);
  }

  async listAgentTokens(tenant: string): Promise<AgentTokenMeta[]> {
    const rows = this.db.prepare(
      `SELECT device_id, created_at, revoked_at, last_seen_at, cli_version, os
         FROM cp_agent_tokens WHERE tenant = ? ORDER BY created_at DESC`,
    ).all(tenant) as Array<{ device_id: string; created_at: number; revoked_at: number | null; last_seen_at: number | null; cli_version: string | null; os: string | null }>;
    return rows.map(r => ({
      deviceId: r.device_id, createdAt: r.created_at, revoked: r.revoked_at != null,
      lastSeenAt: r.last_seen_at ?? null, cliVersion: r.cli_version ?? null, os: r.os ?? null,
    }));
  }

  async createTeam(
    name: string,
    ownerSub: string,
    ownerEmail?: string | null,
    attribution?: SignupAttribution,
    ownerKeyed = false,
  ): Promise<{ slug: string; name: string }> {
    const slug = ownerKeyed ? ownerSlug(name, ownerSub) : slugify(name);
    const now = Date.now();
    await this.ensureTenant(slug, name, attribution);
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

  async peekInvite(rawInvite: string): Promise<{ team_slug: string; role: 'owner' | 'member' } | null> {
    const inv = this.db.prepare(
      `SELECT team_slug, role FROM cp_invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
    ).get(sha256(rawInvite), Date.now()) as { team_slug: string; role: 'owner' | 'member' } | undefined;
    return inv ?? null;
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

  async listTenants(): Promise<string[]> {
    return (this.db.prepare(`SELECT tenant FROM cp_tenants ORDER BY tenant`).all() as { tenant: string }[]).map(r => r.tenant);
  }

  /** Self-host / tests: no better-auth tables, so nothing to verify against. */
  async hasVerifiedMember(_teamSlug: string): Promise<boolean> { return true; }

  async listLapsedTenants(before: number, limit = 100): Promise<Array<{ tenant: string; lapsedAt: number; status: string }>> {
    return this.db.prepare(
      `SELECT tenant, current_period_end AS lapsedAt, status FROM cp_entitlements
        WHERE status IN ('trialing','canceled','unpaid')
          AND current_period_end IS NOT NULL AND current_period_end < ?
        ORDER BY current_period_end LIMIT ?`,
    ).all(before, limit) as Array<{ tenant: string; lapsedAt: number; status: string }>;
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
      `SELECT tenant, plan, status, current_period_end, stripe_customer_id, stripe_subscription_id, seats
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
         (tenant, plan, status, current_period_end, stripe_customer_id, stripe_subscription_id, seats, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant) DO UPDATE SET
         plan=excluded.plan, status=excluded.status, current_period_end=excluded.current_period_end,
         stripe_customer_id=excluded.stripe_customer_id, stripe_subscription_id=excluded.stripe_subscription_id,
         seats=excluded.seats, updated_at=excluded.updated_at`,
    ).run(
      next.tenant, next.plan, next.status, next.currentPeriodEnd,
      next.stripeCustomerId, next.stripeSubscriptionId, next.seats, Date.now(),
    );
  }

  async addSyncUsage(tenant: string, month: string, bytes: number): Promise<void> {
    this.db.prepare(
      `INSERT INTO sync_usage (tenant, month, bytes) VALUES (?, ?, ?)
       ON CONFLICT (tenant, month) DO UPDATE SET bytes = bytes + excluded.bytes`,
    ).run(tenant, month, Math.max(0, Math.floor(bytes)));
  }

  async getSyncUsage(tenant: string, month: string): Promise<{ monthBytes: number; totalBytes: number }> {
    const r = this.db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN month = ? THEN bytes ELSE 0 END), 0) AS month_bytes,
              COALESCE(SUM(bytes), 0) AS total_bytes
         FROM sync_usage WHERE tenant = ?`,
    ).get(month, tenant) as { month_bytes: number; total_bytes: number };
    return { monthBytes: Number(r?.month_bytes ?? 0), totalBytes: Number(r?.total_bytes ?? 0) };
  }

  async hasSyncActivity(tenant: string, months: string[]): Promise<boolean> {
    if (!months.length) return false;
    const q = months.map(() => '?').join(',');
    const r = this.db.prepare(
      `SELECT 1 FROM sync_usage WHERE tenant = ? AND month IN (${q}) LIMIT 1`,
    ).get(tenant, ...months);
    return !!r;
  }

  async resetSyncUsage(tenant: string, keepMonth?: string): Promise<void> {
    if (keepMonth) {
      this.db.prepare(`DELETE FROM sync_usage WHERE tenant = ? AND month <> ?`).run(tenant, keepMonth);
    } else {
      this.db.prepare(`DELETE FROM sync_usage WHERE tenant = ?`).run(tenant);
    }
  }

  async findLicence(serial: string): Promise<Licence | null> {
    try {
      const r = this.db.prepare(`SELECT * FROM licences WHERE serial = ?`).get(serial) as any;
      return r ? rowToLicence(r) : null;
    } catch { return null; }
  }

  async findLicenceBySubscription(subscriptionId: string): Promise<Licence | null> {
    try {
      const r = this.db.prepare(`SELECT * FROM licences WHERE stripe_subscription_id = ?`).get(subscriptionId) as any;
      return r ? rowToLicence(r) : null;
    } catch { return null; }
  }

  async upsertLicence(l: Omit<Licence, 'createdAt' | 'updatedAt'>): Promise<void> {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO licences (serial, email, holder, features, seats, stripe_customer_id,
                             stripe_subscription_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (serial) DO UPDATE SET
         email=excluded.email, holder=excluded.holder, features=excluded.features,
         seats=excluded.seats, stripe_customer_id=excluded.stripe_customer_id,
         stripe_subscription_id=excluded.stripe_subscription_id,
         status=excluded.status, updated_at=excluded.updated_at`,
    ).run(l.serial, l.email, l.holder, l.features, l.seats, l.stripeCustomerId,
          l.stripeSubscriptionId, l.status, now, now);
  }

  async recordLicenceInstance(serial: string, instanceId: string): Promise<void> {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO licence_instances (serial, instance_id, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (serial, instance_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
    ).run(serial, instanceId, now, now);
    this.db.prepare(
      `UPDATE licences SET last_activated_at = ?, activation_count = activation_count + 1 WHERE serial = ?`,
    ).run(now, serial);
  }

  async countLicenceInstances(serial: string): Promise<number> {
    try {
      const r = this.db.prepare(`SELECT count(*) AS n FROM licence_instances WHERE serial = ?`).get(serial) as { n: number };
      return Number(r?.n ?? 0);
    } catch { return 0; }
  }

  async readAuditLog(opts: {
    tenant: string; limit: number; before?: number | null; operation?: string | null;
  }): Promise<AuditEntry[]> {
    // The sqlite driver exists for unit tests, where wal_log may never have been
    // created. An absent table is "no audit history", not an error.
    try {
      const where = ['tenant = ?'];
      const params: unknown[] = [opts.tenant];
      if (opts.before) { where.push('id < ?'); params.push(opts.before); }
      if (opts.operation) { where.push('operation = ?'); params.push(opts.operation); }
      params.push(opts.limit);
      const rows = this.db.prepare(
        `SELECT id, ts, operation, payload FROM wal_log
          WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      ).all(...params) as Array<{ id: number; ts: number; operation: string; payload: string }>;
      return rows.map((r) => ({
        id: Number(r.id), ts: Number(r.ts), operation: r.operation,
        payload: safeJson(r.payload),
      }));
    } catch {
      return [];
    }
  }

  async getTenantSetting(tenant: string, key: string): Promise<string | null> {
    const r = this.db.prepare(`SELECT value FROM cp_tenant_settings WHERE tenant = ? AND key = ?`).get(tenant, key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  async setTenantSetting(tenant: string, key: string, value: string): Promise<void> {
    this.db.prepare(`INSERT INTO cp_tenant_settings (tenant, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (tenant, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(tenant, key, value, Date.now());
  }

  async listShares(teamSlug: string): Promise<ProjectShare[]> {
    return (this.db.prepare(`SELECT team_slug, owner_sub, project_id, scope, shared_at FROM team_project_shares WHERE team_slug = ? ORDER BY shared_at DESC`).all(teamSlug) as any[])
      .map((r) => ({ teamSlug: r.team_slug, ownerSub: r.owner_sub, projectId: r.project_id, scope: r.scope as ShareScope, sharedAt: r.shared_at }));
  }
  async listSharesForUser(teamSlug: string, ownerSub: string): Promise<ProjectShare[]> {
    return (this.db.prepare(`SELECT team_slug, owner_sub, project_id, scope, shared_at FROM team_project_shares WHERE team_slug = ? AND owner_sub = ? ORDER BY shared_at DESC`).all(teamSlug, ownerSub) as any[])
      .map((r) => ({ teamSlug: r.team_slug, ownerSub: r.owner_sub, projectId: r.project_id, scope: r.scope as ShareScope, sharedAt: r.shared_at }));
  }
  async setShare(teamSlug: string, ownerSub: string, projectId: string, scope: ShareScope): Promise<void> {
    this.db.prepare(`INSERT INTO team_project_shares (team_slug, owner_sub, project_id, scope, shared_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (team_slug, owner_sub, project_id) DO UPDATE SET scope=excluded.scope, shared_at=excluded.shared_at`)
      .run(teamSlug, ownerSub, projectId, scope, Date.now());
  }
  async removeShare(teamSlug: string, ownerSub: string, projectId: string): Promise<boolean> {
    return this.db.prepare(`DELETE FROM team_project_shares WHERE team_slug = ? AND owner_sub = ? AND project_id = ?`).run(teamSlug, ownerSub, projectId).changes > 0;
  }

  /** Tests only, like the rest of this backend — better-auth's tables are a
   *  Postgres-server concern and do not exist here, so there is no identity to
   *  delete. Reported honestly rather than pretending success. */
  async deleteAccount(_email: string): Promise<{ deleted: boolean; reason?: string; tenants?: string[] }> {
    return { deleted: false, reason: 'account deletion needs the Postgres backend (better-auth tables)' };
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
    this.db.prepare(`DELETE FROM sync_usage           WHERE tenant = ?`).run(tenant);
    this.db.prepare(`DELETE FROM cp_tenant_settings  WHERE tenant = ?`).run(tenant);
    this.db.prepare(`DELETE FROM team_project_shares WHERE team_slug = ?`).run(tenant);
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
    seats: r.seats == null ? null : Number(r.seats),
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
    stripeCustomerId: null, stripeSubscriptionId: null, seats: null,
  };
  return {
    tenant,
    plan: patch.plan !== undefined ? patch.plan : base.plan,
    status: patch.status !== undefined ? coerceStatus(patch.status) : base.status,
    currentPeriodEnd: patch.currentPeriodEnd !== undefined ? patch.currentPeriodEnd : base.currentPeriodEnd,
    seats: patch.seats !== undefined ? patch.seats : base.seats,
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
  async init(): Promise<void> { this.pool = await openPgPool(this.databaseUrl); await ensurePgSchema(this.databaseUrl); }
  private async q(sql: string, params: unknown[] = []): Promise<any[]> {
    return (await this.pool.query(sql, params)).rows;
  }

  async ensureTenant(tenant: string, displayName?: string, attribution?: SignupAttribution): Promise<void> {
    // DO NOTHING on conflict is the first-touch guarantee: the attribution
    // columns are only ever populated by the statement that creates the row.
    // Do NOT change this to DO UPDATE — see the interface comment.
    await this.q(
      `INSERT INTO tenants
         (tenant, display_name, created_at, signup_source, signup_referrer, signup_campaign, signup_anon_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant) DO NOTHING`,
      [
        tenant, displayName ?? tenant, Date.now(),
        attribution?.source ?? null,
        attribution?.referrer ?? null,
        attribution?.campaign ?? null,
        attribution?.anonId ?? null,
      ],
    );
  }

  async resolveAgentToken(rawToken: string): Promise<AgentTokenInfo | null> {
    const r = (await this.q(
      `SELECT tenant, device_id, user_sub FROM agent_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
      [sha256(rawToken)],
    ))[0];
    return r ? { tenant: r.tenant, deviceId: r.device_id, userSub: r.user_sub ?? null } : null;
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

  async touchAgentToken(tenant: string, deviceId: string, meta?: { cliVersion?: string | null; os?: string | null }): Promise<void> {
    // COALESCE: a request that carries no version header must not erase the
    // version a previous one reported.
    await this.q(
      `UPDATE agent_tokens SET last_seen_at = $1, cli_version = COALESCE($2, cli_version), os = COALESCE($3, os)
        WHERE tenant = $4 AND device_id = $5`,
      [Date.now(), meta?.cliVersion ?? null, meta?.os ?? null, tenant, deviceId],
    );
  }

  async listAgentTokens(tenant: string): Promise<AgentTokenMeta[]> {
    const r = await this.pool.query(
      `SELECT device_id, created_at, revoked_at, last_seen_at, cli_version, os
         FROM agent_tokens WHERE tenant = $1 ORDER BY created_at DESC`,
      [tenant],
    );
    return r.rows.map((row: { device_id: string; created_at: string | number; revoked_at: string | number | null; last_seen_at: string | number | null; cli_version: string | null; os: string | null }) => ({
      deviceId: row.device_id,
      createdAt: Number(row.created_at),
      revoked: row.revoked_at != null,
      lastSeenAt: row.last_seen_at != null ? Number(row.last_seen_at) : null,
      cliVersion: row.cli_version ?? null,
      os: row.os ?? null,
    }));
  }

  async createTeam(
    name: string,
    ownerSub: string,
    ownerEmail?: string | null,
    attribution?: SignupAttribution,
    ownerKeyed = false,
  ): Promise<{ slug: string; name: string }> {
    const slug = ownerKeyed ? ownerSlug(name, ownerSub) : slugify(name);
    const now = Date.now();
    await this.ensureTenant(slug, name, attribution);
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

  async peekInvite(rawInvite: string): Promise<{ team_slug: string; role: 'owner' | 'member' } | null> {
    const inv = (await this.q(
      `SELECT team_slug, role FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2`,
      [sha256(rawInvite), Date.now()],
    ))[0];
    return inv ? { team_slug: inv.team_slug, role: inv.role } : null;
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

  async hasVerifiedMember(teamSlug: string): Promise<boolean> {
    // "user" is better-auth's table and needs the quotes: both the name and the
    // emailVerified column are case-sensitive in Postgres.
    //
    // A MISSING table means auth is not better-auth on this deployment, which is
    // not the same as "nobody is verified" — failing closed there would deny
    // every trial on an otherwise working install. So an error resolves to true
    // and the gate simply does not apply.
    try {
      const rows = await this.q(
        `SELECT 1 FROM memberships m JOIN "user" u ON u.id = m.user_sub
          WHERE m.team_slug = $1 AND u."emailVerified" = true LIMIT 1`,
        [teamSlug],
      );
      return rows.length > 0;
    } catch {
      return true;
    }
  }

  async listLapsedTenants(before: number, limit = 100): Promise<Array<{ tenant: string; lapsedAt: number; status: string }>> {
    const rows = await this.q(
      `SELECT tenant, current_period_end, status FROM entitlements
        WHERE status IN ('trialing','canceled','unpaid')
          AND current_period_end IS NOT NULL AND current_period_end < $1
        ORDER BY current_period_end LIMIT $2`,
      [before, limit],
    );
    return rows.map((r: any) => ({
      tenant: r.tenant, lapsedAt: Number(r.current_period_end) || 0, status: r.status,
    }));
  }

  async listTenants(): Promise<string[]> {
    return (await this.q(`SELECT tenant FROM tenants ORDER BY tenant`)).map((r: any) => r.tenant as string);
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
      `SELECT tenant, plan, status, current_period_end, stripe_customer_id, stripe_subscription_id, seats
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
         (tenant, plan, status, current_period_end, stripe_customer_id, stripe_subscription_id, seats, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant) DO UPDATE SET
         plan=excluded.plan, status=excluded.status, current_period_end=excluded.current_period_end,
         stripe_customer_id=excluded.stripe_customer_id, stripe_subscription_id=excluded.stripe_subscription_id,
         seats=excluded.seats, updated_at=excluded.updated_at`,
      [
        next.tenant, next.plan, next.status, next.currentPeriodEnd,
        next.stripeCustomerId, next.stripeSubscriptionId, next.seats, Date.now(),
      ],
    );
  }

  async addSyncUsage(tenant: string, month: string, bytes: number): Promise<void> {
    await this.q(
      `INSERT INTO sync_usage (tenant, month, bytes) VALUES ($1, $2, $3)
       ON CONFLICT (tenant, month) DO UPDATE SET bytes = sync_usage.bytes + excluded.bytes`,
      [tenant, month, Math.max(0, Math.floor(bytes))],
    );
  }

  async getSyncUsage(tenant: string, month: string): Promise<{ monthBytes: number; totalBytes: number }> {
    const r = (await this.q(
      `SELECT COALESCE(SUM(CASE WHEN month = $1 THEN bytes ELSE 0 END), 0) AS month_bytes,
              COALESCE(SUM(bytes), 0) AS total_bytes
         FROM sync_usage WHERE tenant = $2`,
      [month, tenant],
    ))[0] as { month_bytes: string | number; total_bytes: string | number } | undefined;
    return { monthBytes: Number(r?.month_bytes ?? 0), totalBytes: Number(r?.total_bytes ?? 0) };
  }

  async hasSyncActivity(tenant: string, months: string[]): Promise<boolean> {
    if (!months.length) return false;
    const params: unknown[] = [tenant, ...months];
    const q = months.map((_, i) => `$${i + 2}`).join(',');
    const r = await this.q(
      `SELECT 1 FROM sync_usage WHERE tenant = $1 AND month IN (${q}) LIMIT 1`,
      params,
    );
    return r.length > 0;
  }

  async resetSyncUsage(tenant: string, keepMonth?: string): Promise<void> {
    if (keepMonth) {
      await this.q(`DELETE FROM sync_usage WHERE tenant = $1 AND month <> $2`, [tenant, keepMonth]);
    } else {
      await this.q(`DELETE FROM sync_usage WHERE tenant = $1`, [tenant]);
    }
  }

  async findLicence(serial: string): Promise<Licence | null> {
    const r = (await this.q(`SELECT * FROM licences WHERE serial = $1`, [serial]))[0];
    return r ? rowToLicence(r) : null;
  }

  async findLicenceBySubscription(subscriptionId: string): Promise<Licence | null> {
    const r = (await this.q(`SELECT * FROM licences WHERE stripe_subscription_id = $1`, [subscriptionId]))[0];
    return r ? rowToLicence(r) : null;
  }

  async upsertLicence(l: Omit<Licence, 'createdAt' | 'updatedAt'>): Promise<void> {
    const now = Date.now();
    await this.q(
      `INSERT INTO licences (serial, email, holder, features, seats, stripe_customer_id,
                             stripe_subscription_id, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       ON CONFLICT (serial) DO UPDATE SET
         email=excluded.email, holder=excluded.holder, features=excluded.features,
         seats=excluded.seats, stripe_customer_id=excluded.stripe_customer_id,
         stripe_subscription_id=excluded.stripe_subscription_id,
         status=excluded.status, updated_at=excluded.updated_at`,
      [l.serial, l.email, l.holder, l.features, l.seats, l.stripeCustomerId,
       l.stripeSubscriptionId, l.status, now],
    );
  }

  async recordLicenceInstance(serial: string, instanceId: string): Promise<void> {
    const now = Date.now();
    await this.q(
      `INSERT INTO licence_instances (serial, instance_id, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$3)
       ON CONFLICT (serial, instance_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
      [serial, instanceId, now],
    );
    await this.q(
      `UPDATE licences SET last_activated_at=$1, activation_count=activation_count+1 WHERE serial=$2`,
      [now, serial],
    );
  }

  async countLicenceInstances(serial: string): Promise<number> {
    const r = (await this.q(`SELECT count(*)::int AS n FROM licence_instances WHERE serial = $1`, [serial]))[0];
    return Number(r?.n ?? 0);
  }

  async readAuditLog(opts: {
    tenant: string; limit: number; before?: number | null; operation?: string | null;
  }): Promise<AuditEntry[]> {
    const where = ['tenant = $1'];
    const params: unknown[] = [opts.tenant];
    if (opts.before) { params.push(opts.before); where.push(`id < $${params.length}`); }
    if (opts.operation) { params.push(opts.operation); where.push(`operation = $${params.length}`); }
    params.push(opts.limit);
    const rows = await this.q(
      `SELECT id, ts, operation, payload FROM wal_log
        WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r: any) => ({
      id: Number(r.id), ts: Number(r.ts), operation: r.operation,
      payload: typeof r.payload === 'string' ? safeJson(r.payload) : r.payload,
    }));
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

  async listShares(teamSlug: string): Promise<ProjectShare[]> {
    return (await this.q(`SELECT team_slug, owner_sub, project_id, scope, shared_at FROM team_project_shares WHERE team_slug = $1 ORDER BY shared_at DESC`, [teamSlug]))
      .map((r: any) => ({ teamSlug: r.team_slug, ownerSub: r.owner_sub, projectId: r.project_id, scope: r.scope as ShareScope, sharedAt: Number(r.shared_at) }));
  }
  async listSharesForUser(teamSlug: string, ownerSub: string): Promise<ProjectShare[]> {
    return (await this.q(`SELECT team_slug, owner_sub, project_id, scope, shared_at FROM team_project_shares WHERE team_slug = $1 AND owner_sub = $2 ORDER BY shared_at DESC`, [teamSlug, ownerSub]))
      .map((r: any) => ({ teamSlug: r.team_slug, ownerSub: r.owner_sub, projectId: r.project_id, scope: r.scope as ShareScope, sharedAt: Number(r.shared_at) }));
  }
  async setShare(teamSlug: string, ownerSub: string, projectId: string, scope: ShareScope): Promise<void> {
    await this.q(
      `INSERT INTO team_project_shares (team_slug, owner_sub, project_id, scope, shared_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (team_slug, owner_sub, project_id) DO UPDATE SET scope=excluded.scope, shared_at=excluded.shared_at`,
      [teamSlug, ownerSub, projectId, scope, Date.now()],
    );
  }
  async removeShare(teamSlug: string, ownerSub: string, projectId: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM team_project_shares WHERE team_slug = $1 AND owner_sub = $2 AND project_id = $3`, [teamSlug, ownerSub, projectId]);
    return (r.rowCount || 0) > 0;
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
      'kg_triples', 'wal_log', 'diary_entries', 'team_tasks', 'team_task_comments',
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
    await this.q(`DELETE FROM team_project_shares WHERE team_slug = $1`, [tenant]);
    await this.q(`DELETE FROM entitlements     WHERE tenant = $1`, [tenant]);
    await this.q(`DELETE FROM sync_usage       WHERE tenant = $1`, [tenant]);
    await this.q(`DELETE FROM tenant_settings  WHERE tenant = $1`, [tenant]);
    await this.q(`DELETE FROM teams            WHERE slug = $1`, [tenant]);
    await this.q(`DELETE FROM tenants          WHERE tenant = $1`, [tenant]);
    return true;
  }

  async deleteAccount(email: string): Promise<{ deleted: boolean; reason?: string; tenants?: string[] }> {
    const addr = email.trim().toLowerCase();
    if (!addr) return { deleted: false, reason: 'no email given' };

    // better-auth stores the address as entered; compare case-insensitively so
    // "Adrian@..." and "adrian@..." are the same person, which is how every mail
    // provider treats it and how the user typed it on a different day.
    const rows = (await this.q(
      `SELECT id FROM "user" WHERE lower(email) = $1`, [addr])) as Array<{ id: string }>;
    if (!rows.length) return { deleted: false, reason: 'no such account' };

    const owned = (await this.q(
      `SELECT team_slug FROM memberships WHERE lower(email) = $1`, [addr])) as Array<{ team_slug: string }>;
    if (owned.length) {
      return {
        deleted: false,
        reason: 'this account still belongs to a workspace — delete those tenants first',
        tenants: owned.map((r) => r.team_slug),
      };
    }

    // One transaction: a half-deleted identity (sessions gone, user row left) is
    // worse than either end state, because the next login half-works.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const id of rows.map((r) => r.id)) {
        // Child rows first. These tables are better-auth's; a missing one means
        // a plugin is not installed, which is not an error here.
        for (const t of ['session', 'account']) {
          try { await client.query(`DELETE FROM "${t}" WHERE "userId" = $1`, [id]); }
          catch { /* table absent for this deployment's plugin set */ }
        }
      }
      try { await client.query(`DELETE FROM "verification" WHERE identifier = $1`, [addr]); }
      catch { /* ditto */ }
      const del = await client.query(`DELETE FROM "user" WHERE lower(email) = $1`, [addr]);
      await client.query('COMMIT');
      return { deleted: (del.rowCount ?? 0) > 0 };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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
