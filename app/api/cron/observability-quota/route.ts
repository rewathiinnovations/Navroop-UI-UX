import { handleCron } from '@/lib/cron/handle';
import { runObservabilityQuotaCheck } from '@/lib/observability/quota';
import { sendSystemChecksDigest } from '@/lib/observability/system-checks';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleCron('observability-quota', request, async () => {
    const quota = await runObservabilityQuotaCheck();
    const digest = await sendSystemChecksDigest();
    return { ok: true, quota, digest };
  });
}
