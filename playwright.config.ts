import { defineConfig, devices, type Project } from '@playwright/test';
import { AUTH_STORAGE_STATE } from './e2e/support/paths';
import { loadPlaywrightDotenv, playwrightWebServerEnv } from './lib/verify/playwright-env';

loadPlaywrightDotenv();

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';
const inCI = Boolean(process.env.CI);

/**
 * The authenticated journey needs the application database (it seeds an account
 * through Prisma), which exists on a developer machine but not in CI: both
 * workflows create `openlovable_test` only and migrate that. So it runs by
 * default locally and has to be asked for in CI, where enabling it also means
 * creating and migrating the application database.
 */
const authJourney = !inCI || process.env.PLAYWRIGHT_AUTH_JOURNEY === '1';

const authProjects: Project[] = authJourney
  ? [
      {
        name: 'setup',
        testMatch: /auth\.setup\.ts/,
        use: { ...devices['Desktop Chrome'] },
      },
      {
        name: 'authenticated',
        testMatch: /journeys-(authenticated|workflow)\.spec\.ts/,
        dependencies: ['setup'],
        use: { ...devices['Desktop Chrome'], storageState: AUTH_STORAGE_STATE },
      },
    ]
  : [];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: inCI,
  retries: inCI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer:
    inCI && !process.env.PLAYWRIGHT_NO_SERVER
      ? {
          command: 'pnpm start',
          url: baseURL,
          reuseExistingServer: false,
          timeout: 120_000,
          env: playwrightWebServerEnv(process.env),
        }
      : undefined,
  projects: [
    ...authProjects,
    {
      name: 'critical',
      testMatch: /journeys-critical\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'NEXTJS',
      testMatch: /journeys-stacks\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'REACT',
      testMatch: /journeys-stacks\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'ASTRO',
      testMatch: /journeys-stacks\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'STATIC_HTML',
      testMatch: /journeys-stacks\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'VUE',
      testMatch: /journeys-stacks\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'SVELTE',
      testMatch: /journeys-stacks\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'full',
      testMatch: /journeys-full\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
