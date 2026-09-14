/**
 * Outbound mail for the auth flows (password reset today; verification later).
 *
 * ── Why this degrades instead of failing ────────────────────────────────────
 *
 * There are two deployments and only one of them has mail. The cloud sends
 * through Stalwart on the fleet's own domain; a self-hoster running
 * docker-compose has no SMTP server and no reason to configure one just to
 * reset their own password.
 *
 * So an unconfigured mailer is NOT an error. It logs the message — reset link
 * included — at warn level, and the operator completes the reset from
 * `docker compose logs`. That is deliberate: the alternative designs are worse.
 * Throwing would surface "reset failed" to a user who has no way to fix it, and
 * silently dropping would look identical to a working system while every reset
 * vanished. Printing the link is the only option where a single-operator
 * install can still recover an account.
 *
 * The link is a single-use token that expires in an hour, and it only appears
 * in logs the operator already controls. On the cloud, SMTP_HOST is always set,
 * so this branch never runs there.
 *
 * ── Configuration ──────────────────────────────────────────────────────────
 *   SMTP_HOST      required to enable sending; unset = log-only mode
 *   SMTP_PORT      default 587
 *   SMTP_SECURE    'true' for implicit TLS; inferred for port 465 (see below)
 *   SMTP_USER      optional (an authenticated relay needs it; a local one may not)
 *   SMTP_PASS      optional, pairs with SMTP_USER
 *   MAIL_FROM      sender; EMAIL_FROM is accepted as the fleet's spelling
 *
 * Outbound is AWS SES (email-smtp.eu-central-1.amazonaws.com); Stalwart is the
 * mailbox server for inbound and never sends for the app.
 */



/**
 * Build one message from the copy pack.
 *
 * Returns null when the deployment has no pack, or no entry for this id. Every
 * caller passes that straight to `sendMail`, which treats it as "do not send".
 * There is deliberately no wording here to fall back to: wording that exists as
 * a fallback is wording that lives in this public repository.
 */
async function fromPack(id: string, to: string, vars: Record<string, string | number | undefined> = {}): Promise<Mail | null> {
  const kit = await mailkit();
  if (!kit) return null;
  return renderMail(kit.copy(id, to, vars), kit);
}

/**
 * Render a pack message that a caller already assembled.
 *
 * The trial track fills a stats row from live counts before rendering, so it
 * needs the message as data first and the rendered mail second. Null in, null
 * out, so "the pack has nothing for this" travels all the way to `sendMail`.
 */
export function renderMail(
  m: { to: string; subject: string; preheader: string; blocks: unknown[]; footer?: unknown[]; from?: string; replyTo?: string } | null,
  kit: NonNullable<Awaited<ReturnType<typeof mailkit>>>,
): Mail | null {
  if (!m) return null;
  const { from, replyTo, ...message } = m;
  return {
    ...kit.compose(message as never),
    ...(from ? { from } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
}

import { mailkit } from './mail-kit.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * Sender, when it should not be the fleet's default.
   *
   * A message that asks somebody to write back should come from a person, and
   * a reply is worth more to a young domain's reputation than any header: an
   * inbox provider reads a reply as the strongest possible signal that this
   * sender is wanted. Must stay on a domain whose SPF, DKIM and MAIL FROM are
   * aligned, or the DMARC policy quarantines our own mail.
   */
  from?: string;
  /** Where a reply goes, when that differs from the sender. */
  replyTo?: string;
}

/** The account page on THIS deployment — where a person manages or cancels a
 *  subscription. Derived from the app's own base URL, so a self-hoster's mail
 *  links to their server. There is no direct link to the Stripe portal: opening
 *  it is a POST that needs an authenticated session, so the account page is the
 *  only address that works from an inbox. */
function accountUrl(): string {
  const base = (process.env.BETTER_AUTH_URL || process.env.APP_URL || 'https://chatrecall.dev').replace(/\/+$/, '');
  return `${base}/app?view=account`;
}

/** True when a real SMTP transport is configured. */
export function mailerConfigured(): boolean {
  return !!process.env.SMTP_HOST;
}

function mailFrom(): string {
  // EMAIL_FROM is what every other chart in the fleet sets; accept both so the
  // same values.yaml shape works here without a special case.
  return process.env.MAIL_FROM || process.env.EMAIL_FROM || 'chat-recall <noreply@chatrecall.dev>';
}

/** Implicit TLS on 465, STARTTLS on 587.
 *
 *  Inferred from the port rather than read from SMTP_SECURE alone, because the
 *  failure mode of getting it wrong is silent: nodemailer on 465 without
 *  `secure` waits for a plaintext greeting that never comes and the send hangs
 *  until timeout. The fleet's other charts set port 465, so this is the likely
 *  misconfiguration, not a hypothetical one. */
function smtpSecure(port: number): boolean {
  if (process.env.SMTP_SECURE === 'true') return true;
  if (process.env.SMTP_SECURE === 'false') return false;
  return port === 465;
}

// nodemailer is imported lazily and the transport is cached: a self-host
// install that never sends mail should not pay to load it, and the cloud
// should not build a new connection pool per reset.
let transportPromise: Promise<any> | null = null;

async function transport(): Promise<any> {
  if (!transportPromise) {
    transportPromise = (async () => {
      const nodemailer = await import('nodemailer');
      const user = process.env.SMTP_USER;
      const pass = process.env.SMTP_PASS;
      const port = Number(process.env.SMTP_PORT) || 587;
      return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: smtpSecure(port),
        auth: user && pass ? { user, pass } : undefined,
      });
    })();
    // A failed construction must not be cached, or every later send inherits it.
    transportPromise.catch(() => { transportPromise = null; });
  }
  return transportPromise;
}

/**
 * Send a message, or log it when no SMTP is configured.
 *
 * Never throws. A caller in an auth flow must not turn a mail failure into a
 * user-visible error, because the response to "forgot password" is deliberately
 * identical whether or not the address exists — surfacing a send failure would
 * leak that the account is real.
 */
export async function sendMail(
  input: Mail | null | Promise<Mail | null>,
): Promise<{ sent: boolean; reason?: string }> {
  const mail = await input;
  // A builder answers null when the copy pack has nothing for it. Sending is
  // skipped and said out loud, because a mailer that quietly sends nothing
  // reads exactly like a quiet week.
  if (!mail) {
    console.warn('[mailer] no copy for this message — nothing sent. Check MAIL_COPY_FILE.');
    return { sent: false, reason: 'no-copy' };
  }
  if (!mailerConfigured()) {
    console.warn(
      `[mailer] SMTP_HOST is not set — printing the message instead of sending it.\n` +
        `  to:      ${mail.to}\n` +
        `  subject: ${mail.subject}\n` +
        `${mail.text.split('\n').map((l) => `  | ${l}`).join('\n')}`,
    );
    return { sent: false, reason: 'no-smtp' };
  }
  try {
    const t = await transport();
    await t.sendMail({
      from: mail.from || mailFrom(),
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      to: mail.to, subject: mail.subject, text: mail.text, html: mail.html,
    });
    return { sent: true };
  } catch (err) {
    // Log and swallow: see the doc comment above on why this cannot propagate.
    console.error(`[mailer] send to ${mail.to} failed:`, err instanceof Error ? err.message : err);
    return { sent: false, reason: 'send-failed' };
  }
}

const SELF_HOST_URL = 'https://chatrecall.dev/self-hosting/';

/** The password-reset message. */
export async function resetPasswordMail(to: string, url: string, expiresInMinutes: number): Promise<Mail | null> {
  return fromPack('auth.reset_link', to, { url, minutes: expiresInMinutes });
}

/**
 * The confirmation CODE.
 *
 * This replaced a link. A link is one click and it is what most products send,
 * but two things kill it silently here: corporate mail scanners GET every URL to
 * check it, which spends a single-use verification token before the human ever
 * clicks; and a link opened in the default browser — or on a phone — lands in a
 * different session from the one that signed up. Neither leaves a trace, so both
 * arrive as "it doesn't work" with nothing in the logs.
 *
 * A code cannot be spent by something reading the mail, and it finishes in the
 * tab the person is already looking at.
 *
 * The `otp` block is what keeps one-tap autofill working: the code stands alone
 * on its own line in the plain-text part, unindented, and sits in its own
 * element as literal text in the HTML part. iOS and Android match that shape.
 */
export async function verifyOtpMail(
  to: string,
  otp: string,
  type: 'sign-in' | 'email-verification' | 'forget-password' | 'change-email',
): Promise<Mail | null> {
  const id = type === 'forget-password' ? 'auth.otp.reset' : 'auth.otp.verify';
  return fromPack(id, to, { code: otp });
}

/**
 * The pre-charge notice for a CARD trial, and the self-host licence.
 *
 * A pre-charge notice is the thing that stops a charge being a surprise, and an
 * unsurprised customer does not open a dispute. The no-card trial has its own
 * entirely separate set of reminders in services/trial-reminders.ts. Do not
 * merge the two again.
 */
export async function trialEndingMail(to: string, chargesAt: Date, manageUrl?: string): Promise<Mail | null> {
  const when = chargesAt.toISOString().slice(0, 10);
  return fromPack('billing.trial_ending', to, { when, manageUrl: manageUrl || accountUrl() });
}

/** The self-host licence email. The serial is the deliverable, so it leads. */
export async function licenceSerialMail(to: string, serial: string, interval: 'month' | 'year'): Promise<Mail | null> {
  return fromPack(`billing.licence_serial.${interval}`, to, { serial, selfHostUrl: SELF_HOST_URL });
}
