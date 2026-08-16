import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/browser';
import App from './App';
import AuthPage from './components/AuthPage';
import DeviceApprovePage from './components/DeviceApprovePage';
import ErrorBoundary from './components/ErrorBoundary';
import { isCloud, isSignedIn, clearLegacyTokens } from './services/auth';
import './index.css';

// Crash reporting → shared munhq-frontend GlitchTip project. The `app` tag
// marks these as chat-recall (tier project stays per-app filterable). The DSN
// is a public key, baked at build (Vite inlines VITE_GLITCHTIP_DSN); no-ops
// when unset. Default integrations capture window.onerror + unhandledrejection.
const glitchtipDsn = import.meta.env.VITE_GLITCHTIP_DSN;
if (glitchtipDsn) {
  Sentry.init({
    dsn: glitchtipDsn,
    initialScope: { tags: { app: 'chat-recall' } },
    tracesSampleRate: 0,
  });
}

const root = ReactDOM.createRoot(document.getElementById('root')!);

function render(node: React.ReactNode) {
  root.render(<React.StrictMode><ErrorBoundary>{node}</ErrorBoundary></React.StrictMode>);
}

// Cloud mode routing on first paint. Auth is the embedded better-auth
// provider (services/auth.ts) — the login form is ours, there is NO IdP
// redirect, so the URL (and any ?view=connect&device=… query from the
// installer) survives login untouched; the old Keycloak resume-query stash
// is gone with the redirect that required it.
//
//   /device?user_code=…  — CLI device-login approval. Needs a session first;
//                          logged-out visitors get the sign-in form, then the
//                          approve card (the URL is preserved).
//   ?view=connect        — the installer's token page: skip the marketing
//                          landing, go straight to sign-in, then the app.
//   logged out otherwise — the sign-in form. The marketing landing is NOT a
//                          React component any more: server.ts serves the
//                          static landing.html at '/' to anyone without a
//                          session cookie, and the SPA shell is only reached
//                          with a cookie, a query, or a non-'/' path. So
//                          anyone who gets this far asked for the app, and
//                          rendering a second landing here would both fork the
//                          design system and bounce them away from the thing
//                          they clicked.
//   logged in            — the app (a dead session 401s → handleUnauthorized
//                          returns here).
//
// The signed-in test is ASYNC now, because the session is an httpOnly cookie
// that script cannot read (services/auth.ts explains why). It was a synchronous
// localStorage lookup, which was fast and also wrong: it answered "is there a
// string in storage", which stayed true for revoked and expired sessions, so
// those users got the app shell and a wall of failing calls instead of a login
// form. One /api/auth/get-session call gets the real answer.
//
// The wait is covered by a neutral splash rather than a guess. Rendering the
// landing first and swapping to the app would show every returning user a flash
// of marketing copy for their own product.
const isDeviceVisit = window.location.pathname === '/device';

/** Pre-auth splash. Deliberately not a spinner: at ~50ms a spinner is a flicker
 *  that reads as jank, while a still surface in the page background reads as
 *  the page still loading. Uses the theme tokens so it cannot flash white on a
 *  dark shell. */
function Splash() {
  return <div style={{ position: 'fixed', inset: 0, background: 'var(--cr-ink-0, #090D14)' }} aria-hidden="true" />;
}

if (isCloud()) {
  // Any pre-cookie token is dead weight from here on: nothing reads it, and a
  // 30-day-valid string sitting in a browser profile is a second credential for
  // the same account with none of the protection the cookie has.
  clearLegacyTokens();
  render(<Splash />);
  void isSignedIn().then((signedIn) => {
    if (signedIn) {
      render(isDeviceVisit ? <DeviceApprovePage /> : <App />);
    } else {
      const after = () => render(isDeviceVisit ? <DeviceApprovePage /> : <App />);
      render(<AuthPage onSuccess={after} />);
    }
  });
} else {
  render(<App />);
}
