import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { isCloud, ensureLogin } from './services/auth';
import './index.css';

function render() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

// Cloud mode: complete the Keycloak login (handles the redirect callback and,
// if needed, redirects to the IdP) before rendering. ensureLogin() resolves
// with a token when authenticated, or navigates away to log in. Local mode is
// a no-op and renders immediately.
if (isCloud()) {
  ensureLogin()
    .then((token) => { if (token) render(); })
    .catch((err) => {
      document.getElementById('root')!.innerHTML =
        `<div style="font-family:system-ui;padding:2rem;color:#b00">Login failed: ${String(err)}</div>`;
    });
} else {
  render();
}
