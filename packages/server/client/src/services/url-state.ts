/**
 * URL-backed UI state.
 *
 * A query param is the source of truth for a piece of navigational state, so
 * the view is shareable, bookmarkable, and survives refresh + back/forward.
 *
 * Why replaceState by default: incidental toggles (switching a tab, flipping a
 * filter) should NOT push a history entry — otherwise the back button fills
 * with junk and takes a dozen taps to leave a page. Pass `push:true` only for
 * real navigations a user expects "back" to undo.
 *
 * Security note: the URL is not an access-control boundary — the server still
 * authorizes every data fetch (tenant token + entitlement). These params hold
 * only non-secret navigational identifiers (view, project id, tab name).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

function readParam(key: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(key);
  } catch {
    return null;
  }
}

function writeParam(key: string, value: string | null, push: boolean): void {
  try {
    const url = new URL(window.location.href);
    if (value == null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    if (url.href === window.location.href) return; // no-op — don't spam history
    const fn = push ? window.history.pushState : window.history.replaceState;
    fn.call(window.history, window.history.state, '', url);
  } catch {
    /* best-effort — URL state is a convenience, never load-bearing */
  }
}

export interface UrlStateOpts {
  /** push a history entry on change (default false → replaceState). */
  push?: boolean;
  /** reject params that aren't valid values (falls back to default). */
  valid?: (v: string) => boolean;
  /** drop the param when the owning component unmounts. */
  clearOnUnmount?: boolean;
}

/**
 * Like useState, but the value is mirrored to/from the `key` query param.
 * The default value is represented as the *absence* of the param (clean URLs).
 */
export function useUrlState(
  key: string,
  fallback: string,
  opts: UrlStateOpts = {},
): [string, (v: string) => void] {
  const { push = false, valid, clearOnUnmount } = opts;
  const validRef = useRef(valid);
  validRef.current = valid;

  const resolve = useCallback(
    (raw: string | null) => (raw && (!validRef.current || validRef.current(raw)) ? raw : fallback),
    [fallback],
  );

  const [val, setVal] = useState<string>(() => resolve(readParam(key)));

  const set = useCallback(
    (v: string) => {
      setVal(v);
      writeParam(key, v === fallback ? null : v, push);
    },
    [key, fallback, push],
  );

  useEffect(() => {
    const onPop = () => setVal(resolve(readParam(key)));
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (clearOnUnmount) writeParam(key, null, false);
    };
  }, [key, resolve, clearOnUnmount]);

  return [val, set];
}
