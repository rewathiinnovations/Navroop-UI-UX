import { prisma } from '@/lib/db';
import { compensateJobResources, type CompensateAdapters } from './compensate';
import { getJob, updateJobFields } from './store';
import type { JobResourceIds, JobStep } from './types';

function parseKindFromPrompt(prompt: string | null): 'LIVE' | 'PREVIEW' | null {
  if (prompt === 'LIVE' || prompt === 'PREVIEW') return prompt;
  return null;
}

function reopenSteps(steps: JobStep[] | null, keys: string[]): JobStep[] | null {
  if (!steps || keys.length === 0) return steps;
  return steps.map((step) =>
    keys.includes(step.key) && step.status === 'succeeded'
      ? { ...step, status: 'pending', finishedAt: null, error: null }
      : step,
  );
}

export async function compensateAbandonedPublish(
  jobId: string,
  options?: { adapters?: CompensateAdapters },
) {
  const job = await getJob(jobId);
  if (!job || job.kind !== 'PUBLISH') return null;
  if (job.resourceIds?.compensation) return job.resourceIds.compensation;

  const kind = parseKindFromPrompt(job.inputPrompt);
  const deployment = kind
    ? await prisma.deployment.findUnique({
        where: { projectId_kind: { projectId: job.projectId, kind } },
      })
    : await prisma.deployment.findFirst({
        where: { projectId: job.projectId },
        orderBy: { updatedAt: 'desc' },
      });

  const preexisting: JobResourceIds = {
    githubRepo: deployment?.repoFullName ?? null,
    coolifyAppUuid: deployment?.coolifyAppUuid ?? null,
    dnsRecordId: deployment?.dnsRecordId ?? null,
  };
  const hadSuccessfulDeployment = Boolean(deployment?.publishedAt || deployment?.status === 'LIVE');

  const result = await compensateJobResources({
    resources: job.resourceIds ?? {},
    hadSuccessfulDeployment,
    preexisting: hadSuccessfulDeployment ? preexisting : {},
    adapters: options?.adapters,
  });

  const compensation = result.rolledBack ? 'rolled_back' : 'kept_live';
  const toreDownCoolify = result.compensated.includes('coolify');
  const toreDownDns = result.compensated.includes('dns');

  const resourceIds: JobResourceIds = {
    ...(job.resourceIds ?? {}),
    compensation,
    ...(toreDownCoolify ? { coolifyAppUuid: null } : {}),
    ...(toreDownDns ? { dnsRecordId: null } : {}),
  };
  const steps = reopenSteps(job.steps, [
    ...(toreDownCoolify ? ['app'] : []),
    ...(toreDownDns ? ['dns'] : []),
  ]);

  await updateJobFields(jobId, {
    resourceIds,
    lastStep: compensation,
    ...(steps ? { steps } : {}),
  });

  if (result.rolledBack && deployment && deployment.status !== 'LIVE') {
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: 'FAILED',
        lastError: job.errorMessage || 'Publish did not finish',
        ...(toreDownCoolify ? { coolifyAppUuid: null } : {}),
        ...(toreDownDns ? { dnsRecordId: null } : {}),
      },
    });
  }

  return compensation;
}
