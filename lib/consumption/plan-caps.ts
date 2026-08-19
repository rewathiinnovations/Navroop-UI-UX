import { getEffectivePlan } from '@/lib/plans/limits';
import type { JobCaps } from './caps';

export type PlanConsumptionCaps = JobCaps;

/**
 * The three per-job caps, read straight off the effective plan row.
 *
 * They used to be fetched with a `$queryRaw` SELECT and then `?? DEFAULT_JOB_CAPS`, from
 * the days when the generated client predated the columns. Both halves were obsolete once
 * `20260817260000_consumption_caps` landed: it adds all three as `INTEGER NOT NULL DEFAULT`,
 * schema.prisma declares them the same way, so `prisma.plan` already returns them as plain
 * numbers. What the `??` still did was stand ready to replace an admin's configured
 * 20 000-token cap with a hardcoded 120 000 the moment a read came back thin — silently, on
 * the one number that bounds how much a single build is allowed to spend. That is the same
 * masking pattern that made `toPublicPlan` echo phantom defaults back to the admin panel.
 *
 * There is deliberately no fallback here. "No plan configured at all" is a real state, but
 * it belongs to `getEffectivePlan`, which throws `No default plan is configured` — an
 * explicit, visible failure. Defaulting instead would be the permissive direction: it would
 * hand out 120 000 tokens of provider spend that no plan ever authorised.
 */
export async function getPlanCaps(workspaceId: string): Promise<PlanConsumptionCaps> {
  const plan = await getEffectivePlan(workspaceId);
  return {
    maxTokensPerJob: plan.maxTokensPerJob,
    maxFilesPerJob: plan.maxFilesPerJob,
    maxOutputBytesPerJob: plan.maxOutputBytesPerJob,
  };
}
