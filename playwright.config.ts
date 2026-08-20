import { defineConfig, devices } from '@playwright/test';
import { AUTH_STORAGE_STATE } from './e2e/support/paths';
import {
  loadPlaywrightDotenv,
  playwrightWebServerEnv,
  resolvePlaywrightServer,
} from './lib/verify/playwright-env';

loadPlaywrightDotenv();

/**
 * Which server this suite validates is decided by `resolvePlaywrightServer`,
 * not by "whatever answers on :3000". Two worktrees run two dev servers on this
 * machine, and a probe cannot tell which checkout it reached — so without an
 * explicit PLAYWRIGHT_BASE_URL the suite always boots its own `next dev` from
 * THIS checkout on a port derived to be free (locally APP_URL's port + 100; in
 * CI the APP_URL port itself, where nothing listens, so CI is unchanged).
 */
const server = resolvePlaywrightServer(process.env);
const baseURL = server.baseURL;
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
   * `reuseExistingServer` was unconditionally `true` here, which fixed one
   * failure mode (a shell exporting `CI` made Playwright refuse a healthy local
   * server) by creating a worse one: with two worktrees serving :3000 and :3001,
   * "reuse whatever answers" let both fatal Playwright steps validate a
   * different checkout's code (F-620). Playwright cannot ask a server which
   * checkout it serves, so reuse now requires the operator to vouch for the
   * target by setting PLAYWRIGHT_BASE_URL. Without it the suite boots its own
   * server — see `resolvePlaywrightServer` — which by construction serves this
   * checkout. `PLAYWRIGHT_NO_SERVER=1` still opts out entirely (documented in
   * docs/release.md) for the case where you want the run to go red rather than
   * have a server appear under it.
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
        // own verify step. The child binds `server.port` via PORT and describes
        // itself with the served origin (`playwrightWebServerEnv` pins APP_URL /
        // NEXT_PUBLIC_APP_URL / NEXTAUTH_URL / AUTH_URL to it).
        command: 'node ./node_modules/next/dist/bin/next dev',
        url: baseURL,
        reuseExistingServer: server.reuseExistingServer,
        timeout: 120_000,
        env: playwrightWebServerEnv(process.env, server),
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
