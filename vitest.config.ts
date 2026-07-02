import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Tests run against engine SOURCE (not built dist) via these aliases, so the
// store parity suite etc. work without a prior build. The regex handles deep
// subpath imports (@chat-recall/engine/core/store/index.js); the exact match
// handles the barrel.
const engineSrc = fileURLToPath(new URL('./packages/engine/src/', import.meta.url));

// The Postgres-backed tests (store.test.ts, isolation.test.ts) share one
// `public` schema on DATABASE_URL; run in parallel they race on table
// creation / role grants. Postgres mode is opt-in (gated on DATABASE_URL),
// so only there do we serialize files — the default SQLite run keeps full
// parallelism.
const pgMode = !!(process.env.DATABASE_URL || process.env.CHAT_RECALL_DATABASE_URL);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@chat-recall\/engine\/(.*)\.js$/, replacement: engineSrc + '$1.ts' },
      { find: '@chat-recall/engine', replacement: engineSrc + 'index.ts' },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    environment: 'node',
    isolate: true,
    pool: 'forks',
    // Serialize files only when the shared Postgres is in play (see above).
    fileParallelism: !pgMode,
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        '**/dist/**',
        'packages/engine/src/index.ts',
        'packages/cli/src/cli.ts',
        'packages/cli/src/mcp.ts',
        'packages/server/src/server.ts',
      ],
    },
  },
});
