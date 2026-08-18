import { handleCron } from '@/lib/cron/handle';
import { probeProviderConfigs } from '@/lib/sandbox/probe';
import { rollAllProviderPeriods } from '@/lib/sandbox/accounting';
import { summarizeProviderProbe } from './summary';

export async function POST(request: Request) {
  return handleCron('check-sandbox-providers', request, async () => {
    await rollAllProviderPeriods();
    const result = await probeProviderConfigs();
    return summarizeProviderProbe(result);
  });
}
