import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test as setup, type Page } from '@playwright/test';
import type { E2eAccount } from './support/account';
import { ADMIN_STORAGE_STATE, AUTH_STORAGE_STATE } from './support/paths';
import { seedE2eAccount, seedE2eAdminAccount } from './support/seed-account';

/**
 * Above the 60s budget the sign-in assertion below asks for.
 *
 * Without this the file ran on Playwright's 30s default, so that assertion could
 * never spend more than half its stated budget: a slow first compile ended the run
 * with `Test timeout of 30000ms exceeded` while the expect was still waiting, and
 * because every authenticated project depends on `setup`, one cold start took the
 * whole suite down with 15 tests never run. The number has to be larger than the
 * longest wait inside, or the wait is decoration.
 */
/**
 * Serial, and above the 60s budget the sign-in assertion below asks for.
 *
 * The timeout came first: without it the file ran on Playwright's 30s default, so that
 * assertion could never spend more than half its stated budget, and one cold start took
 * the whole suite down with 15 tests never run.
 *
 * `mode: 'serial'` is the other half of the same problem. `fullyParallel` let the member
 * and admin sign-ins race, and both raced to be the first request to compile
 * `/api/auth/[...nextauth]` on a Turbopack dev server. The loser got a csrf token whose
 * `Set-Cookie` never landed, so Auth.js rejected the POST with `MissingCSRF` and the
 * account menu never appeared — measured on `main` at 0 failures in one run and 2 in the
 * next, on the same commit and the same machine. `playwright.config.ts` already cut
 * workers 8 -> 3 for this exact class and says why: "a gate that goes red from its own
 * parallelism teaches people to re-run until green, which is worse than being slower."
 * Two sign-ins are not worth racing; they cost ~15s serially and every authenticated
 * test depends on both.
 */
setup.describe.configure({ mode: 'serial', timeout: 180_000 });

/**
 * Seeds the E2E accounts and signs each in once, through the real credentials
 * form, then writes the sessions to disk for the `authenticated` project. Before
 * this existed, no Playwright test in this repo had ever been authenticated.
 *
 * Two accounts, not one: the invite journey is only meaningful if it shows a
 * MEMBER refused *and* an ADMIN admitted, and promoting the shared member
 * mid-run would decide that refusal in whichever worker looked second.
 *
 * The saved files are live sessions. `.gitignore` covers `/e2e/.auth` — never
 * commit them.
 */

async function signInAndSave(page: Page, account: E2eAccount, storageState: string) {
  await page.goto('/?auth=login');

  // Compile the Auth.js route and take its csrf cookie before the form needs them.
  //
  // `signIn()` fetches `/api/auth/csrf` and immediately posts the token back, so on a
  // cold Turbopack server both halves land on a route that is still compiling — and the
  // failure is silent in the browser: the token arrives, its `Set-Cookie` does not, and
  // the POST is refused with `MissingCSRF` while the page just sits on the dialog. The
  // test then reports "account menu not found", which reads as a broken sign-in rather
  // than a route that was not warm.
  //
  // `page.request` shares the context's cookie jar, so this both warms the route and
  // seeds the cookie the real submit will reuse.
  await page.request.get('/api/auth/csrf');

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

  await mkdir(dirname(storageState), { recursive: true });
  await page.context().storageState({ path: storageState });
}

setup('sign in once and save the session', async ({ page }) => {
  const { account, database, created } = await seedE2eAccount();
  setup.info().annotations.push({
    type: 'account',
    description: `${created ? 'created' : 'refreshed'} ${account.email} in ${database}`,
  });

  await signInAndSave(page, account, AUTH_STORAGE_STATE);
});

setup('sign in once as an admin and save that session', async ({ page }) => {
  const { account, database, created } = await seedE2eAdminAccount();
  setup.info().annotations.push({
    type: 'account',
    description: `${created ? 'created' : 'refreshed'} admin ${account.email} in ${database}`,
  });

  await signInAndSave(page, account, ADMIN_STORAGE_STATE);
});
