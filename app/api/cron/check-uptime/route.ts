import { handleCron } from '@/lib/cron/handle';
import { checkSiteUptime } from '@/lib/observability/uptime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleCron('check-uptime', request, () => checkSiteUptime());
}
