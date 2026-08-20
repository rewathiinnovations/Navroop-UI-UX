import { log } from '@/lib/logger';
import { jobErrorCodeFromError } from './error-code';
import { beginJobHeartbeat, failJob, markJobRunning, succeedJob } from './lifecycle';
import { ensureJobSettled } from './settle';
import { getActiveJob, insertJobRaw, updateJobFields } from './store';
import type { CreateJobInput } from './lifecycle';
import type { JobErrorCode, JobStep } from './types';

/**
 * Record a short or auxiliary job without stealing an in-flight generation/publish job.
 * If the project already has a QUEUED/RUNNING job, this is a no-op.
 */
export async function withRecordedJob<T>(
  input: CreateJobInput & {
    steps?: JobStep[];
    /**
     * How to file a failure. Supplied by callers that know what they were talking to —
     * a provider caller passes `jobErrorCodeForProviderFailure`. Left off, the code comes
     * from the thrown error itself and otherwise reads `internal_error` (F-047).
     */
    classifyError?: (error: unknown) => JobErrorCode;
  },
  work: (jobId: string) => Promise<T>,
): Promise<T> {
  const active = await getActiveJob(input.projectId);
  if (active) {
    return work(active.id);
  }

  let job;
  try {
    job = await insertJobRaw({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      kind: input.kind,
      inputPrompt: input.inputPrompt,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    // Losing the job row only means this run is not tracked — still do the work,
    // but say so, otherwise /admin/jobs quietly under-reports.
    log.warn('jobs.record_skipped', {
      projectId: input.projectId,
      kind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return work('skipped');
  }

  // `markJobRunning` stamps heartbeatAt once and nothing refreshed it, so any short
  // job that ran longer than HEARTBEAT_STALE_MS looked stale to reconcileAbandonedJobs
  // and was abandoned while it was still working. Keep the same 10s interval as every
  // other job kind, and stop it on every exit path.
  const heartbeat = beginJobHeartbeat(job.id);
  try {
    // Inside the try: a throw from either of these used to leave the row RUNNING
    // (or QUEUED) with nothing to settle it.
    await markJobRunning(job.id, { chargeCredits: false, acquireProjectLock: false });
    if (input.steps) {
      await updateJobFields(job.id, {
        steps: input.steps,
        currentStep: input.steps[0]?.key ?? null,
      });
    }
    const result = await work(job.id);
    await succeedJob(job.id);
    return result;
  } catch (error) {
    // Settling the row is bookkeeping — it must not replace the caller's error.
    await failJob(job.id, {
      errorCode: (input.classifyError ?? jobErrorCodeFromError)(error),
      errorMessage: error instanceof Error ? error.message : 'Job failed',
    }).catch((failError) => {
      log.warn('jobs.record_fail_failed', {
        projectId: input.projectId,
        kind: input.kind,
        error: failError instanceof Error ? failError.message : String(failError),
      });
    });
    throw error;
  } finally {
    heartbeat.stop();
    // Belt and braces: if the settle above could not be written, the row would sit RUNNING
    // and lock the chat input until the hard timeout. This is a no-op once it is settled.
    await ensureJobSettled(job.id, {
      errorCode: 'server_restarted',
      errorMessage: 'Job stopped before it reported a result',
    });
  }
}
