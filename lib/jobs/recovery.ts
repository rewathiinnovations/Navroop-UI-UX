import { createCheckpoint } from '@/lib/checkpoints/actions';
import { prisma } from '@/lib/db';
import { getApprovedPlanGenerationContext } from '@/lib/projects/plan';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { showsChatRecovery } from './chat-ui';
import { cancelJob, createOrReuseJob, resolveResumablePhase } from './lifecycle';
import { buildResumePrompt, shouldResumePartial } from './resume';
import { getJob, getLatestJob, setProjectResumablePhase } from './store';
import { filesToLastCode, parsePartialFiles, type PartialFile } from './types';

export async function keepPartialBuild(jobId: string) {
  const job = await getJob(jobId);
  if (!job) return { ok: false as const, error: 'Job not found', status: 404 };
  const files = parsePartialFiles(job.partialFiles);
  if (files.length === 0) {
    return { ok: false as const, error: 'No files were written', status: 409 };
  }
  const lastCode = filesToLastCode(files);
  await prisma.project.update({
    where: { id: job.projectId },
    data: { lastCode, generationStatus: 'ready' },
  });
  await createCheckpoint(job.projectId, {
    trigger: job.kind === 'FOLLOWUP' ? 'followup' : 'initial',
    sourceMessage: job.inputPrompt,
  });
  await prisma.$executeRaw`
    UPDATE "GenerationJob"
    SET status = 'SUCCEEDED'::"JobStatus", "finishedAt" = NOW(), "lastStep" = 'kept_partial', "updatedAt" = NOW()
    WHERE id = ${job.id}
  `;
  await setProjectResumablePhase(job.projectId, 'COMPLETE', 'ready');
  return { ok: true as const, filesWritten: files.length };
}

export async function retryAbandonedJob(jobId: string, idempotencyKey?: string | null) {
  const job = await getJob(jobId);
  if (!job) return { ok: false as const, error: 'Job not found', status: 404 };
  const files = parsePartialFiles(job.partialFiles);
  const resume = shouldResumePartial({
    kind: job.kind,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    filesWritten: job.filesWritten,
    errorCode: job.errorCode,
  });
  const planContext = job.kind === 'BUILD' ? await getApprovedPlanGenerationContext(job.projectId) : '';
  const prompt = resume
    ? buildResumePrompt({
        originalPrompt: job.inputPrompt || '',
        planContext,
        writtenFiles: files,
      })
    : job.inputPrompt || planContext || '';

  const next = await createOrReuseJob({
    projectId: job.projectId,
    workspaceId: job.workspaceId || WORKSPACE_ROW_ID,
    userId: job.userId,
    kind: job.kind,
    inputPrompt: job.inputPrompt,
    planVersion: job.planVersion,
    idempotencyKey: idempotencyKey ?? null,
    attempt: resume ? job.attempt + 1 : 1,
    maxAttempts: job.maxAttempts,
    creditsChargedAt: job.creditsChargedAt,
  });

  return {
    ok: true as const,
    job: next,
    prompt,
    resume,
  };
}

export async function startOverJob(jobId: string) {
  const job = await getJob(jobId);
  if (!job) return { ok: false as const, error: 'Job not found', status: 404 };
  await cancelJob(jobId, 'Start over');
  const phase = await resolveResumablePhase(job.projectId, 0);
  await setProjectResumablePhase(job.projectId, phase, 'idle');
  if (phase === 'PLANNING') {
    // An APPROVED plan renders no Approve button, so resetting to PLANNING
    // while the plan stayed APPROVED stranded the project: "review the plan
    // and approve" with nothing to click. Reopen the plan so the PlanCard
    // offers Approve & Build again.
    const { prisma } = await import('@/lib/db');
    await prisma.projectPlan.updateMany({
      where: { projectId: job.projectId, status: 'APPROVED' },
      data: { status: 'PENDING' },
    });
  }
  return { ok: true as const, phase };
}

export async function latestRecoveryJob(projectId: string) {
  const latest = await getLatestJob(projectId);
  if (!latest) return null;
  if (latest.status !== 'ABANDONED' && latest.status !== 'FAILED') return null;
  if (!showsChatRecovery(latest.kind)) return null;
  return latest;
}

export function recoveryFiles(job: { partialFiles: PartialFile[] | null }): PartialFile[] {
  return parsePartialFiles(job.partialFiles);
}
