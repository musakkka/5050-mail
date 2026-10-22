import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the mock build (no backend needed):
 *   npm run e2e
 * Against a running send server instead: BASE_URL=http://localhost:3000 npm run e2e
 */
const external = !!process.env.BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 4,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:4178',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
  webServer: external
    ? undefined
    : {
        command: 'npx vite build --outDir dist-mock --mode mock && npx vite preview --outDir dist-mock --port 4178 --strictPort',
        env: { VITE_MOCK: '1' },
        url: 'http://localhost:4178/login',
        reuseExistingServer: true,
        timeout: 180_000,
      },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, colorScheme: 'dark' } }],
});
