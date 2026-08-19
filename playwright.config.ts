import { defineConfig, devices } from '@playwright/test';
import { AUTH_STORAGE_STATE } from './e2e/support/paths';
import { loadPlaywrightDotenv, playwrightWebServerEnv } from './lib/verify/playwright-env';

loadPlaywrightDotenv();

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';
const inCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: inCI,
  retries: inCI ? 1 : 0,
  /**
   * Three, not Playwright's default half-the-cores.
   *
   * The server this suite talks to is a Turbopack dev server, which compiles a
   * route on first request. At eight workers the contention alone was enough to
   * fail runs that had nothing wrong with them: `journey 1` — a bare
   * `page.goto('/?auth=login')` that takes ~1.8s warm — timed out at 30s, and
   * `auth.setup` died with it, stranding 15 dependent tests. The same suite
   * passes at three. A gate that goes red from its own parallelism teaches
   * people to re-run until green, which is worse than being slower.
   */
  workers: 3,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  /**
   * Whether to boot a server is decided by probing `baseURL`, which is what
   * actually describes the situation — not by `CI`, which does not. This block
   * used to be `inCI && !PLAYWRIGHT_NO_SERVER` with `reuseExistingServer: false`,
   * so a developer whose shell happened to export `CI` (agent shells do) could
   * not complete `pnpm run verify` at all: Playwright probes the URL before
   * spawning and throws `is already used` against the dev server on :3000, which
   * failed the gate for an environmental reason and skipped every later step
   * including the fatal dependency audit. Reuse is now the rule, so a healthy
   * server is used as-is; a CI runner has nothing listening, so `next start` is
   * still spawned there. `PLAYWRIGHT_NO_SERVER=1` opts out entirely (documented
   * in docs/release.md) for the case where you want the run to go red rather
   * than have a server appear under it.
   */
  webServer: process.env.PLAYWRIGHT_NO_SERVER
    ? undefined
    : {
        // Direct binary, never `pnpm start`: pnpm's dependency-status check can
        // purge node_modules first, and this config is reached from `git push`
        // through .husky/pre-push (.cursor/lessons-learned.md).
        //
        // `next dev`, not `next start`, and that matters. This spawned `next start`,
        // which serves whatever `.next` already contains — so when the dev server
        // died mid-session the suite kept running green against a build that was
        // three hours old, and every app change made since was invisible to it. A
        // gate that validates stale output is worse than one that refuses to run,
        // because it reports green about code it never served. `next start` is also
        // wrong here on its own terms: next.config.ts sets `output: 'standalone'`,
        // and Next prints `"next start" does not work with "output: standalone"` on
        // every boot. Turbopack dev compiles current source, so staleness is not
        // representable. The production build is still gated — `next build` is its
        // own verify step.
        command: 'node ./node_modules/next/dist/bin/next dev',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
        env: playwrightWebServerEnv(process.env),
      },
  projects: [
    /**
     * The authenticated journey seeds an account through Prisma into the
     * application database, so it used to be declared local-only: CI created
     * `openlovable_test` and nothing else. Both workflows now create and migrate
     * the application database too, so the only e2e tests that exercise a
     * signed-in user are part of the gate everywhere instead of running nowhere —
     * before 2026-08-19 they ran in no workflow (`CI` dropped them) and in no
     * verify step (`--project=critical` excluded them), which is how a broken
     * sign-in could have shipped green.
     */
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
    {
      name: 'critical',
      testMatch: /journeys-critical\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    /**
     * One project, not six. This was NEXTJS/REACT/ASTRO/STATIC_HTML/VUE/SVELTE,
     * each running the same spec — and three of those stacks do not exist: the
     * Prisma `Stack` enum and `lib/stacks/routes.ts` know only NEXTJS, REACT and
     * STATIC_HTML. Every test in the file was `.fixme()`, which is what hid the
     * invented names, and the report showed six projects' worth of coverage for
     * one skip. The per-stack create assertions now live in the `authenticated`
     * project, where a session exists; what remains here is the paid build, as a
     * single named skip.
     */
    {
      name: 'stacks',
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
