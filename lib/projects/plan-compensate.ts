import { prisma } from '@/lib/db';

export type RevertApprovedPlanResult = {
  planReverted: boolean;
  phaseReverted: boolean;
};

/**
 * Compensating write for `approvePlan`.
 *
 * `approvePlan` marks the plan APPROVED and the project BUILDING in one transaction,
 * then creates the BUILD/FOLLOWUP job. If job creation fails the project is left
 * BUILDING with no job, so the chat reads as "building" with nothing to unlock it.
 * Put both rows back where they were so the user's next action is simply approving
 * again.
 *
 * Both updates are conditional on the state this function is undoing, so a
 * concurrent writer that legitimately moved the project on is never clobbered.
 * Lives outside `plan.ts` so tests can exercise it without loading the AI SDK.
 */
export async function revertApprovedPlan(input: {
  projectId: string;
  planId: string;
}): Promise<RevertApprovedPlanResult> {
  return prisma.$transaction(async (tx) => {
    const planReverted = await tx.$executeRaw`
      UPDATE "ProjectPlan"
      SET status = 'PENDING'::"ProjectPlanStatus"
      WHERE id = ${input.planId}
        AND status = 'APPROVED'::"ProjectPlanStatus"
    `;
    const phaseReverted = await tx.$executeRaw`
      UPDATE "Project"
      SET phase = 'PLANNING'::"ProjectPhase", "updatedAt" = NOW()
      WHERE id = ${input.projectId}
        AND phase = 'BUILDING'::"ProjectPhase"
    `;
    return {
      planReverted: planReverted > 0,
      phaseReverted: phaseReverted > 0,
    };
  });
}
