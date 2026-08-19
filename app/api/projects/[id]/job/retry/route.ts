import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { jsonError } from '@/lib/api/error-response';
import { withRequest } from '@/lib/api/with-request';
import { resolveRecoveryTarget, retryAbandonedJob } from '@/lib/jobs/recovery';
import { toPublicJob } from '@/lib/jobs/types';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequest(request, async () => {
    const user = await getSessionUser();
    if (!user) return jsonError('Sign in required', 'UNAUTHORIZED', 401);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as {
      jobId?: unknown;
      idempotencyKey?: string;
    };
    const project = await prisma.project.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, ownerId: true },
    });
    if (!project) return jsonError('Project not found', 'NOT_FOUND', 404);
    if (user.id !== project.ownerId && user.role !== 'ADMIN') {
      return jsonError('Forbidden', 'FORBIDDEN', 403);
    }
    // The job the panel rendered, not whatever is newest now — see resolveRecoveryTarget.
    const target = await resolveRecoveryTarget(id, body.jobId);
    if (!target.ok) return jsonError(target.error, target.code, target.status);
    const result = await retryAbandonedJob(target.job.id, body.idempotencyKey);
    if (!result.ok) return jsonError(result.error, 'RETRY_FAILED', result.status);
    return NextResponse.json({
      job: toPublicJob(result.job),
      prompt: result.prompt,
      resume: result.resume,
    });
  });
}
