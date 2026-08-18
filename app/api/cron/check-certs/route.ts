import { handleCron } from '@/lib/cron/handle';
import { checkSiteCertificate } from '@/lib/observability/certs';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleCron('check-certs', request, () => checkSiteCertificate());
}
