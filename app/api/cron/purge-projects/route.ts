import { handleCron } from '@/lib/cron/handle';
import { purgeDeletedProjects } from '@/lib/projects/purge-deleted';

export async function POST(request: Request) {
  return handleCron('purge-projects', request, async () => {
    const report = await purgeDeletedProjects();
    // A blocked project is one whose Coolify app, DNS record or storage the provider would not
    // tear down. `purgeDeletedProjects` correctly keeps its receipts and retries next run, but
    // until it clears, a container the operator is being billed for is still up — and nothing
    // else in the product reports that count. Without this the cron answered 200 and recorded
    // `CronRun{ok: true}` on a run where every project was blocked.
    // A run capped at PURGE_PROJECT_LIMIT is healthy, not failed — but the backlog has to be
    // said out loud, or "purged 25, ok" reads identically whether the queue is empty or ten
    // thousand deep.
    const backlog =
      report.remaining > 0 ? `${report.remaining} project(s) remain for the next run` : null;
    const stuck =
      report.blocked > 0
        ? `${report.blocked} project(s) still have live publish resources and were not deleted`
        : null;
    return {
      ...report,
      ok: report.blocked === 0,
      detail: [stuck, backlog].filter(Boolean).join('; ') || null,
    };
  });
}
