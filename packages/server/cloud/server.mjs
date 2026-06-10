// chat-recall cloud sync API — shared Postgres, per-tenant via RLS.
// The agent on each dev's laptop POSTs redacted conversations + findings here.
// Raw secrets never arrive: findings carry masked previews, conversations are
// redacted client-side before upload.
//
// Auth: high-entropy bearer token; we store sha256(token) and look up by it
// (GitHub-PAT style — the token itself is the entropy, no per-row salt needed).
// Every data query runs inside a tx with `app.tenant_slug` set from the verified
// token, so RLS guarantees a tenant can only ever touch its own rows.

import express from 'express';
import pg from 'pg';
import { createHash, randomBytes } from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 8080;
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgres://app_user:app@localhost:5456/chat-recall',
  max: 10,
});

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Run fn inside a tenant-scoped transaction (RLS enforced). */
async function inTenant(slug, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_slug', $1, true)", [slug]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}

/** Resolve a Bearer token → { tenant_slug, device_id } or null. */
async function authAgent(req) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  const r = await pool.query(
    'SELECT tenant_slug, device_id FROM agent_tokens WHERE token_hash = $1 AND revoked_at IS NULL',
    [sha256(m[1])],
  );
  return r.rows[0] || null;
}

// ── User identity (Keycloak OIDC; dev-header fallback for local tests) ──────
const JWKS = process.env.OIDC_JWKS_URL ? createRemoteJWKSet(new URL(process.env.OIDC_JWKS_URL)) : null;
/** Resolve the logged-in user → { sub, email } or null. */
async function authUser(req) {
  // Local/dev: AUTH_DEV_USER=1 lets `x-dev-user: <id>` stand in for a real login.
  if (process.env.AUTH_DEV_USER === '1') {
    const u = req.get('x-dev-user');
    if (u) return { sub: u, email: `${u}@dev.local` };
  }
  const m = /^Bearer\s+(.+)$/.exec(req.get('authorization') || '');
  if (!m || !JWKS) return null;
  try {
    const { payload } = await jwtVerify(m[1], JWKS, process.env.OIDC_ISSUER ? { issuer: process.env.OIDC_ISSUER } : {});
    return { sub: payload.sub, email: payload.email || payload.preferred_username || null };
  } catch { return null; }
}
const slugify = (s) => (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'team') + '-' + randomBytes(3).toString('hex');

const app = express();
app.use(express.json({ limit: '16mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Bootstrap / control plane (admin-keyed; for issuing the first tenant) ──
function requireAdmin(req, res) {
  if ((req.get('x-admin-key') || '') !== (process.env.ADMIN_KEY || 'dev-admin')) {
    res.status(401).json({ error: 'admin key required' });
    return false;
  }
  return true;
}

// ── Self-serve teams (authenticated users; replaces admin token minting) ────
/** Wrap a handler so it only runs for an authenticated user (req.user set). */
function withUser(handler) {
  return async (req, res) => {
    const user = await authUser(req);
    if (!user) return res.status(401).json({ error: 'login required' });
    req.user = user;
    try { await handler(req, res); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  };
}
async function roleOf(sub, teamSlug) {
  const r = await pool.query('SELECT role FROM memberships WHERE user_sub=$1 AND team_slug=$2', [sub, teamSlug]);
  return r.rows[0]?.role || null;
}

// Who am I + which teams am I in.
app.get('/api/me', withUser(async (req, res) => {
  const r = await pool.query(
    `SELECT m.team_slug, t.name, m.role FROM memberships m JOIN teams t ON t.slug=m.team_slug WHERE m.user_sub=$1 ORDER BY t.name`,
    [req.user.sub]);
  res.json({ user: req.user, teams: r.rows });
}));

// Create a team — caller becomes owner. Also provisions the tenant.
app.post('/api/teams', withUser(async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const slug = slugify(name);
  await pool.query('INSERT INTO tenants(slug, display_name) VALUES ($1,$2) ON CONFLICT (slug) DO NOTHING', [slug, name]);
  await pool.query('INSERT INTO teams(slug, name, owner_sub) VALUES ($1,$2,$3)', [slug, name, req.user.sub]);
  await pool.query('INSERT INTO memberships(user_sub, team_slug, role, email) VALUES ($1,$2,$3,$4)', [req.user.sub, slug, 'owner', req.user.email]);
  res.json({ slug, name, role: 'owner' });
}));

// Owner generates a single-use invite token (raw shown once).
app.post('/api/teams/:slug/invites', withUser(async (req, res) => {
  if (await roleOf(req.user.sub, req.params.slug) !== 'owner') return res.status(403).json({ error: 'owner only' });
  const token = 'inv_' + randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  await pool.query(
    'INSERT INTO invites(token_hash, team_slug, role, email_hint, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [sha256(token), req.params.slug, req.body?.role === 'owner' ? 'owner' : 'member', req.body?.email || null, req.user.sub, expires]);
  res.json({ invite: token, team_slug: req.params.slug, expires_at: expires, note: 'shown once' });
}));

// Redeem an invite → become a member.
app.post('/api/teams/join', withUser(async (req, res) => {
  const token = req.body?.invite || '';
  const r = await pool.query('SELECT team_slug, role FROM invites WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()', [sha256(token)]);
  const inv = r.rows[0];
  if (!inv) return res.status(400).json({ error: 'invalid or expired invite' });
  await pool.query('INSERT INTO memberships(user_sub, team_slug, role, email) VALUES ($1,$2,$3,$4) ON CONFLICT (user_sub, team_slug) DO NOTHING',
    [req.user.sub, inv.team_slug, inv.role, req.user.email]);
  await pool.query('UPDATE invites SET used_at=now() WHERE token_hash=$1', [sha256(token)]);
  const t = (await pool.query('SELECT name FROM teams WHERE slug=$1', [inv.team_slug])).rows[0];
  res.json({ team_slug: inv.team_slug, name: t?.name, role: inv.role });
}));

// List members (any member can view).
app.get('/api/teams/:slug/members', withUser(async (req, res) => {
  if (!await roleOf(req.user.sub, req.params.slug)) return res.status(403).json({ error: 'not a member' });
  const r = await pool.query('SELECT user_sub, email, role, created_at FROM memberships WHERE team_slug=$1 ORDER BY role DESC, created_at', [req.params.slug]);
  res.json({ team_slug: req.params.slug, members: r.rows });
}));

// A member mints a device token for syncing (replaces the admin-only endpoint).
app.post('/api/teams/:slug/tokens', withUser(async (req, res) => {
  if (!await roleOf(req.user.sub, req.params.slug)) return res.status(403).json({ error: 'not a member' });
  const device_id = (req.body?.device_id || 'default').slice(0, 64);
  const token = 'ct_' + randomBytes(24).toString('hex');
  await pool.query(
    `INSERT INTO agent_tokens(tenant_slug, device_id, token_hash, user_sub) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_slug, device_id) DO UPDATE SET token_hash=EXCLUDED.token_hash, user_sub=EXCLUDED.user_sub, revoked_at=NULL`,
    [req.params.slug, device_id, sha256(token), req.user.sub]);
  res.json({ token, tenant_slug: req.params.slug, device_id, note: 'shown once' });
}));

app.post('/api/tenants', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { slug, display_name } = req.body || {};
  if (!slug || !display_name) return res.status(400).json({ error: 'slug + display_name required' });
  await pool.query('INSERT INTO tenants(slug, display_name) VALUES ($1,$2) ON CONFLICT (slug) DO NOTHING', [slug, display_name]);
  res.json({ ok: true, slug });
});

// Issue a device token for a tenant. Raw token returned ONCE.
app.post('/api/tenants/:slug/tokens', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const slug = req.params.slug;
  const device_id = (req.body && req.body.device_id) || 'default';
  const token = 'ct_' + randomBytes(24).toString('hex');
  await pool.query(
    `INSERT INTO agent_tokens(tenant_slug, device_id, token_hash) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_slug, device_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, revoked_at = NULL`,
    [slug, device_id, sha256(token)],
  );
  res.json({ token, tenant_slug: slug, device_id, note: 'shown once — store it' });
});

// ── The one ingestion surface the agent calls ──
app.post('/api/sync', async (req, res) => {
  const auth = await authAgent(req);
  if (!auth) return res.status(401).json({ error: 'invalid agent token' });
  const { conversations = [], findings = [] } = req.body || {};
  try {
    const r = await inTenant(auth.tenant_slug, async (c) => {
      let conv = 0, find = 0;
      for (const cv of conversations) {
        await c.query(
          `INSERT INTO conversations(tenant_slug, session_id, tool, project_path, redacted_text, mtime)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_slug, session_id)
           DO UPDATE SET redacted_text = EXCLUDED.redacted_text, project_path = EXCLUDED.project_path,
                         tool = EXCLUDED.tool, mtime = EXCLUDED.mtime, updated_at = now()`,
          [auth.tenant_slug, cv.session_id, cv.tool || null, cv.project_path || null, cv.redacted_text || '', cv.mtime || null],
        );
        conv++;
      }
      for (const f of findings) {
        await c.query(
          `INSERT INTO secret_findings(tenant_slug, session_id, detector, rule, line, preview, project_path, verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (tenant_slug, session_id, detector, rule, line)
           DO UPDATE SET preview = EXCLUDED.preview, project_path = EXCLUDED.project_path, verified_at = EXCLUDED.verified_at`,
          [auth.tenant_slug, f.session_id, f.detector, f.rule, f.line, f.preview, f.project_path || null, f.verified_at || null],
        );
        find++;
      }
      return { conv, find };
    });
    res.json({ ok: true, ...r, ack_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ── Read-back (tenant-scoped) — feeds the dashboard, proves isolation ──
app.get('/api/conversations', async (req, res) => {
  const auth = await authAgent(req);
  if (!auth) return res.status(401).json({ error: 'invalid agent token' });
  const rows = await inTenant(auth.tenant_slug, (c) =>
    c.query('SELECT session_id, tool, project_path, mtime FROM conversations ORDER BY mtime DESC NULLS LAST LIMIT 200').then(r => r.rows));
  res.json({ tenant: auth.tenant_slug, conversations: rows });
});

app.get('/api/findings/by-project', async (req, res) => {
  const auth = await authAgent(req);
  if (!auth) return res.status(401).json({ error: 'invalid agent token' });
  const rows = await inTenant(auth.tenant_slug, (c) =>
    c.query(`SELECT COALESCE(NULLIF(project_path,''),'(unknown)') AS project_path,
                    COUNT(DISTINCT preview) AS distinct_secrets,
                    COUNT(DISTINCT CASE WHEN verified_at IS NOT NULL THEN preview END) AS live,
                    COUNT(DISTINCT session_id) AS sessions
             FROM secret_findings GROUP BY 1 ORDER BY live DESC, distinct_secrets DESC`).then(r => r.rows));
  res.json({ tenant: auth.tenant_slug, projects: rows });
});

// ── Static dashboard (bundled React SPA) ───────────────────────────────────
// In the cloud image the built client lives at STATIC_DIR (default /app/client,
// see Dockerfile). Serve it same-origin so VITE_API_BASE='/api' just works, and
// fall back to index.html for client-side routes. /api and /health are matched
// above, so the SPA catch-all never shadows them.
const STATIC_DIR = process.env.STATIC_DIR || resolve(dirname(fileURLToPath(import.meta.url)), 'client');
if (existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get(/^\/(?!api\/|health\b).*/, (_req, res) => res.sendFile(resolve(STATIC_DIR, 'index.html')));
  console.log(`Serving dashboard from ${STATIC_DIR}`);
}

app.listen(PORT, () => console.log(`chat-recall sync API on :${PORT}`));
