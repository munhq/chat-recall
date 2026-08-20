/**
 * POST /api/contact — the Enterprise and reseller enquiry route.
 *
 * The pricing page's "Contact us" was a mailto: link. That is a bad button: it
 * opens a mail client many people do not have configured, and when it fails you
 * never learn the lead existed. This is the same enquiry, but it lands.
 *
 * PUBLIC and pre-auth by necessity — the whole point is that the sender has no
 * account here yet. That makes it the most abusable surface on the server, so:
 * it is rate limited hard, every field is length-capped, the body is sent as
 * TEXT only (never HTML, so nothing the sender writes can be interpreted), and a
 * honeypot field catches the bots that fill every input they find.
 *
 * It POSTs from a plain <form> with no JavaScript, because the site runs under a
 * Content-Security-Policy with no inline scripts. A form post needs none.
 */
import express from 'express';
import { sendMail, mailerConfigured } from '../auth/mailer.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('contact');
const router = express.Router();

/** Where enquiries go. Overridable so a self-hoster can point it at themselves. */
const TO = process.env.CONTACT_TO || 'hello@munhq.com';

const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/** Deliberately permissive. Rejecting valid-but-unusual addresses loses real
 *  leads, and the address is only ever used as a reply-to hint in text. */
function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}

/** Header injection: an address or subject carrying CR/LF can forge headers in
 *  some transports. Nothing here is interpolated into a header, but the check is
 *  cheap and this route accepts anonymous input. */
const hasControlChars = (v: string): boolean => /[\r\n\0]/.test(v);

router.post('/', express.urlencoded({ extended: false, limit: '32kb' }), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Honeypot. A real form leaves it empty because it is hidden; a bot fills it.
  // Answer 200 either way so the bot cannot tell it was caught.
  if (clip(body.website, 200)) {
    log.info('contact honeypot tripped');
    return respond(req, res, true);
  }

  const email = clip(body.email, 254);
  const message = clip(body.message, 5000);
  const company = clip(body.company, 200);
  const topic = clip(body.topic, 40) || 'enterprise';

  if (!looksLikeEmail(email) || hasControlChars(email)) {
    return respond(req, res, false, 'a valid email address is required');
  }
  if (message.length < 10) {
    return respond(req, res, false, 'please say a little about what you need');
  }

  if (!mailerConfigured()) {
    // Do not pretend it was sent. A dropped enquiry is worse than an honest error,
    // because the sender walks away believing they have contacted you.
    log.error('contact enquiry received but no mailer is configured');
    return respond(req, res, false, 'contact is not configured on this server');
  }

  const text = [
    `New ${topic} enquiry from the pricing page.`,
    '',
    `From:    ${email}`,
    company ? `Company: ${company}` : null,
    '',
    message,
  ].filter((l) => l !== null).join('\n');

  try {
    const r = await sendMail({ to: TO, subject: `chat-recall ${topic} enquiry`, text });
    if (!r.sent) {
      log.error({ reason: r.reason }, 'contact enquiry not delivered');
      return respond(req, res, false, 'could not send right now — mail us directly');
    }
    log.info({ topic }, 'contact enquiry sent');
    return respond(req, res, true);
  } catch (e) {
    log.error({ err: e }, 'contact enquiry threw');
    return respond(req, res, false, 'could not send right now — mail us directly');
  }
});

/**
 * A browser posting a plain form wants a page back; an API caller wants JSON.
 * Decide on Accept rather than on a query flag, so the form needs no JS.
 */
function respond(req: express.Request, res: express.Response, ok: boolean, error?: string): void {
  const wantsHtml = (req.get('accept') || '').includes('text/html');
  if (!wantsHtml) {
    res.status(ok ? 200 : 400).json(ok ? { ok: true } : { ok: false, error });
    return;
  }
  const target = ok ? '/pricing/?sent=1' : `/pricing/?error=${encodeURIComponent(error || 'failed')}`;
  res.redirect(303, target);
}

export default router;
