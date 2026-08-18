import { handleCron } from '@/lib/cron/handle';
import { runStorageVerify } from '@/lib/backup/verify';

export const maxDuration = 300;

export async function POST(request: Request) {
  return handleCron('verify-storage', request, () => runStorageVerify());
}
