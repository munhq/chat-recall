/**
 * What a sync failure is CALLED, which is the only thing the fleet panel ever
 * sees of it.
 *
 * ── The failure this file exists to prevent ──────────────────────────────
 * The classifier read the error message. The 402 handler deliberately prints the
 * server's own sentence instead of the HTTP line — "sync paused by the server:
 * monthly sync quota reached…" — and appends the upgrade URL from the response
 * body. So `402` was gone from the message and `https://` was in it, and a
 * substring test for `https` filed every quota pause as `insecure_transport`.
 *
 * One device reported 651 of them in a week. The panel rendered that as
 * "refusing to sync to a server over plain HTTP — nothing from this device is
 * reaching it", about a LAN box on http:// that the transport gate had never
 * objected to, while the real cause — a paused meter — had no warning at all.
 *
 * The same rewritten message defeated the retry gate, which asked /HTTP 4\d\d/
 * whether a failure was fatal. Four retries with backoff, per batch, for days,
 * against a condition that cannot change until a human acts.
 */
import { describe, test, expect } from 'vitest';
import { classifyError, classedError, isStandingFailure } from './sync-client.js';

/** The exact message the collector built in the field, upgrade URL included. */
const QUOTA_MESSAGE =
  'sync paused by the server: monthly sync quota reached — sync resumes next month, '
  + 'or upgrade for unmetered sync (resets 2026-09-01)\n  https://chatrecall.dev/pricing';

describe('the class travels with the error', () => {
  test('a 402 is payment_required even though its message says neither', () => {
    const err = classedError('payment_required', QUOTA_MESSAGE);
    expect(classifyError(err.message, err)).toBe('payment_required');
  });

  test('the tag beats every message test', () => {
    // A message that would sniff as `auth` (it contains "token").
    const err = classedError('payment_required', 'quota reached, no token needed');
    expect(classifyError(err.message, err)).toBe('payment_required');
  });

  test('a standing condition stops the retry loop', () => {
    expect(isStandingFailure(classedError('payment_required', QUOTA_MESSAGE))).toBe(true);
    expect(isStandingFailure(classedError('auth', 'revoked'))).toBe(true);
    expect(isStandingFailure(classedError('insecure_transport', 'nope'))).toBe(true);
    // Transient classes must still be retried.
    expect(isStandingFailure(classedError('rate_limited', '429'))).toBe(false);
    expect(isStandingFailure(classedError('network', 'fetch failed'))).toBe(false);
    expect(isStandingFailure(new Error('fetch failed'))).toBe(false);
  });
});

describe('the message fallback no longer guesses insecure transport', () => {
  // THE REGRESSION. Untagged, this is what an older collector sends.
  test('a quota message quoting an upgrade URL is not a transport problem', () => {
    expect(classifyError(QUOTA_MESSAGE)).not.toBe('insecure_transport');
  });

  test('a 5xx that quotes the target URL is a server error', () => {
    expect(classifyError('sync failed: HTTP 503 posting to https://recall.example.com/api/sync'))
      .toBe('server_error');
  });

  test('only the transport gate’s own wording means insecure transport', () => {
    expect(classifyError('refusing to sync to recall.example.com over plain HTTP — your transcripts'))
      .toBe('insecure_transport');
    expect(classifyError("unsupported scheme 'ftp:' — use https://")).toBe('insecure_transport');
  });

  test('the classes that were already right stay right', () => {
    expect(classifyError('sync failed: HTTP 429 too many requests')).toBe('rate_limited');
    expect(classifyError('append sync failed: HTTP 402 {"kind":"sync_quota"}')).toBe('payment_required');
    expect(classifyError("server rejected this machine's device token (HTTP 401 — revoked?)")).toBe('auth');
    expect(classifyError('http://192.168.1.9:8085 resolves but refused the connection (fetch failed: ECONNREFUSED)'))
      .toBe('refused');
    expect(classifyError('The operation was aborted due to timeout')).toBe('timeout');
    expect(classifyError('fetch failed')).toBe('network');
    expect(classifyError('something nobody has seen before')).toBe('other');
  });
});
