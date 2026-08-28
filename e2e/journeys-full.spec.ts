import { expect, test, type Page } from '@playwright/test';
import { E2E_ACCOUNT_FIRST_NAME } from './support/account';
import { e2eAccounts, seedE2eAccount } from './support/seed-account';

/** Signs in through the real credentials form, the way every other visitor does. */
async function signIn(page: Page) {
  const { member } = e2eAccounts();

  await page.goto('/?auth=login');
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('#auth-email')).toBeVisible({ timeout: 60_000 });
  await dialog.locator('#auth-email').fill(member.email);
  await dialog.locator('#auth-password').fill(member.password);
  await dialog.getByRole('button', { name: 'Log in', exact: true }).click();

  // The account menu prints the session's own address, so this cannot pass while
  // signed out — the tests below depend on the session having actually resolved.
  //
  // The budget is this large because of what it has to cover, not to paper over a
  // slow assertion: the tests in this file each sign in in their own context, and
  // against a just-started dev server the first of them pays for a Turbopack
  // compile of `/`, of the credentials callback, and of `/dashboard`, while the
  // other workers queue behind the same compiles. At 60s one worker lost that race
  // and reported a signed-out home page; on its own the same test takes 9s.
  await expect(page.getByRole('button', { name: 'Open account menu' })).toContainText(
    member.email,
    { timeout: 150_000 },
  );
}

/**
 * The signed-out half of the journeys.
 *
 * This file held nine `.fixme()` tests. Four of them — journeys 5, 6, 7 and the
 * signed-in half of 8 — were duplicates of work that is now real elsewhere:
 * journeys 5 and 6 in `journeys-workflow.spec.ts`, journey 7 in
 * `journeys-authenticated.spec.ts`. Keeping a second, hollow copy made the report
 * claim those features twice while asserting them once, so the copies are gone
 * rather than re-stubbed.
 *
 * The other five were a `visual regression (scaffolded baselines)` block: five
 * screens at three widths, fifteen results, each of which set a viewport and then
 * asserted `page.url()` was truthy without ever taking a screenshot. It has been
 * deleted rather than given baselines. Playwright suffixes snapshots with the
 * platform (`-win32.png`), so baselines committed from this machine would be
 * missing on the Linux CI runner and turn every one of those fifteen red — a
 * screenshot suite has to be generated where the gate runs, and choosing the
 * screens is a product decision, not a loose end for this file to invent.
 *
 * What is left is the one thing this project is uniquely able to assert, because
 * it is the only one that runs without a storage state: what a stranger meets.
 */
test.describe('journey 8 — a gated page asks a stranger to sign in, then delivers it', () => {
  // Above the sign-in budget in `signIn`, so a cold first compile reports the
  // assertion that ran out rather than a bare test timeout that names nothing.
  test.describe.configure({ timeout: 210_000 });

  /**
   * Seeded here rather than through the `setup` project: this project has no
   * `dependencies` in `playwright.config.ts`, so the storage state may not have
   * been written yet — and this test wants no storage state anyway. The upsert is
   * idempotent, and the sign-in below goes through the real credentials form.
   */
  test.beforeAll(async () => {
    await seedE2eAccount();
  });

  test('/templates is refused to a stranger, and the gate remembers the destination', async ({
    page,
  }) => {
    await page.goto('/templates');

    // `PUBLIC_PAGES` (`lib/auth/public-pages.ts`) is `/`, `/login`, `/signup`
    // and `/preview-view`, so /templates is
    // gated and a stranger is redirected to `/?auth=login&next=/templates`. That
    // redirect answers 200 with a real title, which is exactly why the assertion
    // this test used to make — `response.status() > 0` — was true of being turned
    // away, of a 500, and of the gallery alike.
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('#auth-email')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Templates', exact: true })).toHaveCount(0);

    // The destination has to survive the refusal, or there is nothing for the modal
    // to return the user to. Asserted as the value `proxy.ts` wrote rather than as
    // "some URL", because dropping it fails nothing else: the sign-in still works
    // and simply strands the user on the dashboard.
    const gate = new URL(page.url());
    expect(gate.pathname).toBe('/');
    expect(gate.searchParams.get('auth')).toBe('login');
    expect(gate.searchParams.get('next')).toBe('/templates');
  });

  test('signing in at the gate hands over the page that was asked for', async ({ page }) => {
    const { member } = e2eAccounts();

    await page.goto('/templates');

    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('#auth-email')).toBeVisible({ timeout: 60_000 });
    await dialog.locator('#auth-email').fill(member.email);
    await dialog.locator('#auth-password').fill(member.password);
    await dialog.getByRole('button', { name: 'Log in', exact: true }).click();

    // The gallery's own `h1` is the proof, not the URL. Note that this half of the
    // journey is a race the client can win on its own: `AuthModal` calls
    // `router.push(next)` and then `router.refresh()`, and if the push commits first
    // the destination survives without any help from the server. Which one wins
    // depends on how fast the server answers — against a production build the
    // refresh won every time, on a dev server the push usually does. The test below
    // pins the server's half, which is what removes the race rather than winning it.
    await expect(page.getByRole('heading', { name: 'Templates', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    expect(new URL(page.url()).pathname).toBe('/templates');

    // Signed in, on the page that was refused a moment ago: the gate opened rather
    // than the markup having been behind a modal all along.
    await expect(page.locator('#auth-email')).toHaveCount(0);
  });

  /**
   * The three ways `/` has to resolve `next` for a visitor who already has a
   * session, in one test because they share one prerequisite: a real sign-in.
   *
   * Split across three tests they cost three sign-ins in three fresh contexts, and
   * every one of them pays for a cold Turbopack compile of `/`, of the credentials
   * callback and of `/dashboard`. Under the full suite that starved the dev server
   * badly enough to time out `auth.setup.ts` and strand fifteen tests that never
   * ran. The assertions are unchanged and each carries its own message, so a
   * failure still names which of the three broke.
   */
  test('the home route resolves next safely for a signed-in visitor', async ({ page }) => {
    await signIn(page);
    const origin = new URL(page.url()).origin;

    // 1. The destination is honoured. Redirects off, so this is the server's own
    // answer and not whatever the client router settled on: `app/page.tsx` used to
    // read the session before the search params and answer `/dashboard`
    // unconditionally, which is the half of the bug no client timing can fix — a
    // visitor whose `router.refresh()` lands here loses the destination `proxy.ts`
    // had just recorded for them.
    const response = await page.request.get('/?auth=login&next=%2Ftemplates', {
      maxRedirects: 0,
    });
    expect(response.status(), 'a signed-in visitor must be redirected off the home page').toBe(307);
    const location = response.headers()['location'];
    expect(location, 'the redirect must name a destination').toBeTruthy();
    expect(new URL(location, origin).pathname, 'next must be honoured').toBe('/templates');

    // 2. `next=/` names this very route, so honouring it literally would redirect
    // here, find the session again, and redirect again.
    await page.goto('/?next=%2F');
    await expect(
      page.getByRole('heading', { name: `What's on your mind, ${E2E_ACCOUNT_FIRST_NAME}?` }),
    ).toBeVisible({ timeout: 60_000 });
    expect(new URL(page.url()).pathname, 'next=/ must not bounce in a loop').toBe('/dashboard');

    // 3. `/\host` is the form a prefix check misses: rejecting `//` alone admitted
    // it, and a browser parses a backslash in a special-scheme URL as a path
    // separator, so it reads as `//host` and leaves the site. Both hosts are
    // `.invalid`, which never resolves — a redirect that did escape fails the
    // navigation outright rather than quietly succeeding against a real server.
    for (const hostile of ['/\\next-path-escaped.invalid', '//next-path-escaped.invalid']) {
      await page.goto(`/?next=${encodeURIComponent(hostile)}`);
      const landed = new URL(page.url());
      expect(landed.origin, `next=${hostile} must not move the origin`).toBe(origin);
      expect(landed.pathname).toBe('/dashboard');
    }
  });
});
