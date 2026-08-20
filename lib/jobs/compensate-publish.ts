import { prisma } from '@/lib/db';
import { compensateJobResources, type CompensateAdapters } from './compensate';
import { getJob, updateJobFields } from './store';
import type { JobResourceIds, JobStep } from './types';
import { deriveDeploymentStatus } from '@/lib/publish/deployment-status';

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
  // A settled rollback runs once. `partial` is not settled: at least one resource this job
  // created is still up, so the next abandon sweep gets to try again rather than reading
  // the marker as "done" and leaving a container running for the 24 hours the orphan cron
  // needs to reach it (F-046).
  if (job.resourceIds?.compensation && job.resourceIds.compensation !== 'partial') {
    return job.resourceIds.compensation;
  }

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

  const compensation = result.outcome;
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

  // Settle the row on every abandon, not only when something was rolled back.
  //
  // A re-publish deliberately rolls nothing back — its Coolify app and DNS record were
  // already serving — so gating this write on `result.rolledBack` skipped exactly the
  // case that needed it: the first `persistProgress` had written BUILDING, the runner's
  // catch never ran, and no other writer exists. The site stayed up and the product said
  // "Building" forever, in the publish sheet, on /deployments, on the project badge, and
  // in the live-slot count (`lib/publish/limits.ts` counts any non-STOPPED row).
  //
  // `deriveDeploymentStatus('ABANDONED', …)` computes the state the row had before the
  // job started: LIVE for a re-publish, FAILED for a first publish.
  if (deployment) {
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: deriveDeploymentStatus('ABANDONED', hadSuccessfulDeployment),
        lastError: job.errorMessage || 'Publish did not finish',
        ...(toreDownCoolify ? { coolifyAppUuid: null } : {}),
        ...(toreDownDns ? { dnsRecordId: null } : {}),
      },
    });
  }

  return compensation;
}
