import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test as setup } from '@playwright/test';
import { AUTH_STORAGE_STATE } from './support/paths';
import { seedE2eAccount } from './support/seed-account';

/**
 * Seeds the E2E account and signs it in once, through the real credentials form,
 * then writes the session to disk for the `authenticated` project. Before this
 * existed, no Playwright test in this repo had ever been authenticated.
 *
 * The saved file is a live session. `.gitignore` covers `/e2e/.auth` — never
 * commit it.
 */
setup('sign in once and save the session', async ({ page }) => {
  const { account, database, created } = await seedE2eAccount();
  setup.info().annotations.push({
    type: 'account',
    description: `${created ? 'created' : 'refreshed'} ${account.email} in ${database}`,
  });

  await page.goto('/?auth=login');

  const dialog = page.getByRole('dialog');
  await dialog.locator('#auth-email').fill(account.email);
  await dialog.locator('#auth-password').fill(account.password);
  await dialog.getByRole('button', { name: 'Log in', exact: true }).click();

  // Sign-in has to genuinely land on the dashboard as this account. Saving the
  // context without checking would hand the journey an anonymous cookie jar and
  // move the false-green one file over.
  await expect(page.getByRole('button', { name: 'Open account menu' })).toContainText(
    account.email,
    { timeout: 60_000 },
  );

  await mkdir(dirname(AUTH_STORAGE_STATE), { recursive: true });
  await page.context().storageState({ path: AUTH_STORAGE_STATE });
});
