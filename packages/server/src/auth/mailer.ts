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
 *   SMTP_SECURE    'true' for implicit TLS (port 465); default false → STARTTLS
 *   SMTP_USER      optional (an authenticated relay needs it; a local one may not)
 *   SMTP_PASS      optional, pairs with SMTP_USER
 *   MAIL_FROM      default 'chat-recall <noreply@chatrecall.dev>'
 */

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** True when a real SMTP transport is configured. */
export function mailerConfigured(): boolean {
  return !!process.env.SMTP_HOST;
}

function mailFrom(): string {
  return process.env.MAIL_FROM || 'chat-recall <noreply@chatrecall.dev>';
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
      return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
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
export async function sendMail(mail: Mail): Promise<{ sent: boolean; reason?: string }> {
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
    await t.sendMail({ from: mailFrom(), to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
    return { sent: true };
  } catch (err) {
    // Log and swallow: see the doc comment above on why this cannot propagate.
    console.error(`[mailer] send to ${mail.to} failed:`, err instanceof Error ? err.message : err);
    return { sent: false, reason: 'send-failed' };
  }
}

/** The password-reset message. Kept here so the wording lives with the transport
 *  rather than inside the auth config. */
export function resetPasswordMail(to: string, url: string, expiresInMinutes: number): Mail {
  const text = [
    'Someone asked to reset the password for your chat-recall account.',
    '',
    'Open this link to choose a new one:',
    url,
    '',
    `The link works once and expires in ${expiresInMinutes} minutes.`,
    'If this was not you, ignore this message — nothing has changed.',
  ].join('\n');
  return { to, subject: 'Reset your chat-recall password', text };
}
