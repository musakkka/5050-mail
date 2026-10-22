import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The docs-examples runner takes ~6 minutes; run it with `npm run docs:examples`.
    exclude: process.env.DOCS_EXAMPLES ? [] : ['test/docs-examples.test.ts', '**/node_modules/**'],
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    fileParallelism: true,
  },
});
