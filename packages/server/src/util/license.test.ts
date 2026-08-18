/**
 * Licence key verification.
 *
 * The negative cases matter more than the positive one: a forged or tampered key
 * granting the team feature is the whole failure mode this file guards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyLicense, hasFeature, _resetLicenseForTests } from './license.js';

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), priv: privateKey };
}
function mint(priv: import('node:crypto').KeyObject, payload: Record<string, unknown>) {
  const seg = b64url(JSON.stringify(payload));
  return `CR1.${seg}.${b64url(sign(null, Buffer.from(seg, 'utf8'), priv))}`;
}
const now = () => Math.floor(Date.now() / 1000);

describe('verifyLicense', () => {
  it('accepts a genuine perpetual key', () => {
    const { pub, priv } = keypair();
    const r = verifyLicense(mint(priv, { holder: 'ACME', features: ['team'], iat: now() }), pub);
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.payload.holder).toBe('ACME');
  });

  it('rejects a key signed by a DIFFERENT issuer', () => {
    // The forgery case: valid structure, valid signature, wrong private key.
    const mine = keypair(); const attacker = keypair();
    const r = verifyLicense(mint(attacker.priv, { holder: 'ACME', features: ['team'], iat: now() }), mine.pub);
    expect(r).toMatchObject({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a tampered payload', () => {
    // Take a real key for a feature-less licence, swap in ["team"], keep the sig.
    const { pub, priv } = keypair();
    const good = mint(priv, { holder: 'ACME', features: [], iat: now() });
    const forgedSeg = b64url(JSON.stringify({ holder: 'ACME', features: ['team'], iat: now() }));
    const tampered = `CR1.${forgedSeg}.${good.split('.')[2]}`;
    expect(verifyLicense(tampered, pub)).toMatchObject({ valid: false, reason: 'bad_signature' });
  });

  it('rejects an expired key with a distinct reason so the UI can say "renew"', () => {
    const { pub, priv } = keypair();
    const r = verifyLicense(mint(priv, { holder: 'ACME', features: ['team'], iat: now() - 100, exp: now() - 1 }), pub);
    expect(r).toMatchObject({ valid: false, reason: 'expired' });
  });

  it('accepts a key expiring in the future', () => {
    const { pub, priv } = keypair();
    expect(verifyLicense(mint(priv, { holder: 'A', features: ['team'], iat: now(), exp: now() + 3600 }), pub).valid).toBe(true);
  });

  it.each([
    ['', 'absent'],
    ['   ', 'absent'],
    ['not-a-key', 'malformed'],
    ['CR1.only-two-parts', 'malformed'],
    ['CR9.aaa.bbb', 'malformed'],
  ])('rejects %s as %s', (key, reason) => {
    const { pub } = keypair();
    expect(verifyLicense(key, pub)).toMatchObject({ valid: false, reason });
  });

  it('rejects a payload that is not JSON', () => {
    const { pub, priv } = keypair();
    const seg = b64url('not json at all');
    const key = `CR1.${seg}.${b64url(sign(null, Buffer.from(seg, 'utf8'), priv))}`;
    expect(verifyLicense(key, pub)).toMatchObject({ valid: false, reason: 'malformed' });
  });

  it('rejects a payload missing holder or features', () => {
    const { pub, priv } = keypair();
    expect(verifyLicense(mint(priv, { features: ['team'], iat: now() }), pub)).toMatchObject({ valid: false, reason: 'malformed' });
    expect(verifyLicense(mint(priv, { holder: 'A', iat: now() }), pub)).toMatchObject({ valid: false, reason: 'malformed' });
  });

  it('fails closed when no issuer public key is configured', () => {
    const { priv } = keypair();
    expect(verifyLicense(mint(priv, { holder: 'A', features: ['team'], iat: now() }), '')).toMatchObject({ valid: false });
  });
});

describe('hasFeature', () => {
  const saved = process.env.CHAT_RECALL_LICENSE;
  const savedPub = process.env.CHAT_RECALL_LICENSE_PUBKEY;
  beforeEach(() => _resetLicenseForTests());
  afterEach(() => {
    if (saved === undefined) delete process.env.CHAT_RECALL_LICENSE; else process.env.CHAT_RECALL_LICENSE = saved;
    if (savedPub === undefined) delete process.env.CHAT_RECALL_LICENSE_PUBKEY; else process.env.CHAT_RECALL_LICENSE_PUBKEY = savedPub;
    _resetLicenseForTests();
  });

  it('is false with no licence set — the default self-host state', () => {
    delete process.env.CHAT_RECALL_LICENSE;
    expect(hasFeature('team')).toBe(false);
  });

  it('is false when a valid licence does not grant team', () => {
    const { pub, priv } = keypair();
    process.env.CHAT_RECALL_LICENSE_PUBKEY = pub;
    process.env.CHAT_RECALL_LICENSE = mint(priv, { holder: 'A', features: [], iat: now() });
    expect(hasFeature('team')).toBe(false);
  });

  it('is true for a valid licence granting team', () => {
    const { pub, priv } = keypair();
    process.env.CHAT_RECALL_LICENSE_PUBKEY = pub;
    process.env.CHAT_RECALL_LICENSE = mint(priv, { holder: 'A', features: ['team'], iat: now() });
    expect(hasFeature('team')).toBe(true);
  });
});
