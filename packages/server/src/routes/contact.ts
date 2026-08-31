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
import { compose } from '../auth/mail-template.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';
import { storeFeedback, markFeedbackMailed } from '../util/feedback.js';

const log = createLogger('contact');
const router = express.Router();

/** Where enquiries go. Overridable so a self-hoster can point it at themselves. */
const TO = process.env.CONTACT_TO || 'contact@chatrecall.dev';

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

  // KEPT BEFORE IT IS SENT. Storing first means a mailer that is down, throttled
  // or misconfigured costs a notification and not the message itself — and this
  // route ran for weeks writing to an inbox and nowhere else, so nothing anyone
  // said could be counted, reread, or joined to whether they later signed up.
  const stored = await storeFeedback({
    source: 'contact', topic, email, company, message,
  });

  if (!mailerConfigured()) {
    // Still an honest error to the sender: they asked for a reply, and nobody
    // has been told they are waiting. The message itself is safe above.
    log.error({ stored }, 'contact enquiry received but no mailer is configured');
    return respond(req, res, false, 'contact is not configured on this server');
  }

  // Through the same template as every other message this product sends.
  //
  // These two were the only ones built as bare `text`, so a mail client had
  // nothing to render and fell back to its plain-text default — a monospace
  // wall, in a product whose other mail is typeset. An enquiry is the first
  // thing a prospect ever causes us to send; it should not be the one that
  // looks unfinished.
  //
  // What they said goes in a `quote` block: it is someone else's words, and it
  // should read as theirs rather than as ours.
  const mail = compose({
    to: TO,
    subject: `chat-recall ${topic} enquiry`,
    preheader: `${email}${company ? ` · ${company}` : ''}`,
    blocks: [
      { kind: 'lead', text: `New ${topic} enquiry from the pricing page.` },
      { kind: 'p', text: company ? `From ${email} at ${company}.` : `From ${email}.` },
      { kind: 'quote', text: message },
      { kind: 'cta', label: 'Reply', url: `mailto:${email}` },
    ],
  });

  try {
    const r = await sendMail(mail);
    if (!r.sent) {
      log.error({ reason: r.reason }, 'contact enquiry not delivered');
      return respond(req, res, false, 'could not send right now — mail us directly');
    }
    log.info({ topic }, 'contact enquiry sent');
    if (stored) await markFeedbackMailed(stored);
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

/**
 * POST /api/contact/feedback — the terminal's version of the same thing.
 *
 * chat-recall's product surface is a CLI and an MCP server. There is no web app
 * for a survey widget to appear in, so the place a user is when they think "I
 * do not get this" is a shell prompt. This is what `chat-recall feedback "..."`
 * posts to.
 *
 * JSON rather than a form, no honeypot, no redirect: the sender is a program.
 * Rate limited the same as the form, because it is equally public.
 *
 * DELIBERATELY ACCEPTS ANONYMOUS. Requiring a login would lose exactly the
 * person worth hearing from — someone who could not finish setting it up. The
 * tenant is recorded when the caller happens to be authenticated and left null
 * otherwise, which is the normal case.
 */
router.post('/feedback', express.json({ limit: '16kb' }), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message = clip(body.message, 5000);
  if (message.length < 3) {
    res.status(400).json({ ok: false, error: 'message is required' });
    return;
  }
  const email = clip(body.email, 254);
  if (email && (!looksLikeEmail(email) || hasControlChars(email))) {
    res.status(400).json({ ok: false, error: 'that email address is not valid' });
    return;
  }

  const stored = await storeFeedback({
    source: 'cli',
    message,
    email: email || null,
    // Set by tenantAuth when the caller is logged in; absent for an anonymous
    // sender, which is allowed on purpose.
    tenant: (req as { tenant?: string }).tenant ?? null,
    cliVersion: clip(body.cliVersion, 20) || null,
    os: clip(body.os, 20) || null,
  });

  // Answer 200 as soon as it is kept. The mail is a convenience for the
  // operator; the user should not wait on it, and should never see it fail.
  res.status(200).json({ ok: true });

  if (!mailerConfigured() || !stored) return;
  try {
    const version = clip(body.cliVersion, 20);
    const who = email || 'someone who did not leave an address';
    const mail = compose({
      to: TO,
      subject: 'chat-recall feedback',
      preheader: `${who}${version ? ` · cli ${version}` : ''}`,
      blocks: [
        { kind: 'lead', text: 'Someone sent feedback from their terminal.' },
        {
          kind: 'p',
          text: version ? `From ${who}, running CLI ${version}.` : `From ${who}.`,
        },
        { kind: 'quote', text: message },
        // Only when there is somewhere to reply. A dead mailto: button is worse
        // than none: it looks like a way to answer and is not.
        ...(email ? [{ kind: 'cta' as const, label: 'Reply', url: `mailto:${email}` }] : []),
      ],
    });
    const r = await sendMail(mail);
    if (r.sent) await markFeedbackMailed(stored);
    else log.error({ reason: r.reason }, 'feedback mail not delivered (message is stored)');
  } catch (e) {
    log.error({ err: e }, 'feedback mail threw (message is stored)');
  }
});

export default router;
