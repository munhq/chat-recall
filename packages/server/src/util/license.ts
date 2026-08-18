/**
 * Offline licence keys — the ELv2 hook that lets self-hosted TEAM use be paid
 * for without phoning home.
 *
 * WHY THIS EXISTS
 * ELv2 says "you may not provide the software to third parties as a hosted or
 * managed service", which stops a competitor reselling chat-recall. It does NOT
 * limit internal use: a 1,000-person company may self-host for every engineer,
 * forever, free. There is no seat clause in the licence text.
 *
 * ELv2 also says "you may not move, change, disable, or circumvent the license
 * key functionality in the software" — but that clause protects nothing unless
 * the key functionality exists. This module is that functionality.
 *
 * WHAT IS GATED, AND WHAT IS NOT
 * Solo self-hosting stays free and complete: indexing, search, MCP, the
 * knowledge graph, secret scanning, diaries. Only COLLABORATION is licensed —
 * shared project history, the team task board, per-member activity and the team
 * toolkit library. The reasoning: those features are worthless to one person and
 * valuable to a company, so they are what a company should pay for. Headcount is
 * not charged for, because having colleagues is not the product.
 *
 * OFFLINE BY DESIGN
 * A key is a signed statement, not a licence server call. An air-gapped
 * deployment must work, and a vendor outage must never disable a customer's
 * install. Verification is a local Ed25519 signature check against a public key
 * compiled in below; the private half never leaves the issuer.
 *
 * FORMAT
 *   CR1.<base64url(JSON payload)>.<base64url(Ed25519 signature)>
 *
 * The payload is deliberately readable — a customer can inspect exactly what
 * they were granted without a tool, and forging it still requires the private
 * key.
 *
 *   { "holder": "ACME GmbH", "features": ["team"],
 *     "iat": 1787000000, "exp": 1818536000 }
 *
 * `exp` is optional; a key without one is perpetual. Expiry is checked against
 * wall-clock time, which a determined operator can move — accepted, because the
 * alternative is a licence server and this is a commercial boundary, not a
 * security boundary.
 */
import { createPublicKey, verify as edVerify } from 'node:crypto';

/** A licensable capability. Kept as a union so a typo cannot silently grant. */
export type LicenseFeature = 'team';

export interface LicensePayload {
  /** Who the key was issued to. Shown in the admin UI; not verified. */
  holder: string;
  features: LicenseFeature[];
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Optional expiry, seconds since epoch. Absent = perpetual. */
  exp?: number;
  /** Free-text note from the issuer (order reference, contract id). */
  note?: string;
  /**
   * Licensed seats — distinct members allowed in one tenant. Absent = unlimited,
   * which is what a site licence looks like. Enforced at the invite chokepoint
   * rather than on every request: seats change only when someone is invited, and
   * counting members on each read would add a query to the hot path for a value
   * that almost never moves.
   */
  seats?: number;
}

export type LicenseState =
  | { valid: true; payload: LicensePayload }
  | { valid: false; reason: 'absent' | 'malformed' | 'bad_signature' | 'expired'; detail?: string };

/**
 * Issuer public key (SPKI, base64). The matching private key is held by the
 * issuer and is not in this repository.
 *
 * Replacing this value with your own key is a licence violation under the ELv2
 * anti-circumvention clause, and it is also pointless: a fork that does so
 * cannot be offered to third parties as a service either way.
 *
 * Overridable via CHAT_RECALL_LICENSE_PUBKEY so a fork running entirely
 * internally can issue its own keys without patching source — that use is
 * permitted by ELv2 and there is no reason to make it hard.
 */
const BAKED_PUBKEY_B64 = 'MCowBQYDK2VwAyEAy+i5mbJY1qsRDI2QtIQ/qh7rcCBlc+WCxT76mtmC+D8=';

/** Read at CALL time, never at module load: a constant initialised during
 *  import cannot be overridden by env afterwards, which made the override
 *  documented above a no-op and the module untestable. */
function issuerPubkey(): string {
  return process.env.CHAT_RECALL_LICENSE_PUBKEY || BAKED_PUBKEY_B64;
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verify a key string. Pure — no env reads, no caching — so tests can drive it
 * directly with a generated key pair.
 */
export function verifyLicense(key: string, pubkeyB64: string): LicenseState {
  if (!key || !key.trim()) return { valid: false, reason: 'absent' };
  if (!pubkeyB64) return { valid: false, reason: 'malformed', detail: 'no issuer public key configured' };

  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'CR1') {
    return { valid: false, reason: 'malformed', detail: 'expected CR1.<payload>.<signature>' };
  }
  let payload: LicensePayload;
  try {
    payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed', detail: 'payload is not JSON' };
  }
  if (!payload || typeof payload.holder !== 'string' || !Array.isArray(payload.features)) {
    return { valid: false, reason: 'malformed', detail: 'payload missing holder/features' };
  }

  // Signature covers the payload segment EXACTLY as transmitted, not a
  // re-serialisation of the parsed object — key order or whitespace differences
  // would otherwise break verification of a perfectly good key.
  let ok = false;
  try {
    const pub = createPublicKey({
      key: Buffer.from(pubkeyB64, 'base64'), format: 'der', type: 'spki',
    });
    ok = edVerify(null, Buffer.from(parts[1], 'utf8'), pub, b64urlToBuf(parts[2]));
  } catch (e) {
    return { valid: false, reason: 'malformed', detail: `key material rejected: ${(e as Error).message}` };
  }
  if (!ok) return { valid: false, reason: 'bad_signature' };

  // Expiry last: an expired key that is otherwise genuine gets a distinct
  // reason, so the UI can say "renew" rather than "invalid".
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
    return { valid: false, reason: 'expired', detail: new Date(payload.exp * 1000).toISOString() };
  }
  return { valid: true, payload };
}

/** Cached per-process: a key cannot change without a restart. */
let _state: LicenseState | null = null;

/** The deployment's licence state, from CHAT_RECALL_LICENSE. */
export function licenseState(): LicenseState {
  if (_state) return _state;
  _state = verifyLicense(process.env.CHAT_RECALL_LICENSE || '', issuerPubkey());
  return _state;
}

/** Test seam: drop the cache after changing env. */
export function _resetLicenseForTests(): void {
  _state = null;
}

/** Whether this deployment is licensed for a feature. */
export function hasFeature(f: LicenseFeature): boolean {
  const s = licenseState();
  return s.valid && s.payload.features.includes(f);
}

/**
 * Licensed seat count, or null for unlimited / unlicensed.
 *
 * A fractional value is FLOORED (2.5 -> 2) rather than rejected, so a mis-mint
 * cannot round up into a site licence. Zero, negative and non-numeric values
 * resolve to unlimited instead — deliberately generous, because a signed licence
 * can only carry a bad value if we issued it wrong, and locking a paying
 * customer out over our own typo is the worse failure.
 */
export function licensedSeats(): number | null {
  const s = licenseState();
  if (!s.valid) return null;
  const n = s.payload.seats;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Whether one more member may be added to a tenant that currently has
 * `currentMembers`.
 *
 * Returns an object rather than a boolean so the caller can report the numbers
 * — "4 of 4 seats used" is actionable where "false" is not.
 */
export function seatCheck(currentMembers: number): { ok: true } | { ok: false; used: number; seats: number } {
  const seats = licensedSeats();
  if (seats === null) return { ok: true };            // unlimited or unlicensed
  if (currentMembers < seats) return { ok: true };
  return { ok: false, used: currentMembers, seats };
}
