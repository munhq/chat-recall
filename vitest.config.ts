import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default Vitest globs already pick up *.test.ts — be explicit so
    // future contributors don't have to guess what we collect.
    include: [
      'src/**/*.test.ts',
      'web/server/src/**/*.test.ts',
    ],
    // Don't try to import `.ts` ESM specifiers from compiled `.js` —
    // Vitest resolves source directly. tsx loader path emulation lives
    // in the production CLI; tests work straight on .ts files.
    environment: 'node',
    // Each test file gets its own worker — keeps SQLite handle and any
    // module-level singletons isolated.
    isolate: true,
    pool: 'forks',
    // Tests that touch better-sqlite3 + the user's real cache (read-only)
    // can take a few hundred ms on cold start.
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: [
        'src/**/*.ts',
        'web/server/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        // Generated / build artifacts
        '**/dist/**',
        // Entry shims that mostly just wire imports
        'src/index.ts',
        'src/cli.ts',
        'src/mcp.ts',
        'web/server/src/server.ts',
      ],
      thresholds: {
        lines:    90,
        functions: 90,
        branches:  80,
        statements: 90,
      },
    },
  },
});
