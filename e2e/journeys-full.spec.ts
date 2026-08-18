import { expect, test } from '@playwright/test';

/**
 * Every test in this file is `.fixme()`. They navigated and then asserted
 * `page.url()` was truthy (or a status greater than zero), which holds for a 500
 * page, a maintenance page, or the login screen — so they claimed coverage of
 * features that could be deleted without turning anything red. Each carries a
 * comment describing what it has to assert instead.
 */

test.describe('journey 5 — custom domain (scaffolded)', () => {
  // Should: signed in on a published project, add a hostname in the Domains tab
  // and assert the row appears with its verification instructions (Path A DNS
  // records) and a pending status.
  test.fixme('domains tab is a first-class workspace surface', async ({ page }) => {
    test.info().annotations.push({ type: 'status', description: 'scaffolded' });
    await page.goto('/');
    expect(page.url()).toBeTruthy();
  });
});

test.describe('journey 6 — recover abandoned job (scaffolded)', () => {
  // Should: with an ABANDONED job seeded for the project, open the workspace and
  // assert the recovery panel names the cause once and that the chat input is
  // unlocked (the regression from lessons-learned: busy must follow the job, not
  // Project.phase).
  test.fixme('recovery copy is English', async ({ page }) => {
    test.info().annotations.push({ type: 'status', description: 'scaffolded' });
    await page.goto('/');
    expect(page.url()).toBeTruthy();
  });
});

test.describe('journey 7 — admin invite (scaffolded)', () => {
  // Should: as a MEMBER, assert /admin/team does not render the invite form; as an
  // ADMIN, assert the invite succeeds and the new row appears in the team table.
  test.fixme('admin team invite is ADMIN-only', async ({ page }) => {
    test.info().annotations.push({ type: 'status', description: 'scaffolded' });
    await page.goto('/');
    expect(page.url()).toBeTruthy();
  });
});

test.describe('journey 8 — template to project (scaffolded)', () => {
  // Should: assert the gallery renders seeded template cards, and that choosing
  // one as a signed-in user creates a project whose initial prompt came from that
  // template. `status() > 0` is true of a 500.
  test.fixme(
    'templates gallery is reachable when signed out as a public-ish route or redirects',
    async ({ page }) => {
      test.info().annotations.push({ type: 'status', description: 'scaffolded' });
      const response = await page.goto('/templates');
      expect(response?.status()).toBeGreaterThan(0);
    },
  );
});

test.describe('visual regression (scaffolded baselines)', () => {
  const widths = [390, 820, 1280];
  const screens = ['auth', 'home', 'templates', 'legal-terms', 'legal-privacy'];

  // Should: call `expect(page).toHaveScreenshot()` against a committed baseline
  // per screen and width, after masking anything non-deterministic. These fifteen
  // tests set a viewport and never take a screenshot, and no baseline exists, so
  // they claimed visual coverage of five screens at three widths while comparing
  // nothing.
  for (const screen of screens) {
    for (const width of widths) {
      test.fixme(`${screen} @ ${width}`, async ({ page }) => {
        test.info().annotations.push({ type: 'status', description: 'scaffolded' });
        await page.setViewportSize({ width, height: 844 });
        const path =
          screen === 'auth'
            ? '/?auth=login'
            : screen === 'home'
              ? '/'
              : screen === 'templates'
                ? '/templates'
                : screen === 'legal-terms'
                  ? '/terms'
                  : '/privacy';
        await page.goto(path);
        expect(page.url()).toBeTruthy();
      });
    }
  }
});
