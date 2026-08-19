import { handleCron } from '@/lib/cron/handle';
import { runOrphanCleanup } from '@/lib/jobs/orphans';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleCron('cleanup-orphans', request, async () => {
    const report = await runOrphanCleanup();
    // A provider whose listing threw contributes an empty inventory, so the run finds no
    // orphans, deletes nothing, and used to report `CronRun{ok: true}` — which an operator
    // reads as "no orphans exist" when the truth is "we could not look". Deletion is driven
    // only by what was enumerated, so a failed listing narrows this cron and never widens it:
    // the danger is the false all-clear, not a wrong delete.
    const blind = report.listFailures.length > 0;
    return {
      ok: !blind,
      // A not-connected provider is named on the healthy path instead, so /admin/health can
      // show "looked at what it could" without the run going red for an integration the
      // operator deliberately never connected.
      detail: blind
        ? `could not list ${report.listFailures.join(', ')} — nothing was deleted for those providers and no orphan of theirs can be seen`
        : report.notConnected.length > 0
          ? `not connected, so not checked: ${report.notConnected.join(', ')}`
          : null,
      listFailures: report.listFailures,
      notConnected: report.notConnected,
      // `counts` is nested, not spread. Spreading it put the numeric `coolify`/`dns`/`repos`/
      // `skipped` on the same object as the arrays below, so every count except `deleted` was
      // shadowed and never reached the operator.
      counts: report.counts,
      deleted: report.counts.deleted,
      coolify: report.coolify,
      dns: report.dns,
      repos: report.repos,
      // Enumerated but not created by us, so not touched. Named here because the
      // previous behaviour was to delete these on a name match. The names are capped per
      // kind (`SKIPPED_REPORT_LIMIT`); `counts.skipped` above is the true total.
      skipped: report.skipped,
      checkedAt: report.checkedAt,
    };
  });
}
