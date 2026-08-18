import { handleCron } from '@/lib/cron/handle';
import { runTmpSweep } from '@/lib/runtime/data-dir';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleCron('sweep-tmp', request, () => runTmpSweep());
}
