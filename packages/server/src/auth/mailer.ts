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

/**
 * The address-confirmation message.
 *
 * It leads with what confirming unlocks rather than with the word "verify",
 * because the trial does not start until this link is opened — so this mail is
 * the first step of the product, not an administrative chore.
 */
export function verifyEmailMail(to: string, url: string): Mail {
  const text = [
    'Confirm this address to start your chat-recall trial.',
    '',
    url,
    '',
    'Your trial begins when you open that link, so nothing is counting down',
    'until you do. You can sign in and look around before confirming.',
    '',
    'If you did not create a chat-recall account, ignore this message.',
  ].join('\n');
  return { to, subject: 'Confirm your email to start your chat-recall trial', text };
}

/**
 * Trial-ending notice.
 *
 * The pricing page says, twice, "We email you before the trial ends." Nothing
 * sent it: the live webhook was not subscribed to
 * customer.subscription.trial_will_end, nothing handled it, and no reminder
 * existed here. A trial lapsed in silence and the customer found out when sync
 * stopped, which is the worst possible moment to learn it.
 *
 * Stripe fires trial_will_end three days out. The mail leads with what actually
 * happens, because the honest answer is still reassuring: nothing is deleted and
 * export always works, even though recall itself stops. "Everything already
 * synced stays searchable" was the old promise and is no longer true — see the
 * hard stop in util/billing.ts.
 */
export function trialEndingMail(to: string, endsAt: Date, upgradeUrl: string): Mail {
  const when = endsAt.toISOString().slice(0, 10);
  const text = [
    `Your chat-recall trial ends on ${when}.`,
    '',
    'If you do nothing:',
    '',
    '  - recall switches off: searches stop answering',
    '  - new sessions stop syncing',
    '  - your history stays on the server, and export keeps working',
    '  - nothing is deleted',
    '',
    'Because your transcripts live on your own disk, one `chat-recall sync --full`',
    'brings the server current again the day you subscribe. You lose no history by',
    'waiting.',
    '',
    'Keep syncing:',
    '',
    `  ${upgradeUrl}`,
    '',
    'Or run the server yourself instead — free forever for one person, every',
    'feature, no licence key: https://chatrecall.dev/self-hosting/',
    '',
    'Questions: contact@chatrecall.dev',
  ].join('\n');
  return { to, subject: `Your chat-recall trial ends on ${when}`, text };
}

/** The self-host licence email. The serial is the deliverable, so it leads. */
export function licenceSerialMail(to: string, serial: string, interval: 'month' | 'year'): Mail {
  const text = [
    'Your chat-recall self-host licence is ready.',
    '',
    `  ${serial}`,
    '',
    'Set it on your server and restart:',
    '',
    `  CHAT_RECALL_LICENSE_SERIAL=${serial}`,
    '',
    'That unlocks COLLABORATION on your own infrastructure: a second member, shared',
    'project history, assigning work to a teammate, and per-member activity.',
    'Running chat-recall for one person is free and already includes the whole',
    'single-user product — sync, code findings, secret monitoring, analytics, your',
    'own task board and Toolkit. This licence adds the second person, not the',
    'product.',
    '',
    'The server checks the licence periodically and keeps working for up to two weeks',
    'if it cannot reach us, so a network problem on either side never stops your',
    'install.',
    '',
    `Billed ${interval === 'year' ? 'annually' : 'monthly'}. Cancel any time from the`,
    'billing portal; your data is yours and stays on your hardware either way.',
    '',
    'Questions: contact@chatrecall.dev',
  ].join('\n');
  return { to, subject: 'Your chat-recall self-host licence', text };
}
