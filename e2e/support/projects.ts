import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Project fixtures for the authenticated journeys, shared so the two spec files
 * cannot drift on the one detail that decides whether a run spends money.
 */

/**
 * Files for a project that is supposed to look built.
 *
 * `GET /api/projects/{id}/files` derives the file map from `Project.lastCode`
 * (`lib/github/current-files.filesFromLastCode`), and `hasFiles` is what moves
 * `previewPaneKind` off `'empty'`. That matters beyond the preview: while the
 * pane is empty, `PreviewPanel` renders `EmptyPreview` *in place of its
 * children*, so Quality, Assets, Brain and Domains are all unreachable on a
 * project with no code.
 */
export const STORED_SITE = [
  '<file path="index.html">',
  '<!doctype html><html lang="en"><head><title>Seeded journey site</title></head>',
  '<body><h1>Seeded journey site</h1></body></html>',
  '</file>',
].join('\n');

/**
 * A project the workspace opens idle, created through the API rather than the
 * dashboard.
 *
 * `skipPlanning` matters and is not a shortcut. Creating without it runs
 * `generatePlan` server-side — `page.route` only intercepts the browser — which
 * both spends tokens on every run and leaves the project in PLANNING, where the
 * chat's mode toggle is deliberately hidden.
 *
 * `status: 'idle'` matters for the same reason: `persistProjectGeneration` only
 * takes the checkpoint-and-build-a-preview branch on `'ready'`, so passing
 * `lastCode` here stores the code without starting a billable preview build.
 */
export async function createIdleProject(
  request: APIRequestContext,
  prompt: string,
  lastCode?: string,
) {
  const response = await request.post('/api/projects', {
    data: {
      prompt,
      initialPrompt: prompt,
      status: 'idle',
      skipPlanning: true,
      ...(lastCode ? { lastCode } : {}),
    },
  });
  expect(response.ok(), 'the project API must accept a create').toBeTruthy();
  const body = (await response.json()) as { id?: string; project?: { id?: string } };
  const id = body.id ?? body.project?.id ?? null;
  expect(id, 'the create response must name the new project').toBeTruthy();
  return id as string;
}

/** Projects created here are real rows; the dashboard would accumulate them otherwise. */
export async function deleteProject(request: APIRequestContext, projectId: string | null) {
  if (!projectId) return;
  await request.delete(`/api/projects/${projectId}`).catch(() => undefined);
}

/**
 * Per-test project, torn down afterwards. Returns a holder rather than an id
 * because the hooks it registers run long after this call has returned.
 */
export function useIdleProject(prompt: string, lastCode?: string) {
  const holder: { id: string } = { id: '' };

  test.beforeEach(async ({ request }) => {
    holder.id = await createIdleProject(request, prompt, lastCode);
  });

  test.afterEach(async ({ request }) => {
    await deleteProject(request, holder.id);
    holder.id = '';
  });

  return holder;
}
