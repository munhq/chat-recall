import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ');

/**
 * Start the session check in the HTML shell, before the bundle exists.
 *
 * The shell is 5KB and answers in about 70ms; the bundle behind it is the rest
 * of the wait. The app cannot render either screen until /api/auth/get-session
 * answers, and that call used to start only once the bundle had downloaded,
 * parsed and run — so a boot was four strictly serial steps. This makes the
 * session request and the bundle download overlap.
 *
 * ONLY in cloud builds. A self-host dashboard has no better-auth mounted, so
 * the same script there would be one guaranteed 404 on every page load.
 *
 * The CSP needs no change: inlineScriptHashes() in the server walks every
 * shipped HTML document and hashes each inline script it finds, so this one is
 * covered the moment it is built. (It must stay inline for that reason — an
 * external file would be a second request, which is the thing being removed.)
 */
function sessionPreflight(isCloud: boolean): Plugin {
  return {
    name: 'chat-recall:session-preflight',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!isCloud) return html;
        const tag = `    <!-- Session preflight. services/auth.ts consumes window.__crSession
         exactly once and falls back to its own fetch when it is absent, so
         deleting this tag costs latency and breaks nothing. Never rejects:
         a failure resolves null, which auth.ts reads as "signed out". -->
    <script>
      window.__crSession = fetch('/api/auth/get-session', {
        credentials: 'include',
        headers: { accept: 'application/json' }
      }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    </script>
`;
        return html.replace('  </head>', `${tag}  </head>`);
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_');
  // Mirrors CLOUD in services/auth.ts. Keep the two in step: a build that is
  // cloud to one and not the other either 404s on boot or loses the preflight.
  const isCloud = !!(env.VITE_CLOUD || env.VITE_OIDC_ISSUER);

  return {
    define: {
      __BUILD_STAMP__: JSON.stringify(BUILD_STAMP),
    },
    plugins: [react(), sessionPreflight(isCloud)],
    build: {
      rollupOptions: {
        output: {
          /**
           * React in its own chunk, and nothing else hand-placed.
           *
           * The entry, and every lazy screen chunk, imports React. Left alone
           * Rollup hoists it into a shared chunk anyway; naming it pins it to a
           * file whose contents change only when React does. That matters now
           * that hashed assets are served immutable for a year
           * (server/util/static-routing.ts): a deploy that touches app code
           * leaves this file's hash, and every browser's copy of it, alone.
           *
           * react-dom and scheduler travel WITH react on purpose. Splitting them
           * gives two modules that must initialise in order across two chunks,
           * which is how a build starts throwing about a null dispatcher.
           */
          manualChunks(id) {
            if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
            return undefined;
          },
        },
      },
    },
    server: {
      host: '0.0.0.0', // Listen on all network interfaces
      port: Number(process.env.VITE_DEV_PORT) || 5174,
      proxy: {
        '/api': {
          target: process.env.VITE_API_TARGET || 'http://localhost:5000',
          changeOrigin: true,
        },
      },
    },
  };
});
