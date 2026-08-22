/**
 * The licence service. This is what makes a self-host licence sellable without a
 * human in the loop.
 *
 * ── Why a serial rather than a key ─────────────────────────────────────────
 *
 * An offline key CARRIES its grant, so issuing one requires the issuer's private
 * key — and automating issuance would mean putting a key that can forge PERPETUAL
 * site licences into a web server. That is the worst secret to hold online, and it
 * is the whole reason self-host licences were still being minted by hand.
 *
 * A serial carries nothing. Issuing one is an INSERT. The grant is assembled here,
 * per activation, and signed with a SEPARATE key whose tokens expire in days — so a
 * compromise forges short-lived entitlements, not permanent ones.
 *
 *   POST /api/licence/activate  { serial, instanceId }
 *     -> { token, expiresAt, features, seats }
 *
 * The token is an ordinary CR1 licence key with a near expiry, verified by the same
 * verifyLicense() the offline path uses. One format, one verifier.
 *
 * ── What makes it revocable ───────────────────────────────────────────────
 *
 * Activation reads the LIVE Stripe subscription, not a status column a failed
 * webhook could leave stale. Cancel in Stripe and the next activation refuses; the
 * customer keeps working until their current token expires, which is the grace
 * window by design (see util/licence-activation.ts).
 *
 * PUBLIC and unauthenticated on purpose: the caller is a self-hosted server that
 * has no account here. The serial is the credential, and it is rate-limited.
 */
import express from 'express';
import { randomBytes, createPrivateKey, sign } from 'node:crypto';
import { createControlPlane } from '../imports.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('licence-service');
const router = express.Router();

/** Features a self-host licence grants. Mirrors the 'selfhost' entry in the plan
 *  map — the Solo set, on the customer's own infrastructure. */
// COLLABORATION plus the two single-player features the free self-host tier
// withholds ('toolkit', 'tasks'), so a licence — including a ONE-seat licence —
// unlocks real capability rather than a grant with nobody to share it with.
//
// COLLABORATION, not the Solo set. Running chat-recall for yourself is free —
// see SELFHOST_FREE_FEATURES in util/entitlements.ts — so a licence that granted
// sync/findings/insights would now be selling something already given away. What
// a licence buys is a SECOND PERSON: shared history, the team board, per-member
// activity and toolkit distribution. identityLimit() caps unlicensed self-host at
// one identity, so this is the boundary that actually needs paying for.
//
// Safe to narrow: every feature dropped from this list is now free, so an
// already-activated instance loses nothing.
// A licence buys COLLABORATION, and now only that. 'toolkit' and 'tasks' moved
// into SELFHOST_FREE_FEATURES on 2026-08-22, so granting them here would be
// selling something the deployment already has. Narrowing is safe by the note
// above: every feature dropped from this list is now free, so an
// already-activated instance loses nothing.
const SELFHOST_FEATURES = ['team'] as const;

/**
 * The activation signing key, from CHAT_RECALL_ACTIVATION_KEY.
 *
 * Accepts either form, because both are natural to produce and getting it wrong is
 * silent — a raw Buffer handed to createPrivateKey is parsed as PEM, so a
 * base64-encoded DER key fails to load and every activation answers 503:
 *   - a PEM block, base64'd or not
 *   - base64 of the raw PKCS8 DER (what `openssl ... -outform DER | base64` gives)
 *
 * DELIBERATELY NOT the issuer key that signs perpetual offline licences. This one
 * lives in a web server and can only mint tokens that expire, so the blast radius
 * of a leak is one window rather than forever. Rotating it invalidates outstanding
 * tokens and nothing else — every instance simply re-activates.
 */
function activationKey(): ReturnType<typeof createPrivateKey> | null {
  const raw = process.env.CHAT_RECALL_ACTIVATION_KEY;
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64');
    // A PEM block either way round: given directly, or base64'd.
    if (raw.includes('BEGIN')) return createPrivateKey(raw);
    if (decoded.toString('utf8').includes('BEGIN')) return createPrivateKey(decoded.toString('utf8'));
    // Otherwise it is raw PKCS8 DER, which must be declared as such.
    return createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' });
  } catch (e) {
    log.error({ err: (e as Error).message }, 'CHAT_RECALL_ACTIVATION_KEY is not a usable Ed25519 private key');
    return null;
  }
}

/** How long an activation token lives. This single number is both how long a
 *  customer survives our downtime and how long a revoked licence keeps working. */
function tokenDays(): number {
  const n = Number(process.env.ACTIVATION_TOKEN_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 14;
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Mint a CR1 token — the same format the offline path uses, with a near expiry. */
function mintToken(holder: string, features: readonly string[], seats: number | null): { token: string; exp: number } {
  const key = activationKey();
  if (!key) throw new Error('activation key not configured');
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + tokenDays() * 24 * 3600;
  const payload: Record<string, unknown> = { holder, features: [...features], iat, exp };
  if (seats && seats > 0) payload.seats = seats;
  const seg = b64url(JSON.stringify(payload));
  return { token: `CR1.${seg}.${b64url(sign(null, Buffer.from(seg, 'utf8'), key))}`, exp };
}

/**
 * A serial. Grouped for legibility because a human retypes these from an email, and
 * unambiguous alphabet (no O/0/I/1) for the same reason.
 */
export function newSerial(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const g = () => Array.from(randomBytes(5)).map((b) => A[b % A.length]).join('');
  return `CRS-${g()}-${g()}-${g()}`;
}

/**
 * Issue (or return the existing) serial for a Stripe subscription. Idempotent on the
 * subscription id: a webhook may fire more than once for one purchase, and a second
 * serial for the same subscription would be two licences sold once.
 */
export async function issueSerialForSubscription(opts: {
  subscriptionId: string; customerId?: string | null; email?: string | null;
  holder?: string | null; seats?: number | null;
}): Promise<{ serial: string; created: boolean }> {
  const cp = await createControlPlane();
  try {
    const existing = await cp.findLicenceBySubscription(opts.subscriptionId);
    if (existing) return { serial: existing.serial, created: false };
    const serial = newSerial();
    await cp.upsertLicence({
      serial,
      email: opts.email ?? null,
      holder: opts.holder ?? opts.email ?? 'self-host licence',
      features: [...SELFHOST_FEATURES].join(','),
      seats: opts.seats ?? null,
      stripeCustomerId: opts.customerId ?? null,
      stripeSubscriptionId: opts.subscriptionId,
      status: 'active',
    });
    return { serial, created: true };
  } finally {
    await cp.close();
  }
}

router.post('/activate', express.json({ limit: '4kb' }), async (req, res) => {
  const serial = typeof req.body?.serial === 'string' ? req.body.serial.trim().toUpperCase() : '';
  const instanceId = typeof req.body?.instanceId === 'string' ? req.body.instanceId.slice(0, 64) : '';
  if (!serial) return res.status(400).json({ error: 'serial required' });
  if (!activationKey()) {
    // Configuration gap, not the caller's fault. 503 so a client retries rather
    // than treating it as a dead serial and degrading a paying customer.
    return res.status(503).json({ error: 'activation is not configured on this server' });
  }

  const cp = await createControlPlane();
  try {
    const lic = await cp.findLicence(serial);
    // One message for unknown and revoked alike: a probe must not learn which
    // serials exist.
    if (!lic || lic.status !== 'active') {
      return res.status(403).json({ error: 'this serial is not active' });
    }

    // The LIVE subscription decides, not our status column — a missed webhook must
    // not keep a cancelled licence alive.
    if (lic.stripeSubscriptionId) {
      const ok = await subscriptionIsPaid(lic.stripeSubscriptionId);
      if (!ok) return res.status(402).json({ error: 'the subscription for this licence is not active' });
    }

    const features = lic.features ? lic.features.split(',').map((f: string) => f.trim()).filter(Boolean) : [...SELFHOST_FEATURES];
    const { token, exp } = mintToken(lic.holder || 'self-host licence', features, lic.seats ?? null);
    if (instanceId) await cp.recordLicenceInstance(serial, instanceId);

    res.json({ token, expiresAt: exp * 1000, features, seats: lic.seats ?? null });
  } catch (e) {
    log.error({ err: (e as Error).message }, 'activation failed');
    res.status(500).json({ error: 'activation failed' });
  } finally {
    await cp.close();
  }
});

/**
 * GET /api/licence/for-session?session_id=cs_…
 *
 * Hand the buyer their serial on the screen they land on after paying.
 *
 * Until this existed, email was the ONLY delivery channel, and the webhook that
 * sends it deliberately swallows failures so Stripe stops retrying — so a bounced
 * or misfiled mail left a customer who had paid with nothing, an issued serial in
 * the database, and no self-service way to reach it. If Stripe held no email at
 * all, no mail was ever sent and nobody was told.
 *
 * The Checkout Session id is the credential: Stripe puts it in the redirect and
 * nowhere else, so holding it is proof of this purchase. It is single-purpose
 * (only ever resolves its own subscription), unguessable, and useless once the
 * serial is in hand — which is why this route needs no account, exactly like
 * /activate.
 */
/**
 * A Stripe Checkout Session id, as it arrives in a success redirect. Named once:
 * both routes below use it as the credential, and two copies of an
 * authorisation-shaped check is two places for it to drift.
 */
const CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]{10,200}$/;

router.get('/for-session', async (req, res) => {
  const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
  // Shape-check before spending a Stripe call, and refuse anything that is not
  // plausibly a Checkout Session id.
  if (!CHECKOUT_SESSION_ID.test(sessionId)) {
    return res.status(400).json({ error: 'a checkout session id is required' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'billing is not configured on this server' });
  }

  const cp = await createControlPlane();
  try {
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const subId = typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id;
    if (!subId) {
      // A real session that bought no subscription — a hosted plan, or one still
      // completing. Not an error, and not a licence.
      return res.status(404).json({ error: 'no licence for this purchase' });
    }

    const lic = await cp.findLicenceBySubscription(subId);
    if (!lic) {
      // The webhook may not have landed yet. 202 rather than 404 so the client
      // knows to wait and retry instead of telling the customer it went wrong.
      return res.status(202).json({ pending: true });
    }

    res.json({
      serial: lic.serial,
      seats: lic.seats ?? null,
      // Their own address, echoed so they know WHERE the copy was sent — the
      // commonest cause of a missing serial is a different email at checkout.
      email: lic.email ?? null,
      features: lic.features
        ? lic.features.split(',').map((f: string) => f.trim()).filter(Boolean)
        : [...SELFHOST_FEATURES],
    });
  } catch (e) {
    log.error({ err: (e as Error).message }, 'licence lookup by session failed');
    res.status(502).json({ error: 'could not look up this purchase' });
  } finally {
    await cp.close();
  }
});

/**
 * POST /api/licence/resend — send the serial to the address on the subscription.
 *
 * Keyed on the Checkout Session id, never on an email the caller supplies: an
 * email-keyed resend is an enumeration oracle and a way to mail someone else's
 * serial to yourself. This can only ever re-send to the address Stripe already
 * has, which is the buyer's own.
 */
router.post('/resend', express.json({ limit: '2kb' }), async (req, res) => {
  const sessionId = typeof req.body?.session_id === 'string' ? req.body.session_id.trim() : '';
  if (!CHECKOUT_SESSION_ID.test(sessionId)) {
    return res.status(400).json({ error: 'a checkout session id is required' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'billing is not configured on this server' });
  }

  const cp = await createControlPlane();
  try {
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const subId = typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id;
    if (!subId) return res.status(404).json({ error: 'no licence for this purchase' });

    const lic = await cp.findLicenceBySubscription(subId);
    if (!lic) return res.status(202).json({ pending: true });

    const to = lic.email
      || session.customer_details?.email
      || (typeof session.customer_email === 'string' ? session.customer_email : null);
    if (!to) {
      return res.status(409).json({ error: 'this purchase has no email address on file' });
    }

    const { sendMail, licenceSerialMail } = await import('../auth/mailer.js');
    const interval = /year|annual/i.test(String(session.metadata?.plan || '')) ? 'year' : 'month';
    await sendMail(licenceSerialMail(to, lic.serial, interval));
    res.json({ sent: true, email: to });
  } catch (e) {
    // Unlike the webhook, this failure is NOT swallowed: someone is waiting on
    // the answer, so tell them it did not send.
    log.error({ err: (e as Error).message }, 'licence resend failed');
    res.status(502).json({ error: 'could not send the email' });
  } finally {
    await cp.close();
  }
});

/** Whether a Stripe subscription is currently paid-for. Absent Stripe (self-hosted
 *  licence service, or tests) means "do not block" — the serial already vouched. */
async function subscriptionIsPaid(subscriptionId: string): Promise<boolean> {
  if (!process.env.STRIPE_SECRET_KEY) return true;
  try {
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    return sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
  } catch (e) {
    // Stripe unreachable must not strip a paying customer's licence. Fail OPEN
    // here, because the token's short life is the real backstop.
    log.warn({ err: (e as Error).message }, 'could not verify subscription; allowing activation');
    return true;
  }
}

export default router;
