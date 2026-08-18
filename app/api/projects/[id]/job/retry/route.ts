import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { jsonError } from '@/lib/api/error-response';
import { withRequest } from '@/lib/api/with-request';
import { retryAbandonedJob } from '@/lib/jobs/recovery';
import { getLatestJob } from '@/lib/jobs/store';
import { toPublicJob } from '@/lib/jobs/types';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withRequest(request, async () => {
    const user = await getSessionUser();
    if (!user) return jsonError('Sign in required', 'UNAUTHORIZED', 401);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { idempotencyKey?: string };
    const project = await prisma.project.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, ownerId: true },
    });
    if (!project) return jsonError('Project not found', 'NOT_FOUND', 404);
    if (user.id !== project.ownerId && user.role !== 'ADMIN') {
      return jsonError('Forbidden', 'FORBIDDEN', 403);
    }
    const latest = await getLatestJob(id);
    if (!latest) return jsonError('No generation job found', 'NOT_FOUND', 404);
    const result = await retryAbandonedJob(latest.id, body.idempotencyKey);
    if (!result.ok) return jsonError(result.error, 'RETRY_FAILED', result.status);
    return NextResponse.json({
      job: toPublicJob(result.job),
      prompt: result.prompt,
      resume: result.resume,
    });
  });
}
