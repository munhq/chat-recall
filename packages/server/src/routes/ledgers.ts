/**
 * Per-device idempotency ledgers: team installs and vault uploads.
 *
 * These two lived in better-sqlite3 files under the user's `~/.chat-recall`
 * (team-installs.db, vault-uploads.db). They were the only reason the shipped
 * CLI loaded a native module at boot, and they contradicted the product model —
 * the server is the only datastore. They live here now.
 *
 * Scoped by tenant AND device. "Which artifacts did this machine write" and
 * "which sessions did this machine upload" are facts about ONE device; a second
 * machine must not skip work because a first one did it. The device id comes
 * from the authenticated token (`device:<id>`), never from the body — a client
 * cannot know or choose its own device id.
 *
 * NO FILESYSTEM PATHS. The SQLite versions stored `team_installs.path` and
 * `vault_uploads.source_path`; lifting those verbatim would have shipped
 * absolute local paths off the machine for the first time. The install path is
 * recomputed client-side from (type, name, tool), and source_path was written
 * but never read. Same rule as client-events: error classes and hashes, never
 * paths. Do not add a path column back.
 */
import express from 'express';
import { openPgPool, tenantQuery } from '@chat-recall/engine/core/store/pg-pool.js';

const router = express.Router();
const MAX_BATCH = 200;
const clip = (s: unknown, n: number): string => (typeof s === 'string' ? s.slice(0, n) : '');

/** The calling machine, from its token. Never trust a body-supplied device id. */
function device(req: express.Request): string {
  return req.authorDevice
    || (req.userId?.startsWith('device:') ? req.userId.slice('device:'.length) : '');
}

/** A path in any field is a client bug (or an attack); refuse it loudly rather
 *  than silently persisting someone's home directory layout. */
function looksLikePath(v: string): boolean {
  return v.includes('/') || v.includes('\\') || /^[A-Za-z]:/.test(v);
}

// ── Team installs ───────────────────────────────────────────────────────────

// GET /api/ledgers/team-installs[?artifactId=]
router.get('/team-installs', async (req, res) => {
  const tenant = req.tenant;
  if (!tenant) return res.status(401).json({ error: 'no tenant' });
  const dev = device(req);
  if (!dev) return res.status(400).json({ error: 'device-scoped ledger needs a device token' });
  const artifactId = typeof req.query.artifactId === 'string' ? req.query.artifactId : null;
  try {
    const pool = await openPgPool();
    const r = await tenantQuery(
      pool, tenant,
      `SELECT artifact_id, tool, artifact_type, artifact_name, sha256, installed_at
         FROM team_installs
        WHERE tenant=$1 AND device_id=$2 AND ($3::text IS NULL OR artifact_id=$3)
        ORDER BY installed_at ASC`,
      [tenant, dev, artifactId],
    );
    res.json({
      installs: r.rows.map((x: any) => ({
        artifactId: x.artifact_id, tool: x.tool,
        artifactType: x.artifact_type, artifactName: x.artifact_name,
        sha256: x.sha256, installedAt: Number(x.installed_at),
      })),
    });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
});

// POST /api/ledgers/team-installs  { installs: [{artifactId, tool, artifactType, artifactName, sha256}] }
router.post('/team-installs', async (req, res) => {
  const tenant = req.tenant;
  if (!tenant) return res.status(401).json({ error: 'no tenant' });
  const dev = device(req);
  if (!dev) return res.status(400).json({ error: 'device-scoped ledger needs a device token' });
  const rows = Array.isArray(req.body?.installs) ? req.body.installs.slice(0, MAX_BATCH) : [];
  try {
    const pool = await openPgPool();
    let n = 0;
    for (const row of rows) {
      const artifactId = clip(row?.artifactId, 128);
      const tool = clip(row?.tool, 32);
      const artifactType = clip(row?.artifactType, 32);
      const artifactName = clip(row?.artifactName, 256);
      const sha256 = clip(row?.sha256, 64);
      if (!artifactId || !tool || !artifactType || !artifactName || !sha256) continue;
      if (looksLikePath(artifactName)) {
        return res.status(400).json({ error: 'artifactName must be a bare name, not a path' });
      }
      await tenantQuery(
        pool, tenant,
        `INSERT INTO team_installs (tenant, device_id, artifact_id, tool, artifact_type, artifact_name, sha256, installed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant, device_id, artifact_id, tool) DO UPDATE
           SET artifact_type=EXCLUDED.artifact_type, artifact_name=EXCLUDED.artifact_name,
               sha256=EXCLUDED.sha256, installed_at=EXCLUDED.installed_at`,
        [tenant, dev, artifactId, tool, artifactType, artifactName, sha256, Date.now()],
      );
      n++;
    }
    res.json({ ok: true, recorded: n });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
});

// DELETE /api/ledgers/team-installs  { artifactId, tool? }
// tool omitted = forget every tool's row for that artifact (a full revocation).
router.delete('/team-installs', async (req, res) => {
  const tenant = req.tenant;
  if (!tenant) return res.status(401).json({ error: 'no tenant' });
  const dev = device(req);
  if (!dev) return res.status(400).json({ error: 'device-scoped ledger needs a device token' });
  const artifactId = clip(req.body?.artifactId, 128);
  if (!artifactId) return res.status(400).json({ error: 'artifactId required' });
  const tool = clip(req.body?.tool, 32) || null;
  try {
    const pool = await openPgPool();
    const r = await tenantQuery(
      pool, tenant,
      `DELETE FROM team_installs
        WHERE tenant=$1 AND device_id=$2 AND artifact_id=$3 AND ($4::text IS NULL OR tool=$4)`,
      [tenant, dev, artifactId, tool],
    );
    res.json({ ok: true, removed: r.rowCount ?? 0 });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
});

// ── Vault uploads ───────────────────────────────────────────────────────────

// GET /api/ledgers/vault-uploads[?sessionId=&tool=]
router.get('/vault-uploads', async (req, res) => {
  const tenant = req.tenant;
  if (!tenant) return res.status(401).json({ error: 'no tenant' });
  const dev = device(req);
  if (!dev) return res.status(400).json({ error: 'device-scoped ledger needs a device token' });
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
  const tool = typeof req.query.tool === 'string' ? req.query.tool : null;
  try {
    const pool = await openPgPool();
    const r = await tenantQuery(
      pool, tenant,
      `SELECT session_id, tool, source_sha256, cipher_sha256, uploaded_at
         FROM vault_uploads
        WHERE tenant=$1 AND device_id=$2
          AND ($3::text IS NULL OR session_id=$3)
          AND ($4::text IS NULL OR tool=$4)`,
      [tenant, dev, sessionId, tool],
    );
    res.json({
      uploads: r.rows.map((x: any) => ({
        sessionId: x.session_id, tool: x.tool,
        sourceSha256: x.source_sha256, cipherSha256: x.cipher_sha256,
        uploadedAt: Number(x.uploaded_at),
      })),
    });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
});

// POST /api/ledgers/vault-uploads  { uploads: [{sessionId, tool, sourceSha256, cipherSha256}] }
router.post('/vault-uploads', async (req, res) => {
  const tenant = req.tenant;
  if (!tenant) return res.status(401).json({ error: 'no tenant' });
  const dev = device(req);
  if (!dev) return res.status(400).json({ error: 'device-scoped ledger needs a device token' });
  const rows = Array.isArray(req.body?.uploads) ? req.body.uploads.slice(0, MAX_BATCH) : [];
  try {
    const pool = await openPgPool();
    let n = 0;
    for (const row of rows) {
      const sessionId = clip(row?.sessionId, 200);
      const tool = clip(row?.tool, 32);
      const sourceSha256 = clip(row?.sourceSha256, 64);
      const cipherSha256 = clip(row?.cipherSha256, 64);
      if (!sessionId || !tool || !sourceSha256) continue;
      await tenantQuery(
        pool, tenant,
        `INSERT INTO vault_uploads (tenant, device_id, session_id, tool, source_sha256, cipher_sha256, uploaded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant, device_id, session_id, tool) DO UPDATE
           SET source_sha256=EXCLUDED.source_sha256, cipher_sha256=EXCLUDED.cipher_sha256,
               uploaded_at=EXCLUDED.uploaded_at`,
        [tenant, dev, sessionId, tool, sourceSha256, cipherSha256, Date.now()],
      );
      n++;
    }
    res.json({ ok: true, recorded: n });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'failed' }); }
});

export default router;
