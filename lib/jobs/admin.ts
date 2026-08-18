import { abandonJob } from './lifecycle';
import { getJob, listAbandonmentCounts, listActiveJobs, listRecentTerminalJobs } from './store';
import { toPublicJob } from './types';

export async function getJobsAdmin() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [active, terminal, counts] = await Promise.all([
    listActiveJobs(),
    listRecentTerminalJobs(since),
    listAbandonmentCounts(since),
  ]);

  const grouped: Record<string, typeof terminal> = {};
  for (const job of terminal) {
    const key = job.errorCode || 'unknown';
    grouped[key] = grouped[key] || [];
    grouped[key].push(job);
  }

  return {
    active: active.map((job) => ({
      ...toPublicJob(job),
      ageMs: Date.now() - (job.startedAt ?? job.createdAt).getTime(),
    })),
    failedByErrorCode: Object.fromEntries(
      Object.entries(grouped).map(([code, jobs]) => [code, jobs.map(toPublicJob)]),
    ),
    abandonmentsPerDay: counts.map((row) => ({
      day: row.day instanceof Date ? row.day.toISOString() : String(row.day),
      count: Number(row.count),
    })),
  };
}

export async function adminAbandonJob(jobId: string) {
  const job = await getJob(jobId);
  if (!job) return { ok: false as const, error: 'Job not found', status: 404 };
  if (job.status !== 'QUEUED' && job.status !== 'RUNNING') {
    return { ok: false as const, error: 'Job is not active', status: 409 };
  }
  const abandoned = await abandonJob(jobId, {
    errorCode: 'admin_abandoned',
    errorMessage: 'Abandoned by an admin',
  });
  return { ok: true as const, job: abandoned ? toPublicJob(abandoned) : null };
}
