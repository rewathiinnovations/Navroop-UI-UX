import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Critical = journeys 1–4 (pre-push).
 *
 * Only journey 1 is *in* this file. It runs signed out against a live :3000 (or
 * CI `pnpm start`), which is what lets it assert the login screen at all.
 *
 * Journeys 2, 3 and 4 need a session, so they run in the `authenticated` project
 * and live in `journeys-workflow.spec.ts` — journey 2 as a dashboard prompt that
 * becomes a workspace (and once per stack), journey 3 as the chat's plan/build
 * toggle, journey 4 as the two halves of publish that are free and regress
 * silently: the disabled button that names its reason, and the 409 the route owes
 * a caller whose integrations are missing. Journey 4 also had a `.fixme()` stub
 * here whose body asserted `page.url()` is truthy — true of any loaded document,
 * so it passed against a broken app while claiming publish was covered twice.
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
    expect(
      response?.ok() || response?.status() === 304,
      'app must be reachable on :3000',
    ).toBeTruthy();
    await expect(page.locator('body')).toContainText(/sign in|log in|invite/i);
    await expect(page.locator('body')).not.toContainText(/klarco/i);

    const axe = await new AxeBuilder({ page }).analyze();
    const serious = axe.violations.filter(
      (row) => row.impact === 'serious' || row.impact === 'critical',
    );
    expect(serious, serious.map((row) => row.id).join(', ')).toEqual([]);
  });
});
