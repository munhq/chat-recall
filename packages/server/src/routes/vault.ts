/**
 * Vault key parameters — the salt, served so a second device never has to be
 * set up by hand.
 *
 * Setting up device two used to mean copying a 64-hex salt off device one and
 * re-typing the passphrase exactly:
 *
 *     chat-recall vault enable --existing-salt 9f3c…64 hex chars…
 *
 * Nobody completes that, so nobody has a working second device. The salt is a
 * KDF salt, NOT a secret — publishing it costs nothing (it exists to stop
 * cross-user rainbow tables, and each tenant's is unique and random), while
 * copying it by hand costs the whole feature.
 *
 * The passphrase, the derived key, and every blob stay client-side. What lands
 * here is: the salt, and `keyId` — a fingerprint OF THE DERIVED KEY, not the
 * key. Its purpose is to catch the mistake that used to be silent and
 * unrecoverable: typing a different passphrase on device two, which yields a
 * different key and a pile of blobs the other device can never open. With the
 * keyId published, device two can say "that's not the passphrase your other
 * machine used" *before* encrypting anything.
 *
 * First writer wins. A second, DIFFERENT salt is a 409 rather than an
 * overwrite — overwriting would orphan every blob already encrypted under the
 * original.
 */
import express from 'express';
import { createControlPlane } from '../imports.js';

const router = express.Router();

const SALT_KEY = 'vault.saltHex';
const KEYID_KEY = 'vault.keyId';

const isHex64 = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);

// GET /api/vault/salt → { saltHex, keyId } | { saltHex: null, keyId: null }
router.get('/salt', async (req, res) => {
  const tenant = req.tenant;
  if (!tenant) return res.status(401).json({ error: 'no tenant' });
  const cp = await createControlPlane();
  try {
    const [saltHex, keyId] = await Promise.all([
      cp.getTenantSetting(tenant, SALT_KEY),
      cp.getTenantSetting(tenant, KEYID_KEY),
    ]);
    res.json({ saltHex: saltHex ?? null, keyId: keyId ?? null });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'vault salt read failed' });
  } finally {
    await cp.close();
  }
});

// POST /api/vault/salt { saltHex, keyId } → publish this tenant's parameters.
// Idempotent for the same salt; 409 (with the stored values) for a different
// one, so the caller can tell the user which passphrase/salt is authoritative.
router.post('/salt', express.json(), async (req, res) => {
  const tenant = req.tenant;
  if (!tenant) return res.status(401).json({ error: 'no tenant' });
  const { saltHex, keyId } = req.body ?? {};
  if (!isHex64(saltHex)) return res.status(400).json({ error: 'saltHex must be 64 hex characters' });
  if (keyId != null && typeof keyId !== 'string') return res.status(400).json({ error: 'keyId must be a string' });

  const cp = await createControlPlane();
  try {
    const existing = await cp.getTenantSetting(tenant, SALT_KEY);
    if (existing && existing.toLowerCase() !== saltHex.toLowerCase()) {
      const existingKeyId = await cp.getTenantSetting(tenant, KEYID_KEY);
      return res.status(409).json({
        error: 'a different vault salt is already published for this workspace',
        saltHex: existing,
        keyId: existingKeyId ?? null,
      });
    }
    if (!existing) await cp.setTenantSetting(tenant, SALT_KEY, saltHex.toLowerCase());
    // keyId may arrive later than the salt (or be refreshed after a rotation
    // that keeps the salt), so it is written whenever supplied.
    if (typeof keyId === 'string' && keyId) await cp.setTenantSetting(tenant, KEYID_KEY, keyId);
    res.json({ ok: true, saltHex: saltHex.toLowerCase(), keyId: keyId ?? null, created: !existing });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'vault salt write failed' });
  } finally {
    await cp.close();
  }
});

export default router;
