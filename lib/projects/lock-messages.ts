/**
 * Lock copy, kept free of `@/lib/db` so client-side modules can read it.
 *
 * Split out for the same reason `lib/security/url-guard-messages.ts` is: `lib/jobs/copy.ts`
 * needs the sentence for the `project_lock_lost` recovery line and reaches the browser
 * through the RecoveryPanel, while `lib/projects/lock.ts` imports Prisma.
 */

/**
 * Shown when a run finished — or was stopped — under a project lock it had lost. It says
 * "nothing was saved" because that is the contract the loss enforces: the run refuses to
 * write rather than overwrite whatever took the project.
 */
export const LOCK_LOST_MESSAGE =
  'Another run took over this project while this one was working, so nothing was saved. Try again.';
