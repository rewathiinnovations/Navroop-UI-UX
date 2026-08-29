import { prisma } from '@/lib/db';
import { withStarterFiles } from '@/lib/stacks/starter';
import { getStack } from '@/lib/stacks';
import type { StackId } from '@/lib/stacks';
import { readSnapshot } from './snapshot';

/**
 * Go back to the last version that actually worked, when a repair loop ends broken.
 *
 * The auto-fix loop runs *because* validation failed, and it stops the moment a pass
 * validates clean — so there is never a good intermediate inside the loop to return to. When
 * the loop exhausts its attempts the project is left holding the last broken attempt, which
 * is not merely unfixed: on an edit to a working site, it is worse than what the user had
 * before they typed anything. Two billed repair generations, and the site is more broken than
 * at the start.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE. It does not chase the "best" version by score. A page
 * with fewer advisory findings is not worth silently rewriting someone's project for, and a
 * site changing under a user who did not ask is its own defect. This runs only when the
 * current state is broken, so the choice is between a broken site and a working one.
 *
 * WHY IT VERIFIES RATHER THAN REMEMBERS. Recording "this checkpoint was good" on the row
 * would be a claim that ages: the flag is written once and read much later, and nothing keeps
 * it true. Re-running the checks against the candidate's own files answers the only question
 * that matters — does *this* version work — at the moment it is asked, and needs no schema
 * change to do it. The cost is a few seconds, paid only on the rare path where a repair loop
 * has already given up.
 */

/** How far back to look. Beyond this the version is old enough that silently restoring it is its own surprise. */
const MAX_CANDIDATES = 3;

export type WorkingCheckpointSearch =
  | { found: true; checkpointId: string; label: string; createdAt: Date }
  | { found: false; reason: 'no-candidates' | 'none-validated' };

/**
 * The most recent checkpoint, other than the current state, whose files still build and
 * type-check. Read-only: finding it and restoring it are separate acts, so a caller can
 * report the result without committing to the write.
 */
export async function findLastWorkingCheckpoint(
  projectId: string,
  options: { skipCheckpointId?: string | null } = {},
): Promise<WorkingCheckpointSearch> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { stack: true, designDirection: true },
  });
  if (!project) return { found: false, reason: 'no-candidates' };

  const stack = getStack(project.stack).id as StackId;
  // STATIC_HTML has no module graph, so "does it build" is not a question these checks can
  // answer — and a restore chosen on no evidence is worse than leaving the state alone.
  if (stack === 'STATIC_HTML') return { found: false, reason: 'no-candidates' };

  const candidates = await prisma.checkpoint.findMany({
    where: {
      projectId,
      snapshotPruned: false,
      ...(options.skipCheckpointId ? { id: { not: options.skipCheckpointId } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_CANDIDATES,
    select: { id: true, label: true, createdAt: true, snapshotKey: true, fileSnapshot: true },
  });
  if (candidates.length === 0) return { found: false, reason: 'no-candidates' };

  for (const candidate of candidates) {
    const entries = await readSnapshot(candidate).catch(() => []);
    if (entries.length === 0) continue;
    const files = Object.fromEntries(entries.map((entry) => [entry.path, entry.content]));
    if (await validates(stack, files, project.designDirection)) {
      return {
        found: true,
        checkpointId: candidate.id,
        label: candidate.label,
        createdAt: candidate.createdAt,
      };
    }
  }

  return { found: false, reason: 'none-validated' };
}

/**
 * Does this version work — nothing about whether it is *good*.
 *
 * The quality checks are deliberately absent. A nav link to a page nobody wrote is a real
 * finding, and it is not a reason to refuse to rescue someone from a site that does not
 * compile at all.
 */
async function validates(
  stack: StackId,
  files: Record<string, string>,
  designDirection: string | null,
): Promise<boolean> {
  const merged = withStarterFiles(stack, files, designDirection);
  try {
    // Loaded here rather than at module scope, and that is not a style choice.
    // `lib/projects/actions.ts` imports `checkpoints/actions`, which imports this file, so a
    // static import would put the TypeScript compiler and esbuild into the module graph of
    // essentially every project route — paid on every cold start, for a rescue that runs only
    // after a repair loop has already given up.
    const [{ checkGeneratedImports }, { checkBuild }, { typecheckGenerated }] = await Promise.all([
      import('@/lib/validation/import-check'),
      import('@/lib/validation/build-check'),
      import('@/lib/validation/typecheck'),
    ]);
    const imports = checkGeneratedImports({ stack, files: merged });
    if (imports.result.status === 'failed') return false;

    const built = await checkBuild({ stack, files: merged, designDirection });
    // `skipped` is not `passed`: a candidate nothing could check is not evidence of anything,
    // and restoring on it would be guessing with someone else's project.
    if (built.status !== 'passed') return false;

    return typecheckGenerated({ stack, files, designDirection }).status !== 'failed';
  } catch {
    // A crash in a checker is not a verdict about the candidate. Treat it as "cannot say",
    // which here means "do not restore to this".
    return false;
  }
}
