import { expect, test } from '@playwright/test';
import {
  E2E_ACCOUNT_FIRST_NAME,
  E2E_ADMIN_ACCOUNT_NAME,
  resolveE2eTarget,
} from './support/account';
import { ADMIN_STORAGE_STATE } from './support/paths';
import { createIdleProject, deleteProject } from './support/projects';
import {
  deleteE2eUser,
  e2eAccounts,
  E2E_TEMPLATE_NAME,
  E2E_TEMPLATE_PROMPT,
  seedE2eTemplate,
} from './support/seed-account';

/**
 * The account-level authenticated journeys: 0 (the dashboard), 7 (the ADMIN-only
 * invite) and 8 (template to project). They run with the storage state written by
 * `auth.setup.ts` — the MEMBER session, except where journey 7 opts into the ADMIN
 * one.
 *
 * Rules this file exists to hold: never assert on a title, a status code alone, or
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

/**
 * The address journey 7 invites. Fixed rather than random so a crashed run leaves
 * one known row behind instead of accumulating them, and derived from the member
 * address so it lands in the same reserved `.invalid` domain.
 */
function invitedEmail() {
  const { member } = e2eAccounts();
  const at = member.email.lastIndexOf('@');
  return `${member.email.slice(0, at)}-invited${member.email.slice(at)}`;
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

/**
 * Journey 7 — the invite is ADMIN-only.
 *
 * Two halves, and neither means anything alone: a MEMBER who is refused proves
 * nothing if the screen is broken for everybody, and an ADMIN who succeeds proves
 * nothing if a MEMBER could have done the same. `/admin/team` is where the whole
 * invite-only product is administered, so both halves are asserted — the page and
 * the API behind it.
 */
test.describe('journey 7 — admin team invite', () => {
  test.describe.configure({ timeout: 90_000 });

  test.describe('as a member', () => {
    test('the team page is refused and the invite API answers 403', async ({ page, request }) => {
      await page.goto('/admin/team');

      // `app/(app)/admin/layout.tsx` calls `requireAdmin()` and redirects to the
      // dashboard, so the proof is the dashboard's own greeting plus the absence
      // of the thing the page exists to offer.
      await expect(
        page.getByRole('heading', { name: `What's on your mind, ${E2E_ACCOUNT_FIRST_NAME}?` }),
      ).toBeVisible({ timeout: 45_000 });
      await expect(page.getByRole('button', { name: 'Invite member' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Team', exact: true })).toHaveCount(0);

      // The redirect is chrome; this is the boundary. A member who posts straight
      // at the route has to be turned away by the route itself.
      const response = await request.post('/api/admin/invite', {
        data: { email: 'never-created@navroop.invalid', name: 'Nope', role: 'ADMIN' },
      });
      expect(response.status()).toBe(403);
      expect((await response.json()) as { error?: string }).toEqual({
        error: 'Admin access required',
      });
    });
  });

  test.describe('as an admin', () => {
    // The only journey that needs the second session `auth.setup.ts` saves.
    test.use({ storageState: ADMIN_STORAGE_STATE });

    // The invited row is removed before *and* after: `POST /api/admin/invite`
    // answers 409 for any address that already exists, so a run that crashed
    // mid-invite would otherwise wedge every later run.
    test.beforeEach(async () => {
      await deleteE2eUser(invitedEmail());
    });

    test.afterEach(async () => {
      await deleteE2eUser(invitedEmail());
    });

    test('an admin invites a member and the new row joins the table', async ({ page }) => {
      const email = invitedEmail();

      await page.goto('/admin/team');

      // The admin session reaches the page a member could not, and it is the
      // Team page rather than a redirect to the dashboard.
      await expect(page.getByRole('heading', { name: 'Team', exact: true })).toBeVisible({
        timeout: 45_000,
      });
      // The row the page marks as the viewer. `selfId` comes from the session and
      // an admin may not demote themselves, so the "This is you" note and the
      // disabled ADMIN select together prove this storage state signed in as the
      // seeded admin rather than the member. A bare `getByText(name)` matched both
      // the name cell and the role select's own sr-only label, so it failed strict
      // mode instead of checking anything.
      const ownRow = page.getByRole('row').filter({ hasText: E2E_ADMIN_ACCOUNT_NAME });
      await expect(ownRow.getByText('This is you')).toBeVisible();
      const ownRole = ownRow.getByRole('combobox', { name: `Role for ${E2E_ADMIN_ACCOUNT_NAME}` });
      await expect(ownRole).toHaveValue('ADMIN');
      await expect(ownRole).toBeDisabled();

      await page.getByRole('button', { name: 'Invite member' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Invite a member' })).toBeVisible();

      await dialog.locator('#invite-email').fill(email);
      await dialog.locator('#invite-name').fill('Invited Journey Member');
      await dialog.getByRole('button', { name: 'Create invite' }).click();

      // Invite-only means the temporary password is the entire handover, and it
      // is shown exactly once — so an empty or missing one strands the invitee.
      await expect(dialog.getByRole('heading', { name: 'Member created' })).toBeVisible({
        timeout: 30_000,
      });
      const password = await dialog.locator('code').innerText();
      expect(password.trim().length, 'the temporary password must be shown once').toBeGreaterThan(
        4,
      );

      await dialog.getByRole('button', { name: 'Done' }).click();

      // The row behind the dialog is the outcome a user would notice: the person
      // is now on the team and can be given a reset link.
      const row = page.getByRole('row').filter({ hasText: email });
      await expect(row).toBeVisible();
      await expect(row.getByRole('combobox', { name: /Role for/ })).toHaveValue('MEMBER');
      await expect(row.getByRole('button', { name: 'Send reset link' })).toBeVisible();
    });
  });
});

/**
 * Journey 8 — a template becomes a project.
 *
 * One paid step is replaced and nothing else: `POST /api/templates/{id}/create`
 * runs `createProject` with plan mode on, so the real route generates a plan
 * server-side on every call. The route is therefore fulfilled with a project this
 * test created beforehand with `skipPlanning`, and the assertion that matters is
 * made on the *request* the sheet sent — the prompt the gallery read out of the
 * database has to be the prompt the create receives, and the app has to open the
 * project the API named.
 */
test.describe('journey 8 — template to project', () => {
  test.describe.configure({ timeout: 120_000 });

  let templateId = '';
  let standInProjectId: string | null = null;

  test.beforeEach(async ({ request }) => {
    const template = await seedE2eTemplate();
    templateId = template.id;
    expect(template.prompt, 'the seeded template must carry the journey prompt').toBe(
      E2E_TEMPLATE_PROMPT,
    );
    standInProjectId = await createIdleProject(request, E2E_TEMPLATE_PROMPT);
  });

  test.afterEach(async ({ request }) => {
    await deleteProject(request, standInProjectId);
    standInProjectId = null;
  });

  test('the templates API serves the seeded template to a member', async ({ request }) => {
    const response = await request.get('/api/templates');
    expect(response.ok()).toBeTruthy();

    const body = (await response.json()) as {
      templates?: { id: string; name: string; prompt?: string }[];
    };
    const seeded = body.templates?.find((row) => row.id === templateId);
    expect(seeded, 'a workspace template must be visible to an ordinary member').toBeTruthy();
    expect(seeded?.name).toBe(E2E_TEMPLATE_NAME);
  });

  test('choosing a template opens a project built from its prompt', async ({ page }) => {
    let sentPrompt: string | null = null;

    await page.route('**/api/templates/*/create', async (call) => {
      const posted = call.request().postDataJSON() as { prompt?: string };
      sentPrompt = posted?.prompt ?? null;
      await call.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: standInProjectId }),
      });
    });

    await page.goto('/templates');

    // The gallery is rendered from database rows, so finding the seeded card by
    // its name proves the listing reached the browser.
    const card = page.getByRole('button').filter({ hasText: E2E_TEMPLATE_NAME });
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.click();

    // The sheet pre-fills the template's stored prompt, which is the whole point
    // of a template: an editable brief rather than a blank box.
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('heading', { name: E2E_TEMPLATE_NAME })).toBeVisible();
    await expect(sheet.getByRole('textbox')).toHaveValue(E2E_TEMPLATE_PROMPT);

    await sheet.getByRole('button', { name: 'Create from this template' }).click();

    // The workspace top bar renders the stored project name in an editable field,
    // and it exists only once `/project/[id]` has loaded a row.
    const nameField = page.getByRole('textbox', { name: 'Project name' });
    await expect(nameField).toBeVisible({ timeout: 60_000 });
    await expect(nameField).not.toHaveValue('');
    expect(new URL(page.url()).pathname).toBe(`/project/${standInProjectId}`);

    // The request the sheet actually sent. A sheet that posted an empty prompt,
    // or the wrong template's, would satisfy every assertion above.
    expect(sentPrompt, 'the create must carry the template prompt').toBe(E2E_TEMPLATE_PROMPT);
  });
});
