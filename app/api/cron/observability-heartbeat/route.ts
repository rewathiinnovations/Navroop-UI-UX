import { handleCron } from '@/lib/cron/handle';
import { sendObservabilityHeartbeat } from '@/lib/observability/heartbeat';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleCron('observability-heartbeat', request, () => sendObservabilityHeartbeat());
}
