/**
 * "Did this visitor just finish paying?", in one place.
 *
 * Four client call sites had their own copy of the same anchored regex — the
 * paywall override in App, the licence panel in AccountPage, the 401 redirect and
 * the OAuth callback path in auth. They encode ONE decision, and if any two drift
 * apart the paywall-versus-licence split breaks silently: the buyer either meets
 * a "your subscription has ended" screen having just paid, or loses the only
 * route back to their serial.
 *
 * The shape check is the security boundary as well as a sanity check. The
 * character class holds no `/`, `?`, `#`, `&`, `:`, `%` or `.`, so a value that
 * passes cannot escape the path it is interpolated into, append a parameter, or
 * become an absolute or protocol-relative URL.
 */

/** Stripe Checkout Session ids, as they appear in a success redirect. */
const CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]{10,200}$/;

/** True for a string that is shaped like a Stripe Checkout Session id. */
export function isCheckoutSessionId(value: string | null | undefined): boolean {
  return !!value && CHECKOUT_SESSION_ID.test(value);
}

/**
 * The session id from a COMPLETED checkout redirect, or null.
 *
 * Requires both halves: `checkout=success` (Stripe reached the success_url) and a
 * well-formed `session_id`. Reads `window.location` unless a search string is
 * passed, which is what makes it testable.
 */
export function completedCheckoutSessionId(search?: string): string | null {
  try {
    const q = new URLSearchParams(search ?? window.location.search);
    if (q.get('checkout') !== 'success') return null;
    const id = q.get('session_id');
    return isCheckoutSessionId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Where to land someone carrying a completed checkout: the account view, which is
 * the only place the licence panel renders. Null when there is nothing to carry.
 */
export function checkoutReturnPath(search?: string): string | null {
  const id = completedCheckoutSessionId(search);
  return id ? `/?view=account&checkout=success&session_id=${encodeURIComponent(id)}` : null;
}
