/**
 * Whether this machine may report operational telemetry, and what counts as it.
 *
 * TWO INDEPENDENT GATES, both of which must open. They are separate on purpose:
 * one answers "is the user willing", the other "is the operator entitled", and
 * conflating them is how a product ends up collecting from someone who said no.
 *
 *   1. CONSENT — the user's setting, checked on this machine. It wins over
 *      everything. No server response can override it, because a server should
 *      not be able to talk a client into sending data its owner declined.
 *
 *   2. ELIGIBILITY — the server says whether this tenant's plan includes it.
 *      The client cannot know its own plan (the entitlement lives in the control
 *      plane), so it is told, and it defaults to NOT eligible: an older server
 *      that says nothing gets nothing.
 *
 * The server enforces (2) again at ingest. This gate is an optimisation — it
 * stops the data leaving a machine that shouldn't send it — not the boundary.
 *
 * ── What may be reported, and what may never be ──────────────────────────
 * Operational facts about the COLLECTOR, never about the user's work:
 *
 *   allowed   walk duration, sessions considered/shipped, bytes uploaded,
 *             429/failure counts, breaker trips, RSS peak, CLI version, OS,
 *             error CLASS plus a redacted message
 *   forbidden transcript content, prompts, file paths, project names, session
 *             ids, repository names, anything derived from what the user wrote
 *
 * `assertNoSensitiveKeys` enforces the second list structurally rather than by
 * review, because "no paths" is exactly the promise that erodes one convenient
 * field at a time.
 */
import { loadSettings } from '@chat-recall/engine/core/settings.js';

/** Env kill-switch, for a machine where editing settings is not practical. */
const ENV_OFF = (): boolean => {
  const v = (process.env.CHAT_RECALL_TELEMETRY || '').trim().toLowerCase();
  return v === '0' || v === 'off' || v === 'false' || v === 'no';
};

/**
 * Has the user opted out?
 *
 * Default is ON for the operational facts above — an opt-OUT, which is what the
 * product intends and what the docs must say plainly. Anything that touches user
 * CONTENT is not covered by this and is not collected at all, at any setting.
 */
export function userConsents(): boolean {
  if (ENV_OFF()) return false;
  try {
    const s = loadSettings() as { privacy?: { telemetry?: boolean } };
    return s.privacy?.telemetry !== false;
  } catch {
    // Unreadable settings must not be read as consent.
    return false;
  }
}

/** Eligibility as last reported by a server, keyed by server URL. */
const eligible = new Map<string, boolean>();

/** Record what the server said about this tenant's plan. */
export function setTelemetryEligible(serverUrl: string, allowed: boolean): void {
  eligible.set(serverUrl.replace(/\/+$/, ''), allowed);
}

/** Default NO: a server that never said yes never gets telemetry. */
export function serverAllowsTelemetry(serverUrl: string): boolean {
  return eligible.get(serverUrl.replace(/\/+$/, '')) === true;
}

/** Test seam. */
export function _resetTelemetryEligibility(): void { eligible.clear(); }

/** Both gates, for one target. */
export function mayReport(serverUrl: string): boolean {
  return userConsents() && serverAllowsTelemetry(serverUrl);
}

/**
 * Keys that must never appear in a telemetry payload.
 *
 * Checked structurally so the promise survives the next person adding "just the
 * project name for context". A violation throws in development and drops the
 * event in production — never sends it anyway.
 */
const FORBIDDEN_KEY = /(path|dir|file|project|repo|session|prompt|content|text|title|branch|url|email|user|home|cwd)/i;

export interface SensitiveKeyViolation { key: string; where: string }

/** Every forbidden key in `obj`, deeply. Empty means safe to send. */
export function findSensitiveKeys(obj: unknown, where = ''): SensitiveKeyViolation[] {
  const out: SensitiveKeyViolation[] = [];
  const walk = (v: unknown, at: string): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((e, i) => walk(e, `${at}[${i}]`)); return; }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(k)) out.push({ key: k, where: at || '(root)' });
      walk(val, at ? `${at}.${k}` : k);
    }
  };
  walk(obj, where);
  return out;
}

/**
 * Throw when a payload carries a forbidden key.
 *
 * Deliberately loud: a telemetry event that leaks a file path is a privacy
 * incident, and the cheapest place to stop it is the type of failure a developer
 * cannot ignore.
 */
export function assertNoSensitiveKeys(payload: unknown): void {
  const bad = findSensitiveKeys(payload);
  if (bad.length > 0) {
    throw new Error(
      `telemetry payload carries forbidden key(s): ${bad.map((b) => `${b.where}.${b.key}`).join(', ')}. `
      + 'Operational telemetry must describe the COLLECTOR, never the user\'s work.',
    );
  }
}
