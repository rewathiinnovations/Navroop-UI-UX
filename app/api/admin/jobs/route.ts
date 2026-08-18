import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { jsonError } from '@/lib/api/error-response';
import { getJobsAdmin } from '@/lib/jobs/admin';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { user, error, status } = await requireAdmin();
  if (!user) return jsonError(error, status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', status);
  const data = await getJobsAdmin();
  return NextResponse.json(data);
}
