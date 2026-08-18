import { log, logError } from '@/lib/logger';
import { reconcileAbandonedJobs } from './lifecycle';

let ran = false;

export async function reconcileJobsAtBoot() {
  if (ran) return { skipped: true as const };
  ran = true;
  try {
    const result = await reconcileAbandonedJobs();
    log.warn('jobs.boot_reconcile', {
      abandoned: result.abandoned.length,
      legacyProjects: result.legacyProjects.length,
    });
    return result;
  } catch (error) {
    logError('jobs.boot_reconcile_failed', error);
    return { abandoned: [], legacyProjects: [], error: true as const };
  }
}
