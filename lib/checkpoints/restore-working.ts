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
 * WHY IT VERIFIES RATHER THAN REMEMBERS. `Checkpoint.snapshotValidated` records what the
 * validators said when the snapshot was written, and a snapshot is immutable — so unlike a
 * claim about a mutable row, that verdict is not stale about *its own bytes*. What does move
 * is the checkers: rules are added, the starter kit changes, the type-check gained a whole
 * stage this month. A stored `true` therefore means "passed the rules of the day it was
 * written", which is not the question being asked here.
 *
 * So the flag prunes and the re-run decides. A candidate recorded `false` is skipped without
 * paying for a compile — nothing has happened since that could make those exact bytes start
 * building — and every other candidate is checked again now. When the re-run proves a
 * candidate good, that answer is written back, so the evidence improves rather than being
 * thrown away.
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
      // Known-broken snapshots are not candidates. Their bytes are frozen, so nothing that
      // has happened since could make them start building, and re-compiling them would be
      // several seconds spent to reach the answer already on the row. `null` — never checked
      // — is not excluded: that is an absence of evidence, and the re-run below supplies it.
      snapshotValidated: { not: false },
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
      // Write the proof down. The checks just ran against these exact bytes, so recording the
      // answer costs one UPDATE and saves the next reader the compile — and it is what makes
      // this snapshot findable as the version to hold a broken build back to. Never fatal:
      // the rescue's job is to restore, and failing that because a bookkeeping write failed
      // would trade a working site for a database hiccup.
      await prisma.checkpoint
        .update({ where: { id: candidate.id }, data: { snapshotValidated: true } })
        .catch(() => {});
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
