import { expect, test } from '@playwright/test';
import { E2E_ACCOUNT_FIRST_NAME, resolveE2eTarget } from './support/account';

/**
 * The one authenticated journey. It runs with the storage state written by
 * `auth.setup.ts` (see the `authenticated` project in `playwright.config.ts`).
 *
 * Rules this file exists to hold: never assert on a title, a status code, or
 * `page.url()`. A signed-out request to `/dashboard` is redirected by `proxy.ts`
 * to `/?auth=login&next=/dashboard`, which answers 200 with a real title — that
 * response is what a `redirect: 'follow'` smoke check accepted as proof the
 * dashboard had rendered. Everything asserted below is markup that only exists
 * once a session resolves to a user.
 */

/** Same resolution the seed used, so the assertions name the row that was written. */
function signedInAs() {
  const resolved = resolveE2eTarget();
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.target.account;
}

test.describe('journey 0 — signed-in dashboard', () => {
  // Room for a cold Turbopack compile of /dashboard, while staying above the
  // per-assertion timeouts below so a failure reports the assertion rather than a
  // bare test timeout.
  test.describe.configure({ timeout: 90_000 });

  test('renders the seeded account, not the login screen', async ({ page }) => {
    const account = signedInAs();

    await page.goto('/dashboard');

    // `AccountMenu` renders nothing until `useAuth()` has a user, and the address
    // it prints comes from the session, so no signed-out render can produce it.
    // Naming the address also fails if the session belongs to somebody else.
    await expect(page.getByRole('button', { name: 'Open account menu' })).toContainText(
      account.email,
      { timeout: 45_000 },
    );

    // The greeting is built from the session user's first name.
    await expect(
      page.getByRole('heading', { name: `What's on your mind, ${E2E_ACCOUNT_FIRST_NAME}?` }),
    ).toBeVisible();

    // The exact failure mode this journey is designed against: the login modal,
    // 200 and all.
    await expect(page.locator('#auth-email')).toHaveCount(0);
  });

  test('renders the workspace sidebar and project views', async ({ page }) => {
    await page.goto('/dashboard');

    // `app/(app)/layout.tsx` is the authenticated shell; an anonymous visitor is
    // redirected before it renders, so the sidebar cannot appear signed out.
    const sidebar = page.getByRole('navigation', { name: 'Workspace' });
    await expect(sidebar).toBeVisible({ timeout: 45_000 });
    for (const label of ['Dashboard', 'Templates', 'Connectors', 'Deployments']) {
      await expect(sidebar.getByRole('link', { name: label })).toBeVisible();
    }

    // Per-user project views, rendered by the dashboard itself.
    const views = page.getByRole('navigation', { name: 'Project views' });
    await expect(views.getByRole('button', { name: 'My projects' })).toBeVisible();
    await expect(views.getByRole('button', { name: 'Recently viewed' })).toBeVisible();
  });
});
