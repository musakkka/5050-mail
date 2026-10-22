import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts', 'client/src/**/*.test.ts'],
    environment: 'node',
  },
});
