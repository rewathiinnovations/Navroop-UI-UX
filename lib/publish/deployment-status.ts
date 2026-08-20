import type { JobStatus } from '@/lib/jobs/types';

/**
 * The `Deployment.status` a publish job's own status implies.
 *
 * Two writers need this answer and they must not disagree: `runPublishJob` (which settles
 * the row as it walks the steps and again in its catch) and `compensateAbandonedPublish`
 * (the only writer that runs when the job is abandoned rather than failed — an instance
 * restart, a SIGTERM drain, a stale heartbeat). It lives here, importing nothing from
 * either, because `lib/jobs/lifecycle.ts` imports the compensator and `lib/publish/execute.ts`
 * imports the lifecycle: a shared home in either file would close that cycle.
 *
 * `hadSuccessfulDeployment` is what makes a re-publish different from a first publish. A
 * re-publish that never finished leaves a site that is still up and still serving the
 * previous release, so the row belongs back at LIVE, not FAILED.
 */
export function deriveDeploymentStatus(jobStatus: JobStatus, hadSuccessfulDeployment: boolean) {
  if (jobStatus === 'SUCCEEDED') return 'LIVE' as const;
  if (jobStatus === 'QUEUED') return 'QUEUED' as const;
  if (jobStatus === 'RUNNING') return 'BUILDING' as const;
  if (hadSuccessfulDeployment) return 'LIVE' as const;
  return 'FAILED' as const;
}
