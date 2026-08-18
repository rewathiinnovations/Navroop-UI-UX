import { prisma } from '@/lib/db';
import { getEffectivePlan } from '@/lib/plans/limits';
import { DEFAULT_JOB_CAPS, type JobCaps } from './caps';

export type PlanConsumptionCaps = JobCaps;

export async function getPlanCaps(workspaceId: string): Promise<PlanConsumptionCaps> {
  const plan = await getEffectivePlan(workspaceId);
  const rows = await prisma.$queryRaw<
    Array<{
      maxTokensPerJob: number;
      maxFilesPerJob: number;
      maxOutputBytesPerJob: number;
    }>
  >`
    SELECT "maxTokensPerJob", "maxFilesPerJob", "maxOutputBytesPerJob"
    FROM "Plan"
    WHERE id = ${plan.id}
    LIMIT 1
  `;
  const row = rows[0];
  return {
    maxTokensPerJob: row?.maxTokensPerJob ?? DEFAULT_JOB_CAPS.maxTokensPerJob,
    maxFilesPerJob: row?.maxFilesPerJob ?? DEFAULT_JOB_CAPS.maxFilesPerJob,
    maxOutputBytesPerJob: row?.maxOutputBytesPerJob ?? DEFAULT_JOB_CAPS.maxOutputBytesPerJob,
  };
}
