import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import LandingPage from './components/LandingPage';
import ErrorBoundary from './components/ErrorBoundary';
import { isCloud, ensureLogin, hasStoredSession, isAuthCallback, beginLogin } from './services/auth';
import './index.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);

function render(node: React.ReactNode) {
  root.render(<React.StrictMode><ErrorBoundary>{node}</ErrorBoundary></React.StrictMode>);
}

// Cloud mode routing on first paint:
//   - logged out (no token) and NOT returning from the IdP → public landing.
//     The static shell + /api/capabilities + /api/billing/plan are all public,
//     so the marketing page renders with zero auth.
//   - otherwise → complete login (handles ?code callback / refresh) then app.
// Local mode renders the app immediately (no auth at all).
//
// ?view=connect (the installer's token page) is special: the visitor arrived
// from a terminal mid-`install.sh`, so (a) skip the marketing page and go
// straight to the IdP, and (b) stash the query string — the OIDC redirect_uri
// is origin+pathname only, so ?view=connect&device=… would otherwise be lost
// on the Keycloak roundtrip.
const RESUME_KEY = 'cr.resume-query';
function isConnectVisit(): boolean {
  try { return new URLSearchParams(window.location.search).get('view') === 'connect'; } catch { return false; }
}
if (isCloud()) {
  if (isConnectVisit()) sessionStorage.setItem(RESUME_KEY, window.location.search);
  if (!hasStoredSession() && !isAuthCallback()) {
    if (isConnectVisit()) {
      void beginLogin();
    } else {
      render(<LandingPage onGetStarted={() => beginLogin()} />);
    }
  } else {
    ensureLogin()
      .then((token) => {
        if (!token) return;
        const stashed = sessionStorage.getItem(RESUME_KEY);
        if (stashed && !window.location.search) {
          sessionStorage.removeItem(RESUME_KEY);
          window.history.replaceState({}, '', window.location.pathname + stashed);
        } else if (stashed) {
          sessionStorage.removeItem(RESUME_KEY);
        }
        render(<App />);
      })
      .catch((err) => {
        document.getElementById('root')!.innerHTML =
          `<div style="font-family:system-ui;padding:2rem;color:#b00">Login failed: ${String(err)}</div>`;
      });
  }
} else {
  render(<App />);
}
