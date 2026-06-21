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
if (isCloud()) {
  if (!hasStoredSession() && !isAuthCallback()) {
    render(<LandingPage onGetStarted={() => beginLogin()} />);
  } else {
    ensureLogin()
      .then((token) => { if (token) render(<App />); })
      .catch((err) => {
        document.getElementById('root')!.innerHTML =
          `<div style="font-family:system-ui;padding:2rem;color:#b00">Login failed: ${String(err)}</div>`;
      });
  }
} else {
  render(<App />);
}
