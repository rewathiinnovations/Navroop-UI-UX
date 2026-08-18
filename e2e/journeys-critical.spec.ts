import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Critical = journeys 1–4 (pre-push).
 * Journey 1 is runnable against a live :3000 (or CI `pnpm start`).
 * Journeys 2–4 are `.fixme()`: their bodies assert `page.url()` is truthy, which
 * is true of any loaded document, so they passed against a broken app. Each one
 * carries a comment describing what it has to assert instead. The signed-in half
 * of that work now has a foundation in `auth.setup.ts` +
 * `journeys-authenticated.spec.ts`.
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

test.describe('journey 2 — create project (scaffolded)', () => {
  // Should: signed in, type a prompt in PromptHero on /dashboard, submit, and land
  // on /project/{id} with that project's name in the workspace header.
  // `page.url()` is truthy for any loaded document, so this passes against a 500
  // page or an app with project creation deleted. Only a refused TCP connection
  // fails it.
  test.fixme('create-from-prompt path exists', async ({ page }) => {
    test.info().annotations.push({ type: 'status', description: 'scaffolded' });
    await page.goto('/');
    expect(page.url()).toBeTruthy();
  });
});

test.describe('journey 3 — plan / build (scaffolded)', () => {
  // Should: signed in, open an existing project workspace and assert the chat
  // offers both Plan and Build modes, and that switching mode changes what the
  // send button submits.
  test.fixme('workspace chat modes exist in the app shell', async ({ page }) => {
    test.info().annotations.push({ type: 'status', description: 'scaffolded' });
    await page.goto('/');
    expect(page.url()).toBeTruthy();
  });
});

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
