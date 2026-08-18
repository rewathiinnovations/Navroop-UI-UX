import { handleCron } from '@/lib/cron/handle';
import { checkDueCustomDomains } from '@/lib/domains/cron';

export async function POST(request: Request) {
  return handleCron('check-domains', request, () => checkDueCustomDomains());
}
