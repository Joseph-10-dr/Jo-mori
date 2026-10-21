import { defineConfig } from '@playwright/test';

const DB = process.env.E2E_DATABASE_URL ?? 'postgres://tracevault:tracevault@localhost:5432/tracevault_e2e';
export const API = 'http://localhost:4100';
export const WEB = 'http://localhost:3100';

/**
 * Runs the real API (against a throwaway database) and a production build of
 * the dashboard, then drives a browser through the core MVP workflow.
 */
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  outputDir: '../../test-results/e2e',
  webServer: [
    {
      command: `psql "${DB}" -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" && pnpm --filter @tracevault/api build && node apps/api/dist/main.js`,
      cwd: '../..',
      url: `${API}/v1/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'development',
        PORT: '4100',
        DATABASE_URL: DB,
        WEB_ORIGIN: WEB,
        PUBLIC_API_URL: API,
        TV_VAR_DIR: '/tmp/tracevault-e2e-var',
        BACKGROUND_JOBS: 'false',
      },
    },
    {
      command: 'pnpm --filter @tracevault/web build && pnpm --filter @tracevault/web exec next start -p 3100',
      cwd: '../..',
      url: WEB,
      timeout: 240_000,
      reuseExistingServer: false,
      env: { API_URL: API, NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
