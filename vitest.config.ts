import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['packages/shared/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', 'packages/shared/src/api/**'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 80 },
    },
  },
  resolve: {
    alias: {
      '@alnotica/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname,
      '@alnotica/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
    },
  },
});
