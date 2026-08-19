import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { PROMPT_PLACEHOLDER } from '../components/app/studio/PromptBox';
import { getStack, STACK_IDS } from '../lib/stacks';
import { deleteProject, STORED_SITE, useIdleProject } from './support/projects';
import { e2eAccounts, seedAbandonedBuildJob } from './support/seed-account';

/**
 * The workspace journeys — 2, 3, 4, 5 and 6 — made real.
 *
 * All of them started life as `.fixme()` stubs whose bodies asserted `page.url()`
 * is truthy, which is true of any loaded document, so they passed against a 500
 * page or an app with the feature deleted. What they were supposed to assert is
 * written in the comments each one now carries.
 *
 * These run in the `authenticated` project, so they share its rule: never assert
 * on a title, a status code alone, or `page.url()`. Landing on the workspace is
 * proved by markup that only the workspace renders.
 *
 * Nothing here is allowed to spend money, start a VM, or deploy. Two separate
 * leaks have to be held shut for that to be true, and they need different tools:
 * browser fetches go through `blockPaidRoutes`, and the dashboard's *server-side*
 * plan generation goes through `skipPlanningOnDashboardCreate`.
 */

/**
 * Endpoints that cost tokens, a VM, or a deploy, each paired with the route file
 * it belongs to.
 *
 * The on-disk path is not decoration: the previous list stubbed
 * `apply-ai-code-stream`, `create-ai-sandbox` and `create-ai-sandbox-v2`, none of
 * which exist any more — the last two died with the sandbox subsystem — while
 * `analyze-edit-intent`, which the workspace calls on every chat send, had no
 * stub at all. A pattern for a deleted route protects nothing and reads as if it
 * does, so `blockPaidRoutes` now refuses to run when a pattern names a route that
 * is not in the tree.
 */
const PAID_ROUTES = [
  {
    pattern: '**/api/generate-ai-code-stream**',
    route: 'app/api/generate-ai-code-stream/route.ts',
  },
  { pattern: '**/api/analyze-edit-intent**', route: 'app/api/analyze-edit-intent/route.ts' },
  { pattern: '**/api/scrape-website**', route: 'app/api/scrape-website/route.ts' },
  { pattern: '**/api/scrape-url-enhanced**', route: 'app/api/scrape-url-enhanced/route.ts' },
  { pattern: '**/api/scrape-screenshot**', route: 'app/api/scrape-screenshot/route.ts' },
  { pattern: '**/api/extract-brand-styles**', route: 'app/api/extract-brand-styles/route.ts' },
  // The trailing `**` also covers plan/refine, plan/followup and plan/approve.
  { pattern: '**/api/projects/*/plan**', route: 'app/api/projects/[id]/plan/route.ts' },
  { pattern: '**/api/projects/*/import**', route: 'app/api/projects/[id]/import/route.ts' },
  { pattern: '**/api/projects/*/publish**', route: 'app/api/projects/[id]/publish/route.ts' },
] as const;

/**
 * Answers the paid routes with a plain 503 rather than aborting them.
 *
 * An aborted request surfaces as a `TypeError: Failed to fetch`, which the
 * workspace reports as a crash; a refusal is a shape the app already knows how to
 * render, so a failure in these tests points at the journey rather than at the
 * stub.
 *
 * Reads are passed through. `GET /api/projects/{id}/publish` is what tells the
 * Publish button whether it may run at all, and stubbing it turned journey 4's
 * assertion into a test of the stub: the panel falls back to its default hint
 * whenever that read fails, which looks exactly like a correct refusal.
 */
async function blockPaidRoutes(page: Page) {
  for (const { pattern, route } of PAID_ROUTES) {
    expect(
      existsSync(resolve(process.cwd(), route)),
      `${pattern} stubs ${route}, which is not in the tree — delete the pattern or fix the path`,
    ).toBe(true);
  }

  for (const { pattern } of PAID_ROUTES) {
    await page.route(pattern, async (call) => {
      const method = call.request().method();
      // Reads pass through; blocking them would hide the app's own refusals.
      if (method === 'GET' || method === 'HEAD') {
        await call.continue();
        return;
      }
      await call.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Blocked by the e2e journey — no provider call was made' }),
      });
    });
  }
}

type ActionPatch = { patched: boolean; problem: string | null };

/**
 * Makes the dashboard's Create button stop generating a plan on the server.
 *
 * `app/(app)/dashboard/page.tsx` calls the `createProject` *server action*
 * directly with `deferPlanning: true` and no `skipPlanning`, so
 * `lib/projects/actions.ts` runs `applyCreateProjectPlanFlow` detached inside the
 * request — a real model call that `page.route` cannot see, because a server
 * action posts to the page URL (`POST /dashboard`, `Next-Action` header) and not
 * to `/api/projects`. Every run of this journey used to spend tokens, in a file
 * whose header promised it could not.
 *
 * So the action's own arguments are rewritten on the way past to add
 * `skipPlanning: true`, which routes the same call into
 * `startInitialGeneration` — one GenerationEvent row, no provider
 * (`lib/projects/plan.ts:305`).
 *
 * This reaches into how Next serialises action arguments, which is the reason it
 * reports rather than assumes: `encodeReply` produces a JSON array for plain
 * serialisable arguments today, and if that ever changes the returned record says
 * so and the test fails on it. Silently falling back to "just let it through"
 * would put the token spend back without anybody noticing.
 */
async function skipPlanningOnDashboardCreate(page: Page): Promise<ActionPatch> {
  const patch: ActionPatch = { patched: false, problem: null };

  await page.route('**/dashboard', async (call) => {
    const request = call.request();
    if (request.method() !== 'POST' || !request.headers()['next-action']) {
      await call.continue();
      return;
    }

    const raw = request.postData();
    let args: unknown;
    try {
      args = raw === null ? null : JSON.parse(raw);
    } catch {
      args = null;
    }
    const first = Array.isArray(args) ? args[0] : null;
    if (!first || typeof first !== 'object' || !('initialPrompt' in first)) {
      patch.problem =
        'The createProject server action no longer posts its arguments as a JSON array of plain objects, so skipPlanning could not be injected and this journey would generate a real plan. Re-check how Next encodes action arguments.';
      await call.abort();
      return;
    }

    patch.patched = true;
    await call.continue({
      postData: JSON.stringify([{ ...(first as Record<string, unknown>), skipPlanning: true }]),
    });
  });

  return patch;
}

test.describe('journey 2 — create project from a prompt', () => {
  // A cold Turbopack compile of /dashboard and then /project/[id], two of the
  // heaviest routes in the app, both on first hit.
  test.describe.configure({ timeout: 120_000 });

  let createdProjectId: string | null = null;

  test.afterEach(async ({ request }) => {
    await deleteProject(request, createdProjectId);
    createdProjectId = null;
  });

  test('a prompt on the dashboard becomes a project workspace', async ({ page }) => {
    await blockPaidRoutes(page);
    const patch = await skipPlanningOnDashboardCreate(page);
    await page.goto('/dashboard');

    const prompt = 'A one-page site for a neighbourhood bike repair shop';
    await page.getByPlaceholder(PROMPT_PLACEHOLDER).fill(prompt);

    // Asserted rather than clicked straight through, because the failure this
    // catches is silent: `useDraftStorage` restores the saved draft in a mount
    // effect, and the textarea is server rendered, so it takes input before that
    // effect runs. While the restore was unconditional it overwrote the typed
    // prompt with the empty string and the button — disabled on an empty value —
    // greyed back out. Clicking directly reports only "element is not enabled"
    // after the full timeout, which says nothing about why.
    const submit = page.getByRole('button', { name: 'Create project' });
    await expect(submit, 'the typed prompt must survive draft hydration').toBeEnabled({
      timeout: 30_000,
    });
    await submit.click();

    // The workspace top bar renders the stored name in an editable field. It
    // exists only once `/project/[id]` has loaded a project row, so this is the
    // assertion that the prompt reached the database and came back — not that
    // some document loaded.
    const nameField = page.getByRole('textbox', { name: 'Project name' });
    await expect(nameField).toBeVisible({ timeout: 60_000 });
    await expect(nameField).not.toHaveValue('');

    createdProjectId = new URL(page.url()).pathname.match(/^\/project\/([^/]+)/)?.[1] ?? null;
    expect(createdProjectId, 'the dashboard must route to /project/{id}').toBeTruthy();

    expect(patch.problem, patch.problem ?? '').toBeNull();
    expect(patch.patched, 'the create action must have been reached and rewritten').toBe(true);

    // The prompt is what the project was created from, so it has to be on the row
    // the workspace is showing — a workspace that opened some *other* project
    // would satisfy every assertion above.
    const response = await page.request.get(`/api/projects/${createdProjectId}`);
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as { project?: { initialPrompt?: string } };
    expect(body.project?.initialPrompt).toBe(prompt);
  });
});

/**
 * Journey 2 across every stack the product actually offers.
 *
 * This lives here, and not in `journeys-stacks.spec.ts`, because choosing a stack
 * and creating a project needs a session: the six `journeys-stacks` Playwright
 * projects have neither `dependencies: ['setup']` nor a storage state, so nothing
 * they contain could ever have signed in. Three of those six project names —
 * ASTRO, VUE and SVELTE — are not in `STACK_IDS` at all, and the one test that
 * would have said so was `.fixme()`, so a matrix of six browser jobs reported
 * eighteen results about three stacks that do not exist.
 *
 * The loop is over `STACK_IDS`, so a stack added to the registry is covered here
 * the day it is added and cannot be forgotten in a config file.
 *
 * What differs per stack is the option label the user reads and the stack the
 * created row carries — a create path that ignored the picker, or mapped every
 * label onto the default, fails for two of the three. The deeper per-stack
 * differences (the scaffold `buildRepoFiles` lays down, the layout a build has to
 * match) are only observable through a real generation or a ZIP export of a
 * checkpoint, so they are not claimed here; see the named skip in
 * `journeys-stacks.spec.ts`.
 */
test.describe('journey 2 — the stack the user picks is the stack the project gets', () => {
  test.describe.configure({ timeout: 120_000 });

  let createdProjectId: string | null = null;

  test.afterEach(async ({ request }) => {
    await deleteProject(request, createdProjectId);
    createdProjectId = null;
  });

  for (const stack of STACK_IDS) {
    test(`${stack} chosen on the dashboard is the stack the workspace loads`, async ({ page }) => {
      await blockPaidRoutes(page);
      const patch = await skipPlanningOnDashboardCreate(page);
      await page.goto('/dashboard');

      const picker = page.getByRole('combobox', { name: 'Stack' });
      await expect(picker).toBeVisible({ timeout: 60_000 });
      await picker.selectOption(stack);

      // The label is the only part of this a user can see, so the mapping from the
      // words they read to the value that gets posted is asserted rather than
      // assumed. `PromptHero` appends `seoHint` to some labels, hence `toContainText`.
      await expect(picker.locator('option:checked')).toContainText(getStack(stack).label);

      await page
        .getByPlaceholder(PROMPT_PLACEHOLDER)
        .fill(`A single-page site for a ${stack} demo`);
      const submit = page.getByRole('button', { name: 'Create project' });
      await expect(submit, 'the typed prompt must survive draft hydration').toBeEnabled({
        timeout: 30_000,
      });
      await submit.click();

      const nameField = page.getByRole('textbox', { name: 'Project name' });
      await expect(nameField).toBeVisible({ timeout: 60_000 });
      createdProjectId = new URL(page.url()).pathname.match(/^\/project\/([^/]+)/)?.[1] ?? null;
      expect(createdProjectId, 'the dashboard must route to /project/{id}').toBeTruthy();

      expect(patch.problem, patch.problem ?? '').toBeNull();
      expect(patch.patched, 'the create action must have been reached and rewritten').toBe(true);

      // `/files` rather than the project row, because this is the exact response
      // `useProjectFiles` reads and hands to `BrowserPreview` as the stack to
      // assemble — the value that decides what the user is shown, not a column
      // nothing consults.
      const response = await page.request.get(`/api/projects/${createdProjectId}/files`);
      expect(response.ok(), 'the files endpoint must serve the new project').toBeTruthy();
      const body = (await response.json()) as { stack?: string };
      expect(body.stack, 'the workspace must load the stack that was picked').toBe(stack);
    });
  }
});

test.describe('journey 3 — the workspace chat offers plan and build', () => {
  test.describe.configure({ timeout: 120_000 });

  const project = useIdleProject('A landing page for a tea subscription');

  test('switching mode moves the pressed state, and both modes are reachable', async ({ page }) => {
    await blockPaidRoutes(page);
    await page.goto(`/project/${project.id}`);

    const modes = page.getByRole('group', { name: 'Chat mode' });
    await expect(modes).toBeVisible({ timeout: 60_000 });

    const plan = modes.getByRole('button', { name: 'plan' });
    const build = modes.getByRole('button', { name: 'build' });

    // Build is the default, and `aria-pressed` is the only thing that says so —
    // the selected mode was carried by background colour alone until this journey
    // needed it.
    await expect(build).toHaveAttribute('aria-pressed', 'true');
    await expect(plan).toHaveAttribute('aria-pressed', 'false');

    await plan.click();
    await expect(plan).toHaveAttribute('aria-pressed', 'true');
    await expect(build).toHaveAttribute('aria-pressed', 'false');

    // The composer stays usable in either mode; a send button that disabled
    // itself on the mode switch would make one of the two modes unreachable.
    await page.getByRole('textbox', { name: 'Ask Navroop' }).fill('Add a contact section');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  });
});

/**
 * Journey 4 — publish.
 *
 * The original stub wanted the whole thing: open the sheet, watch the PUBLISH job
 * steps advance. That cannot run here and must not be faked — a successful POST
 * pushes a repository to GitHub, creates a Cloudflare record and deploys on
 * Coolify, all against live accounts. What *is* real and free is the refusal, and
 * the refusal is the half that regresses silently: the button that should be
 * disabled, and the 409 the route owes a caller whose integrations are missing.
 */
test.describe('journey 4 — publish refuses before it can run', () => {
  test.describe.configure({ timeout: 120_000 });

  const project = useIdleProject('A brochure site for a rope-access window cleaner');

  type PublishState = {
    canPublish?: boolean;
    hasFiles?: boolean;
    setupMessage?: string | null;
    missingIntegrations?: string[];
  };

  async function publishState(request: APIRequestContext, id: string) {
    const response = await request.get(`/api/projects/${id}/publish`);
    expect(response.ok(), 'the publish state must be readable by a signed-in member').toBeTruthy();
    return (await response.json()) as PublishState;
  }

  test('the Publish button is disabled and names the reason', async ({ page, request }) => {
    const state = await publishState(request, project.id);

    // Nothing has been generated, so there is nothing to deploy. This is the
    // server's own answer, and the point of the journey is that the chrome agrees
    // with it rather than offering a button that would 409.
    expect(state.hasFiles, 'a project with no files must not report files').toBe(false);
    expect(state.canPublish, 'a project with no files must not be publishable').toBe(false);

    await blockPaidRoutes(page);
    await page.goto(`/project/${project.id}`);

    const publish = page.getByRole('button', { name: 'Publish' });
    await expect(publish).toBeVisible({ timeout: 60_000 });
    await expect(publish).toBeDisabled();

    // `Hint` keeps its tooltip in the DOM and reveals it on hover, so the reason
    // is assertable. `PublishPanel` prefers the server's setup message and falls
    // back to the generated-yet hint, so the expectation follows the same order.
    const reason = state.setupMessage || 'Generate the project first';
    await expect(page.locator('[data-tour="publish"] [role="tooltip"]')).toHaveText(reason);
  });

  test('POST publish is refused while an integration is missing', async ({ request }) => {
    const state = await publishState(request, project.id);
    const missing = state.missingIntegrations ?? [];
    test.skip(
      missing.length === 0,
      'GitHub, Cloudflare and Coolify are all connected on this machine, so POST /publish would push a repository and deploy for real. This journey only covers the refusal; the successful publish needs a throwaway Coolify/GitHub/Cloudflare account, which no automated run has.',
    );

    const response = await request.post(`/api/projects/${project.id}/publish`, {
      data: { kind: 'LIVE' },
    });
    expect(response.status()).toBe(409);

    const body = (await response.json()) as { error?: string; missingIntegrations?: string[] };
    expect(body.missingIntegrations).toEqual(missing);
    // The journeys sign in as a MEMBER, who cannot fix this and must not be shown
    // an admin path. `publishBlockedMessage` names the connections only for an
    // ADMIN.
    expect(body.error).toBe('Ask an admin to finish setup');
  });
});

/**
 * Journey 5 — custom domains.
 *
 * The original stub wanted a hostname added on a published project. Adding one
 * writes a Cloudflare record through the live integration, so this covers what a
 * user meets first and what the tab actually owes them when nothing is published:
 * that it is reachable at all, and that it says why it cannot be used yet instead
 * of offering an Add button that would fail.
 */
test.describe('journey 5 — the domains tab is a first-class workspace surface', () => {
  test.describe.configure({ timeout: 120_000 });

  // Built but not published, which is the state the Domains tab is for. The
  // stored files are also what makes the tab reachable at all — see STORED_SITE.
  const project = useIdleProject('A single-page site for a harbour sauna', STORED_SITE);

  test('opening Domains renders the unpublished empty state', async ({ page }) => {
    await blockPaidRoutes(page);
    await page.goto(`/project/${project.id}`);

    // Quality/Assets/Brain/Domains moved behind the header's overflow when Preview
    // and Code became the primary switch, so the menu is now the only way in — and
    // it closes on selection, hence the reopen to read the item's state back.
    const overflow = page.getByRole('button', { name: /more views/i });
    await expect(overflow).toBeVisible({ timeout: 60_000 });
    await overflow.click();
    const tab = page.getByRole('menuitemradio', { name: 'Domains', exact: true });
    await expect(tab).toHaveAttribute('aria-checked', 'false');
    await tab.click();
    await overflow.click();
    await expect(
      page.getByRole('menuitemradio', { name: 'Domains', exact: true }),
      'the overflow has to report which view is showing, or nothing in the header does',
    ).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');

    // The panel's own heading, so this cannot be satisfied by the menu item that was
    // just clicked. The locked variant renders "Custom domains" instead, which is a
    // plan setting: the default plan has to allow custom domains for this journey to
    // see the panel at all.
    await expect(
      page.getByRole('heading', { name: 'Domains', exact: true }),
      'the default plan must allow custom domains, or the panel renders its plan lock instead',
    ).toBeVisible({ timeout: 30_000 });

    // Nothing is published, so the panel has to say so rather than let someone
    // point a client's hostname at a site that does not exist.
    await expect(page.getByText('Publish the site first, then add a custom domain.')).toBeVisible();
    await expect(page.locator('#domain-hostname')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add domain' })).toBeDisabled();

    // Both DNS routes are offered up front — the whole point of the tab is that
    // the agency can either take over DNS or leave it with the client.
    await expect(page.getByRole('button', { name: /Easier — recommended/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Keep DNS with the client/ })).toBeVisible();
  });
});

/**
 * Journey 6 — recovering a build that never finished.
 *
 * The regression this defends is in `.cursor/lessons-learned.md`: "busy" has to
 * follow the *job*, not `Project.phase`. A project left in BUILDING with a
 * settled job used to lock the composer forever, so the one thing the person
 * could not do was ask for the build again.
 */
test.describe('journey 6 — an abandoned build offers recovery in English', () => {
  test.describe.configure({ timeout: 120_000 });

  const project = useIdleProject('A menu site for a wood-fired bakery');

  test('the recovery panel names the cause and leaves the chat usable', async ({ page }) => {
    await seedAbandonedBuildJob({
      projectId: project.id,
      ownerEmail: e2eAccounts().member.email,
    });

    await blockPaidRoutes(page);
    await page.goto(`/project/${project.id}`);

    const recovery = page.getByRole('status').filter({ hasText: 'The last build did not finish' });
    await expect(recovery).toBeVisible({ timeout: 60_000 });

    // The cause line, once. A panel that shows only its heading tells the person
    // nothing they can act on, and `recoveryCauseLine` is what turns the stored
    // `errorCode` into a sentence.
    await expect(recovery.getByText('The server restarted')).toHaveCount(1);

    // Partial work is offered back rather than thrown away — the seeded job wrote
    // three files.
    await expect(recovery.getByText('3 files were already written')).toBeVisible();
    await expect(recovery.getByRole('button', { name: 'Keep what was built' })).toBeEnabled();
    await expect(recovery.getByRole('button', { name: 'Try again' })).toBeEnabled();

    // The regression itself. `Project.phase` is still BUILDING here; only the
    // job's ABANDONED status says the build is over, and the composer has to
    // believe the job.
    const composer = page.getByRole('textbox', { name: 'Ask Navroop' });
    await expect(composer).toBeEnabled();
    await composer.fill('Try that again with a lighter palette');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  });
});
