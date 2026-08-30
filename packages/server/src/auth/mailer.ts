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

import { compose } from './mail-template.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
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

const SELF_HOST_URL = 'https://chatrecall.dev/self-hosting/';

/** The password-reset message. Kept here so the wording lives with the transport
 *  rather than inside the auth config. */
export function resetPasswordMail(to: string, url: string, expiresInMinutes: number): Mail {
  return compose({
    to,
    subject: 'Reset your chat-recall password',
    preheader: `The link works once and expires in ${expiresInMinutes} minutes.`,
    blocks: [
      { kind: 'lead', text: 'Someone asked to reset the password for your chat-recall account.' },
      { kind: 'p', text: 'If it was you, choose a new one here:' },
      { kind: 'cta', label: 'Choose a new password', url },
      { kind: 'small', text: `The link works once and expires in ${expiresInMinutes} minutes.` },
      { kind: 'p', text: 'If it was not you, ignore this message. Nothing has changed, and nobody can reach your account with it.' },
    ],
  });
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
 * ── Why the code is a `code` block in BOTH renderings ──────────────────────
 *
 * The plain-text form puts it on its own line with nothing after it, because
 * that is what makes it selectable on a phone and what iOS and Android match
 * when they offer one-tap autofill. The HTML form must not undo that: the code
 * sits alone in its own element, as literal text, never split across tags and
 * never rendered as an image. Both autofill paths keep working.
 */
export function verifyOtpMail(
  to: string,
  otp: string,
  type: 'sign-in' | 'email-verification' | 'forget-password' | 'change-email',
): Mail {
  const reset = type === 'forget-password';
  return compose({
    to,
    subject: reset ? 'Your chat-recall password reset code' : 'Your chat-recall confirmation code',
    preheader: `${otp} — it expires in 15 minutes.`,
    blocks: [
      {
        kind: 'lead',
        text: reset
          ? 'Enter this code to reset your password:'
          : 'Enter this code to confirm your address and start your trial:',
      },
      { kind: 'otp', code: otp },
      { kind: 'small', text: 'It expires in 15 minutes.' },
      {
        kind: 'p',
        text: reset
          ? 'If you did not ask to reset your password, ignore this message and nothing changes.'
          : 'Your trial begins when you enter it, so nothing is counting down until you do.',
      },
      { kind: 'small', text: 'If you did not create a chat-recall account, ignore this message.' },
    ],
  });
}

/**
 * Trial-ending notice — for a STRIPE trial, which always has a card behind it.
 *
 * ── What this message is, and what it is not ───────────────────────────────
 *
 * This fires on `customer.subscription.trial_will_end`, and a Stripe trial only
 * exists AFTER checkout (see the trialArg block in routes/billing.ts): a card is
 * on file by definition. So "if you do nothing" here does not mean access lapses
 * — it means the customer is CHARGED.
 *
 * The previous copy said the opposite. It was the no-card reminder's text on the
 * card-trial's trigger, so it warned a paying customer that their access was
 * about to switch off three days before taking their money. That is the single
 * worst thing a message in a billing flow can get backwards: it invites a
 * cancellation from someone who was happy, and a dispute from someone who was
 * not reading closely.
 *
 * The no-card trial has its own, entirely separate set of reminders in
 * services/trial-reminders.ts. Do not merge the two again.
 *
 * A pre-charge notice is also simply the right thing to send. It is what stops a
 * charge being a surprise, and an unsurprised customer does not open a dispute.
 */
export function trialEndingMail(to: string, chargesAt: Date, manageUrl?: string): Mail {
  const when = chargesAt.toISOString().slice(0, 10);
  const manage = manageUrl || accountUrl();
  return compose({
    to,
    subject: `Your chat-recall subscription starts on ${when}`,
    preheader: 'Nothing switches off. This is only so the charge is not a surprise.',
    blocks: [
      { kind: 'lead', text: `Your chat-recall trial ends on ${when}, and your subscription starts the same day.` },
      { kind: 'p', text: 'You have a card on file, so nothing switches off and nothing breaks. This message exists only so the charge is never a surprise.' },
      { kind: 'p', text: 'If that is what you want, there is nothing to do. Recall keeps answering, your sessions keep syncing, and everything you built up during the trial carries straight over.' },
      { kind: 'p', text: `If it is not, cancel before ${when} and you will not be charged:` },
      { kind: 'cta', label: 'Manage or cancel your subscription', url: manage },
      { kind: 'p', text: 'Either way the data stays yours. Cancelling deletes nothing, export always works, and your transcripts never stopped living on your own disk.' },
    ],
  });
}

/** The self-host licence email. The serial is the deliverable, so it leads. */
export function licenceSerialMail(to: string, serial: string, interval: 'month' | 'year'): Mail {
  return compose({
    to,
    subject: 'Your chat-recall self-host licence',
    preheader: `${serial} — set it on your server and restart.`,
    blocks: [
      { kind: 'lead', text: 'Your chat-recall self-host licence is ready.' },
      { kind: 'code', lines: [serial] },
      { kind: 'p', text: 'Set it on your server and restart:' },
      { kind: 'code', lines: [`CHAT_RECALL_LICENSE_SERIAL=${serial}`] },
      { kind: 'p', text: 'That unlocks collaboration on your own infrastructure: a second member, shared project history, assigning work to a teammate, and per-member activity.' },
      { kind: 'p', text: 'Running chat-recall for one person stays free and already includes the whole single-user product — sync, code findings, secret monitoring, analytics, your own task board and Toolkit. This licence adds the second person, not the product.' },
      { kind: 'p', text: 'The server checks the licence periodically and keeps working for up to two weeks if it cannot reach us, so a network problem on either side never stops your install.' },
      { kind: 'small', text: `Billed ${interval === 'year' ? 'annually' : 'monthly'}. Cancel any time from the billing portal; your data is yours and stays on your hardware either way.` },
      { kind: 'links', items: [{ label: 'Self-hosting guide', url: SELF_HOST_URL }] },
    ],
  });
}
