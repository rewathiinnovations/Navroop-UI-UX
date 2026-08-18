import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { PROMPT_PLACEHOLDER } from '../components/app/studio/PromptBox';

/**
 * Journeys 2 and 3 from `journeys-critical.spec.ts`, made real.
 *
 * Those two were `.fixme()` stubs whose bodies asserted `page.url()` is truthy — true of
 * any loaded document, so they passed against a 500 page or an app with project creation
 * deleted. What they were supposed to assert is written in the comments there; this file
 * asserts it, using the signed-in storage state from `auth.setup.ts`.
 *
 * These run in the `authenticated` project, so they share its rule: never assert on a
 * title, a status code, or `page.url()` alone. Landing on the workspace is proved by
 * markup that only the workspace renders.
 *
 * Nothing here is allowed to spend money. Submitting a prompt on the dashboard arms
 * `sessionStorage.navroopPrompt`, and the workspace auto-sends it ~400ms after it mounts —
 * a real model call and a real sandbox. Every paid endpoint is stubbed below, so the
 * journeys exercise the routing, persistence and chrome without a provider or a VM.
 */

/** The endpoints that cost tokens, a sandbox VM, or a deploy. */
const PAID_ROUTES = [
  '**/api/generate-ai-code-stream**',
  '**/api/apply-ai-code-stream**',
  '**/api/create-ai-sandbox**',
  '**/api/create-ai-sandbox-v2**',
  '**/api/projects/*/plan**',
  '**/api/projects/*/publish**',
];

/**
 * Answers the paid routes with a plain 503 rather than aborting them.
 *
 * An aborted request surfaces as a `TypeError: Failed to fetch`, which the workspace
 * reports as a crash; a refusal is a shape the app already knows how to render, so a
 * failure in these tests points at the journey rather than at the stub.
 */
async function blockPaidRoutes(page: Page) {
  for (const pattern of PAID_ROUTES) {
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Blocked by the e2e journey — no provider call was made' }),
      }),
    );
  }
}

/** Projects created here are real rows; the dashboard would accumulate them otherwise. */
async function deleteProject(request: APIRequestContext, projectId: string | null) {
  if (!projectId) return;
  await request.delete(`/api/projects/${projectId}`).catch(() => undefined);
}

/** `/project/{id}` — the id the workspace is showing, or null if we never landed on one. */
function projectIdFrom(page: Page) {
  return new URL(page.url()).pathname.match(/^\/project\/([^/]+)/)?.[1] ?? null;
}

test.describe('journey 2 — create project from a prompt', () => {
  // A cold Turbopack compile of /dashboard and then /project/[id], two of the heaviest
  // routes in the app, both on first hit.
  test.describe.configure({ timeout: 120_000 });

  let createdProjectId: string | null = null;

  test.afterEach(async ({ request }) => {
    await deleteProject(request, createdProjectId);
    createdProjectId = null;
  });

  test('a prompt on the dashboard becomes a project workspace', async ({ page }) => {
    await blockPaidRoutes(page);
    await page.goto('/dashboard');

    const prompt = 'A one-page site for a neighbourhood bike repair shop';
    await page.getByPlaceholder(PROMPT_PLACEHOLDER).fill(prompt);

    // Asserted rather than clicked straight through, because the failure this catches is
    // silent: `useDraftStorage` restores the saved draft in a mount effect, and the textarea
    // is server rendered, so it takes input before that effect runs. While the restore was
    // unconditional it overwrote the typed prompt with the empty string and the button —
    // disabled on an empty value — greyed back out. Clicking directly reports only
    // "element is not enabled" after the full timeout, which says nothing about why.
    const submit = page.getByRole('button', { name: 'Create project' });
    await expect(submit, 'the typed prompt must survive draft hydration').toBeEnabled({
      timeout: 30_000,
    });
    await submit.click();

    // The workspace top bar renders the stored name in an editable field. It exists only
    // once `/project/[id]` has loaded a project row, so this is the assertion that the
    // prompt reached the database and came back — not that some document loaded.
    const nameField = page.getByRole('textbox', { name: 'Project name' });
    await expect(nameField).toBeVisible({ timeout: 60_000 });
    await expect(nameField).not.toHaveValue('');

    createdProjectId = projectIdFrom(page);
    expect(createdProjectId, 'the dashboard must route to /project/{id}').toBeTruthy();

    // The prompt is what the project was created from, so it has to be on the row the
    // workspace is showing — a workspace that opened some *other* project would satisfy
    // every assertion above.
    const response = await page.request.get(`/api/projects/${createdProjectId}`);
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as { project?: { initialPrompt?: string } };
    expect(body.project?.initialPrompt).toBe(prompt);
  });
});

test.describe('journey 3 — the workspace chat offers plan and build', () => {
  test.describe.configure({ timeout: 120_000 });

  let createdProjectId: string | null = null;

  // Created through the API rather than the dashboard: that path never arms
  // `sessionStorage.navroopPrompt`, so the workspace opens idle and the mode toggle is
  // rendered (`showMode` is false while a build or a plan is running).
  //
  // `skipPlanning` matters and is not a shortcut. Creating without it runs `generatePlan`
  // *server-side* — `page.route` only intercepts the browser, so the stub above cannot
  // reach it — which both spends tokens on every run and leaves the project in PLANNING,
  // where the toggle is deliberately hidden. With it, `applyCreateProjectPlanFlow` only
  // logs a GenerationEvent and calls no provider.
  test.beforeEach(async ({ request }) => {
    const response = await request.post('/api/projects', {
      data: { prompt: 'A landing page for a tea subscription', status: 'idle', skipPlanning: true },
    });
    expect(response.ok(), 'the project API must accept a create').toBeTruthy();
    const body = (await response.json()) as { id?: string; project?: { id?: string } };
    createdProjectId = body.id ?? body.project?.id ?? null;
    expect(createdProjectId).toBeTruthy();
  });

  test.afterEach(async ({ request }) => {
    await deleteProject(request, createdProjectId);
    createdProjectId = null;
  });

  test('switching mode moves the pressed state, and both modes are reachable', async ({ page }) => {
    await blockPaidRoutes(page);
    await page.goto(`/project/${createdProjectId}`);

    const modes = page.getByRole('group', { name: 'Chat mode' });
    await expect(modes).toBeVisible({ timeout: 60_000 });

    const plan = modes.getByRole('button', { name: 'plan' });
    const build = modes.getByRole('button', { name: 'build' });

    // Build is the default, and `aria-pressed` is the only thing that says so — the
    // selected mode was carried by background colour alone until this journey needed it.
    await expect(build).toHaveAttribute('aria-pressed', 'true');
    await expect(plan).toHaveAttribute('aria-pressed', 'false');

    await plan.click();
    await expect(plan).toHaveAttribute('aria-pressed', 'true');
    await expect(build).toHaveAttribute('aria-pressed', 'false');

    // The composer stays usable in either mode; a send button that disabled itself on the
    // mode switch would make one of the two modes unreachable.
    await page.getByRole('textbox', { name: 'Ask Navroop' }).fill('Add a contact section');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  });
});
