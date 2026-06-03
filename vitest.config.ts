import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Tests run against engine SOURCE (not built dist) via these aliases, so the
// store parity suite etc. work without a prior build. The regex handles deep
// subpath imports (@chat-recall/engine/core/store/index.js); the exact match
// handles the barrel.
const engineSrc = fileURLToPath(new URL('./packages/engine/src/', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@chat-recall\/engine\/(.*)\.js$/, replacement: engineSrc + '$1.ts' },
      { find: '@chat-recall/engine', replacement: engineSrc + 'index.ts' },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    isolate: true,
    pool: 'forks',
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
