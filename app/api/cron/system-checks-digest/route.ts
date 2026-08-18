import { handleCron } from '@/lib/cron/handle';
import { sendSystemChecksDigest } from '@/lib/observability/system-checks';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleCron('system-checks-digest', request, () => sendSystemChecksDigest());
}
