import { prisma } from '@/lib/db';
import { failJob, succeedJob } from './lifecycle';
import { getJob } from './store';

export const STREAM_SANDBOX_PERSIST_MISS_MESSAGE =
  'The generated files were not saved because the workspace never became ready.';

export type StreamSettleInput = {
  jobId: string;
  producedFiles: number;
  /** The raw streamed text (`<file path=…>` blocks). The server holds the
   *  complete site the moment the stream ends — persistence must not depend
   *  on the browser tab surviving to send its own PATCH. */
  streamedCode?: string | null;
  noChangeReason?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  estimatedCostUsd?: number | null;
  provider?: string | null;
  model?: string | null;
};

export type StreamSettleResult = {
  outcome: 'succeeded' | 'failed';
  errorCode?: string;
  errorMessage?: string;
};

/**
 * Terminal settle for generate-ai-code-stream after the model finished.
 *
 * Streamed `<file>` blocks are not a finished site. Succeeding here used to
 * mark the job SUCCEEDED and the project COMPLETE while lastCode and
 * checkpoints were still empty — the sandbox had failed at ready, persist
 * never ran, and chat said Generation complete.
 */
export async function settleStreamedGeneration(input: StreamSettleInput): Promise<StreamSettleResult> {
  const job = await getJob(input.jobId);
  if (!job) {
    return { outcome: 'failed', errorCode: 'provider_error', errorMessage: 'Job not found' };
  }
  if (job.status !== 'QUEUED' && job.status !== 'RUNNING') {
    return {
      outcome: job.status === 'SUCCEEDED' ? 'succeeded' : 'failed',
      errorCode: job.errorCode ?? undefined,
      errorMessage: job.errorMessage ?? undefined,
    };
  }

  const usage = {
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    estimatedCostUsd: input.estimatedCostUsd,
    provider: input.provider,
    model: input.model,
  };

  if (input.noChangeReason) {
    await failJob(job.id, {
      errorCode: 'no_files_generated',
      errorMessage: input.noChangeReason,
      ...usage,
    });
    return {
      outcome: 'failed',
      errorCode: 'no_files_generated',
      errorMessage: input.noChangeReason,
    };
  }

  const project = await prisma.project.findUnique({
    where: { id: job.projectId },
    select: { lastCode: true, sandboxStatus: true, phase: true },
  });
  const checkpointCount = await prisma.checkpoint.count({ where: { projectId: job.projectId } });
  let hasSite = Boolean(project?.lastCode) || checkpointCount > 0;
  const sandboxDead = project?.sandboxStatus === 'FAILED' || project?.sandboxStatus === 'DEAD';

  // The stream is the source of the site — persist it here, server-side.
  // Before this, lastCode was only written by the browser's terminal PATCH,
  // so a closed tab (or a sandbox stuck mid-boot) lost a fully generated
  // site while the job read SUCCEEDED with lastCode empty.
  const streamedHasFiles = /<file path="/.test(input.streamedCode || '');
  if (!hasSite && streamedHasFiles) {
    await prisma.project.update({
      where: { id: job.projectId },
      data: {
        lastCode: input.streamedCode!,
        ...(project?.phase !== 'COMPLETE' ? { phase: 'COMPLETE' as const } : {}),
      },
    });
    hasSite = true;
  }

  if (!hasSite && sandboxDead) {
    await failJob(job.id, {
      errorCode: 'sandbox_unavailable',
      errorMessage: STREAM_SANDBOX_PERSIST_MISS_MESSAGE,
      ...usage,
    });
    return {
      outcome: 'failed',
      errorCode: 'sandbox_unavailable',
      errorMessage: STREAM_SANDBOX_PERSIST_MISS_MESSAGE,
    };
  }

  await succeedJob(job.id, usage);
  return { outcome: 'succeeded' };
}
