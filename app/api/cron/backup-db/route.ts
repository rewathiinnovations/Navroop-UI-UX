import { handleCron } from '@/lib/cron/handle';
import { runDbBackup } from '@/lib/backup/db';

export const maxDuration = 300;

export async function POST(request: Request) {
  return handleCron('backup-db', request, () => runDbBackup());
}
