import { log } from '@/lib/logger';
import { getJob, updateJobFields } from './store';
import { parseJobSteps, type JobStep } from './types';

/**
 * Records a failed sub-step on a running job so it shows up in the workspace
 * recovery panel and /admin/jobs.
 *
 * Generation and apply are single-step jobs at the top level, but they do
 * several things that can fail on their own — reading the sandbox, planning an
 * edit, installing packages. Those used to disappear into a swallowed `else`
 * branch. They are recorded here instead, without failing the job: the
 * generation still produced files, it just produced them with less help.
 *
 * Never throws. A bookkeeping write must not take down the operation it is
 * describing.
 */
export async function recordJobStepFailure(
  jobId: string | null | undefined,
  step: { key: string; label: string; error: string },
): Promise<void> {
  if (!jobId) return;
  try {
    const job = await getJob(jobId);
    if (!job) return;

    const steps = parseJobSteps(job.steps);
    const now = new Date().toISOString();
    const entry: JobStep = {
      key: step.key,
      label: step.label,
      status: 'failed',
      startedAt: now,
      finishedAt: now,
      error: step.error,
    };

    const index = steps.findIndex((existing) => existing.key === step.key);
    if (index >= 0) steps[index] = { ...steps[index], ...entry, startedAt: steps[index].startedAt ?? now };
    else steps.push(entry);

    await updateJobFields(jobId, { steps });
  } catch (error) {
    log.warn('jobs.step_failure_record_failed', {
      jobId,
      key: step.key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
