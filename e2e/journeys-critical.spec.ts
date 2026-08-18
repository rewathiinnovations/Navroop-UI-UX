import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Critical = journeys 1–4 (pre-push).
 * Journey 1 is runnable against a live :3000 (or CI `pnpm start`), signed out.
 * Journeys 2 and 3 are implemented in `journeys-workflow.spec.ts` — they need a session,
 * so they run in the `authenticated` project rather than this one.
 * Journey 4 is still `.fixme()`: its body asserts `page.url()` is truthy, which is true of
 * any loaded document, so it passed against a broken app. The comment on it describes what
 * it has to assert instead.
 */
test.describe('journey 1 — sign in', () => {
  test('auth screen is English and has no serious axe findings', async ({ page }) => {
    let response;
    try {
      response = await page.goto('/?auth=login');
    } catch (error) {
      // Journeys 2–4 are `.fixme()`, so this is the only test the `critical`
      // project executes — and `playwright-critical` is a fatal verify step.
      // Skipping on every non-CI machine therefore let the whole step pass with
      // zero assertions run whenever :3000 was down. Opting out is now explicit.
      if (process.env.PLAYWRIGHT_ALLOW_NO_SERVER === '1') {
        test.skip(true, 'PLAYWRIGHT_ALLOW_NO_SERVER=1 and nothing answers on the base URL');
        return;
      }
      throw error;
    }
    expect(response?.ok() || response?.status() === 304, 'app must be reachable on :3000').toBeTruthy();
    await expect(page.locator('body')).toContainText(/sign in|log in|invite/i);
    await expect(page.locator('body')).not.toContainText(/klarco/i);

    const axe = await new AxeBuilder({ page }).analyze();
    const serious = axe.violations.filter((row) => row.impact === 'serious' || row.impact === 'critical');
    expect(serious, serious.map((row) => row.id).join(', ')).toEqual([]);
  });
});

/**
 * Journeys 2 and 3 are implemented in `journeys-workflow.spec.ts`, not here.
 *
 * Both need a session, and this project runs signed out so journey 1 can assert the login
 * screen. They run in the `authenticated` project instead, on the storage state written by
 * `auth.setup.ts`. Journey 2 submits a prompt on /dashboard and asserts the row it created
 * is the one the workspace opened; journey 3 asserts the chat's plan/build toggle moves its
 * pressed state. Both stub every paid endpoint, so neither spends tokens or starts a VM.
 */

test.describe('journey 4 — publish (scaffolded)', () => {
  // Should: signed in with the three integrations stubbed, open the Publish sheet
  // and assert the UI polls PUBLISH job steps (a step list that advances), not an
  // SSE stream.
  test.fixme('publish is a job, not a stream', async ({ page }) => {
    test.info().annotations.push({ type: 'status', description: 'scaffolded' });
    await page.goto('/');
    expect(page.url()).toBeTruthy();
  });
});
