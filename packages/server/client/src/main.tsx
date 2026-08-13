import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/browser';
import App from './App';
import LandingPage from './components/LandingPage';
import AuthPage from './components/AuthPage';
import DeviceApprovePage from './components/DeviceApprovePage';
import ErrorBoundary from './components/ErrorBoundary';
import { isCloud, hasStoredSession } from './services/auth';
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
//   logged out otherwise — public landing; "Sign in" renders the auth form.
//   logged in            — the app (a dead session 401s → handleUnauthorized
//                          clears it and returns here).
function isConnectVisit(): boolean {
  try { return new URLSearchParams(window.location.search).get('view') === 'connect'; } catch { return false; }
}
const isDeviceVisit = window.location.pathname === '/device';

if (isCloud()) {
  if (hasStoredSession()) {
    render(isDeviceVisit ? <DeviceApprovePage /> : <App />);
  } else if (isDeviceVisit || isConnectVisit()) {
    const after = () => render(isDeviceVisit ? <DeviceApprovePage /> : <App />);
    render(<AuthPage onSuccess={after} />);
  } else {
    render(<LandingPage onGetStarted={() => render(<AuthPage onSuccess={() => render(<App />)} />)} />);
  }
} else {
  render(<App />);
}
