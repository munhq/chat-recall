// Cleartrace cloud sync API — shared Postgres, per-tenant via RLS.
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

const PORT = process.env.PORT || 8080;
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgres://app_user:app@localhost:5456/cleartrace',
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

app.listen(PORT, () => console.log(`cleartrace sync API on :${PORT}`));
