import { useEffect } from 'react';

/**
 * Let the DOCUMENT scroll for as long as this component is mounted.
 *
 * `index.css` sets `body { overflow: hidden }` with `html, body, #root {
 * height: 100% }`. That is right for the signed-in app shell — the window never
 * scrolls and each pane scrolls itself — but it applies to every page this
 * client renders, including the standalone full-page views that are ordinary
 * documents and grow past the viewport.
 *
 * The failure is unusually confusing, which is why this exists as a named hook
 * rather than three copies of a one-liner:
 *
 *   - `overflow` on `body` PROPAGATES to the viewport when `html` is `visible`,
 *     so wheel and touch are ignored...
 *   - ...but `window.scrollTo()` still moves the page, and `scrollHeight` still
 *     reports the full content height.
 *
 * So every programmatic check says "this scrolls" while a human finds it
 * frozen. Measured on the sign-in page at 420x560: 114px unreachable, including
 * the submit button and the password-reset link.
 *
 * Restores the previous value on unmount, so returning to the app shell does
 * not leave a second scrollbar behind.
 */
export function useDocumentScroll(): void {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'auto';
    return () => { document.body.style.overflow = prev; };
  }, []);
}
