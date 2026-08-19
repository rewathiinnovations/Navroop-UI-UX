import { handleCron } from '@/lib/cron/handle';
import { runObservabilityQuotaCheck } from '@/lib/observability/quota';
import { sendSystemChecksDigest } from '@/lib/observability/system-checks';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleCron('observability-quota', request, async () => {
    const quota = await runObservabilityQuotaCheck();
    const digest = await sendSystemChecksDigest();
    // A quota warning and a missing Sentry auth token are observations with their own channels
    // — the ObservabilityCheck row, and a direct admin email at 80% of quota — so neither
    // fails the run; a deploy that does not use Sentry would otherwise be red forever. A
    // `mismatch` is different: the heartbeat flushed locally and Sentry never received it, so
    // events are being dropped and nothing but this run says so. This used to be a hardcoded
    // `ok: true`, which hid all three.
    const ok = quota.status !== 'mismatch';
    return {
      ok,
      detail: ok
        ? `quota check ${quota.status}`
        : 'the heartbeat event flushed locally but Sentry has not seen it — events are being dropped',
      quota,
      digest,
    };
  });
}
