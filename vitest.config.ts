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
    // The second glob picks up the web client's own pure modules (services/*),
    // which the first misses — its sources live at packages/server/client/src.
    // Component files stay untested here; this is for the logic underneath them.
    include: ['packages/*/src/**/*.test.ts', 'packages/*/client/src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    environment: 'node',
    isolate: true,
    pool: 'forks',
    // Serialize files only when the shared Postgres is in play (see above).
    fileParallelism: !pgMode,
    testTimeout: 15000,
    // HOOKS GOT LESS TIME THAN THE TESTS THEY SET UP. `hookTimeout` was never
    // set, so it stayed at vitest's 10s default while tests had 15s — and these
    // hooks do real work: mkdtemp, create a SQLite database, open a driver, then
    // close and unlink it all. On Windows that is slower again (a newly created
    // .db is scanned before it can be reopened, and an unlink retries while the
    // OS releases the handle — see test-support/tmp-dir.ts), and one store.test
    // hook crossed the line: `Error: Hook timed out in 10000ms`, on Windows
    // only. Setup must not be given a smaller budget than the assertion.
    hookTimeout: 30000,
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
