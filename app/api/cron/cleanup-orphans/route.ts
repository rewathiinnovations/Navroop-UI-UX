import { handleCron } from '@/lib/cron/handle';
import { runOrphanCleanup } from '@/lib/jobs/orphans';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleCron('cleanup-orphans', request, async () => {
    const report = await runOrphanCleanup();
    return {
      ok: true,
      ...report.counts,
      coolify: report.coolify,
      dns: report.dns,
      repos: report.repos,
      checkedAt: report.checkedAt,
    };
  });
}
