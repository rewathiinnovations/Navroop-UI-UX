import { handleCron } from '@/lib/cron/handle';
import { checkAllIntegrations } from '@/lib/integrations/health';

export async function POST(request: Request) {
  return handleCron('check-integrations', request, () => checkAllIntegrations());
}
