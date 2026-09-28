/**
 * Funnel telemetry for the steps a user can FAIL at.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * There were three growth events — install, activate, convert — and every one
 * fires after the user has already succeeded: `install` needs a workspace, which
 * needs a completed login. So the funnel could only ever show people who made
 * it, and every question worth asking is about the ones who did not.
 *
 * That gap was not theoretical. Twelve `chat-recall init` runs reached the
 * sign-in prompt and abandoned, and the only reason anyone could see them is
 * that better-auth happens to persist a deviceCode row. Nothing recorded a
 * signup that never confirmed, a verification code typed wrong, or a login
 * prompt closed. On 2026-08-25 a single sign-up produced three separate bugs —
 * a blank page, a trial length that changed itself, and no way to resend — and
 * all three were found by a human trying it, not by the product noticing.
 *
 * ── Why SERVER-side, and not in the CLI ───────────────────────────────────
 *
 * The obvious place is the CLI, and it is the wrong one. reportClientEvent
 * loads credentials before it sends, so a machine that never finished logging in
 * cannot report that it never finished logging in — the measurement is
 * impossible for exactly the population it is about. Every event here is emitted
 * by the server, on a request the user makes BEFORE they have succeeded.
 *
 * ── What a failure carries ────────────────────────────────────────────────
 *
 * A success carries the step and the status and nothing else: the account that
 * succeeded is already known to every table downstream.
 *
 * A failure also carries the address the person typed, or the address of the
 * signed-in account for a step like `device/approve`. Before this, a failure was
 * a step name and a status. The Health page showed three failed sign-ins and two
 * failed connector steps in the week six accounts signed up and never ran the
 * product, and nothing could say whether any of those six were among them.
 *
 * Never a password, a code or a token. The address is read by an after-hook in
 * better-auth (see `noteAttemptedEmail`), which receives the parsed body, and it
 * is kept only when it has the shape of an address.
 */
import type { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { growth } from '../util/growth.js';

/**
 * Which auth requests are funnel steps, and what to call them.
 *
 * Matched on the path better-auth exposes, longest first so `/device/token`
 * cannot be swallowed by a prefix. Anything unlisted is ignored: this is a
 * funnel, not request logging, and a list that grows on its own stops being
 * readable.
 */
const STEPS: Array<[test: RegExp, step: string]> = [
  [/\/sign-up\/email$/, 'signup'],
  [/\/sign-in\/email$/, 'signin'],
  [/\/sign-in\/social$/, 'signin_social'],
  [/\/email-otp\/send-verification-otp$/, 'verify_code_sent'],
  [/\/email-otp\/verify-email$/, 'verify_code_entered'],
  // The CLI's login. `device/code` is the prompt appearing on someone's
  // terminal; `device/approve` is them actually going through with it. The gap
  // between those two counts is the number this was built to see.
  [/\/device\/code$/, 'cli_login_prompt'],
  [/\/device\/approve$/, 'cli_login_approved'],
  [/\/device\/deny$/, 'cli_login_denied'],
  // OAuth connector: a client registering, then a user consenting.
  [/\/mcp\/register$/, 'connector_registered'],
  [/\/mcp\/token$/, 'connector_authorized'],
];

/**
 * Steps a client retries on its own, where a raw count measures impatience
 * rather than interest.
 *
 * Only device/code is polled today. `/device/approve` fires once, when the
 * human actually clicks, and must stay uncollapsed — it is the number the whole
 * middleware exists to compare against.
 */
const POLLED_STEPS = new Set(['cli_login_prompt']);

function stepFor(path: string): string | null {
  for (const [test, step] of STEPS) if (test.test(path)) return step;
  return null;
}

/** Who a funnel request was about, filled in while better-auth handles it. */
interface FunnelIdentity { email?: string }

/**
 * One store per funnel request. better-auth builds its own Fetch Request from the
 * Node one, so its hooks have no handle on `req`; the async context is the link
 * between the hook that knows the address and the `finish` listener that emits.
 */
const identity = new AsyncLocalStorage<FunnelIdentity>();

/** RFC 5321 caps a path at 254 characters. */
const MAX_EMAIL = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Record the address a funnel request is about.
 *
 * Called from better-auth's after-hook, which runs on a refused request as well
 * as an accepted one. Outside a funnel request there is no store and the call
 * does nothing. The first address wins, so the one the person typed is kept
 * over the session's.
 */
export function noteAttemptedEmail(...candidates: unknown[]): void {
  const store = identity.getStore();
  if (!store || store.email) return;
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const email = c.trim().toLowerCase();
    if (email.length <= MAX_EMAIL && EMAIL_SHAPE.test(email)) { store.email = email; return; }
  }
}

/**
 * Emit one funnel event per recognised auth request, after the response is
 * known.
 *
 * The middleware never reads the body, because the body carries credentials;
 * the address comes from `noteAttemptedEmail`. The event is emitted on
 * `res.on('finish')`, so it cannot change what better-auth returns, and an error
 * in telemetry never costs someone their sign-up.
 */
export function funnelTelemetry(req: Request, res: Response, next: NextFunction): void {
  const step = stepFor(req.path);
  if (!step) return next();

  const who: FunnelIdentity = {};
  res.on('finish', () => {
    try {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      growth(ok ? 'funnel' : 'funnel_fail', {
        extra: ok || !who.email
          ? { step, status: res.statusCode }
          : { step, status: res.statusCode, email: who.email },
        // Collapse the polled steps to one row per day.
        //
        // `/device/code` is POLLED: the CLI asks repeatedly while the human
        // decides in a browser, so one person approving a login produced 120
        // rows in a day against 3 approvals. That does not read as "polling",
        // it reads as 117 people who walked away, and it was the single most
        // prominent number on the funnel.
        //
        // oncePerDay is per PROCESS and keyed on the tenant, and this step has
        // no tenant yet — nobody has logged in. So it collapses per replica per
        // day, which turns 120 into single digits: still not a headcount, but
        // no longer an order of magnitude wrong. A real distinct-visitor count
        // needs an identifier the pre-auth CLI does not have.
        oncePerDay: POLLED_STEPS.has(step),
      });
    } catch { /* telemetry must never affect the request */ }
  });
  identity.run(who, next);
}
