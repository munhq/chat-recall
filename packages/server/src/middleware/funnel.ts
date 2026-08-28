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
 * ── What it deliberately does not do ──────────────────────────────────────
 *
 * No bodies, no emails, no codes, no tokens. A funnel needs counts and a
 * step name; anything more makes this a log of people's credentials. The tenant
 * is unknown at these steps by definition, so events carry the step and the
 * outcome and nothing that identifies a person.
 */
import type { Request, Response, NextFunction } from 'express';
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

/**
 * Emit one funnel event per recognised auth request, after the response is
 * known.
 *
 * Reads the status rather than the body, because the body is the one thing that
 * carries credentials. `res.on('finish')` rather than wrapping the handler: this
 * must not be able to change what better-auth returns, and an error in telemetry
 * must never cost someone their sign-up.
 */
export function funnelTelemetry(req: Request, res: Response, next: NextFunction): void {
  const step = stepFor(req.path);
  if (!step) return next();

  res.on('finish', () => {
    try {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      growth(ok ? 'funnel' : 'funnel_fail', {
        extra: { step, status: res.statusCode },
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
  next();
}
