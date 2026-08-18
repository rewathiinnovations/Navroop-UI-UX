import { handleCron } from '@/lib/cron/handle';
import { purgeDeletedProjects } from '@/lib/projects/purge-deleted';

export async function POST(request: Request) {
  return handleCron('purge-projects', request, () => purgeDeletedProjects());
}
