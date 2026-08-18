import { handleCron } from '@/lib/cron/handle';
import { thinCheckpoints } from '@/lib/checkpoints/thin';

export async function POST(request: Request) {
  return handleCron('thin-checkpoints', request, () => thinCheckpoints());
}
