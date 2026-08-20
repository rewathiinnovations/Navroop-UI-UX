/**
 * The one boundary validator for the project a generation belongs to.
 *
 * `/api/generate-ai-code-stream` used to accept a request with no project id at all and run
 * the build anyway. Everything that meters a generation hangs off the `Job` row, and
 * `Job.projectId` is a required foreign key — so no project meant no row, and with no row
 * the route skipped the provider-queue slot (`AI_PROVIDER_CONCURRENCY`), `markJobRunning`'s
 * credit charge, the per-job caps, `recordJobUsage`'s spend accrual, the heartbeat, the
 * progress batcher and the terminal settle. `checkCredits` still ran, so the request was
 * checked against a ceiling that nothing then debited: a loop that omitted one field bought
 * unlimited concurrent generations that cost no credit, took no slot and accrued no spend
 * (F-035).
 *
 * Refusing, rather than metering it on a workspace-scoped row: the product has no
 * project-less entry point. `createProjectFromPrompt` POSTs `/api/projects` and only arms
 * the build once the row exists, the workspace resolves an id (creating one if it must)
 * before it streams, and the route answers 401 without a session — so the signed-out
 * "unsaved" run this shape was presumably once for cannot reach it either. And nothing an
 * unsaved run produced could be kept: the generated files are persisted by
 * `settleStreamedGeneration` against a project id, so a project-less build was unbillable,
 * uncancellable, unrecoverable and unsaveable, while still buying provider tokens.
 */

export const PROJECT_REQUIRED_MESSAGE =
  'This build has no project to save to. Open or create a project and try again.';

export type GenerationProjectResult =
  { ok: true; projectId: string } | { ok: false; message: string };

function usableId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * `projectId` at the top level of the body, or the copy inside `context` the workspace sends
 * on some paths, in that order. Returns the trimmed id so the handler resolves it once
 * instead of re-deriving the same expression for the lock, the job row, the usage event and
 * the conversation state — four chances for one of them to disagree about whether the run
 * has a project.
 */
export function readGenerationProjectId(
  value: unknown,
  contextValue: unknown,
): GenerationProjectResult {
  const projectId = usableId(value) ?? usableId(contextValue);
  if (!projectId) return { ok: false, message: PROJECT_REQUIRED_MESSAGE };
  return { ok: true, projectId };
}
