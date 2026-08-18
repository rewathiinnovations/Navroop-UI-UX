import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { jsonError } from '@/lib/api/error-response';
import { adminAbandonJob } from '@/lib/jobs/admin';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user, error, status } = await requireAdmin();
  if (!user) return jsonError(error, status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', status);
  const { id } = await params;
  const result = await adminAbandonJob(id);
  if (!result.ok) return jsonError(result.error, 'ABANDON_FAILED', result.status);
  const { writeAudit } = await import('@/lib/audit/log');
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'job.force_abandon',
    targetType: 'job',
    targetId: id,
  });
  return NextResponse.json(result);
}
