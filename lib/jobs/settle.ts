import { log } from '@/lib/logger';
import { abandonActiveJob, type TerminalWriteOptions } from './lifecycle';
import { getJob } from './store';

/**
 * The last-resort settle, for a `finally` block.
 *
 * A generation route settles its job on the happy path and in its `catch`. Neither runs
 * when the work is torn down rather than finished or thrown: a client that disconnects
 * mid-stream leaves the handler parked on a write nobody is reading, and a job that never
 * settles stays RUNNING, which keeps `isChatBuilding` true and the workspace chat input
 * locked until the 20-minute hard timeout.
 *
 * Call this from a `finally` and the job always reaches a terminal status. It is a no-op
 * when the work already settled — `succeedJob` / `failJob` / `abandonJob` only transition
 * an active job — so the happy path is untouched. It never throws, because a cleanup
 * failure must not replace the error the caller is already unwinding with.
 */
export async function ensureJobSettled(
  jobId: string | null | undefined,
  input: { errorCode: string; errorMessage?: string | null },
  options?: TerminalWriteOptions,
): Promise<'already_settled' | 'settled' | 'missing' | 'error'> {
  if (!jobId) return 'missing';
  try {
    const job = await getJob(jobId);
    if (!job) return 'missing';
    if (job.status !== 'QUEUED' && job.status !== 'RUNNING') return 'already_settled';

    // ABANDONED, not FAILED: the work did not report a failure, it stopped being observed.
    // That is the same verdict the staleness reaper reaches, and it keeps the recovery
    // panel's resume affordances working.
    const { job: settled, wrote } = await abandonActiveJob(jobId, input, options);
    if (!wrote) return settled ? 'already_settled' : 'missing';
    log.warn('jobs.settled_by_cleanup', {
      jobId,
      projectId: job.projectId,
      kind: job.kind,
      errorCode: input.errorCode,
      filesWritten: job.filesWritten,
    });
    return 'settled';
  } catch (error) {
    log.error('jobs.settle_failed', {
      jobId,
      errorCode: input.errorCode,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'error';
  }
}
