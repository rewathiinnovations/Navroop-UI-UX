import { handleCron } from '@/lib/cron/handle';
import { reconcileAbandonedJobs } from '@/lib/jobs/lifecycle';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleCron('reap-jobs', request, async () => {
    const result = await reconcileAbandonedJobs();
    return {
      ok: true,
      abandoned: result.abandoned.length,
      legacyProjects: result.legacyProjects.length,
      jobs: result.abandoned,
    };
  });
}
