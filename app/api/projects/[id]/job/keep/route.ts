import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { jsonError } from '@/lib/api/error-response';
import { withRequest } from '@/lib/api/with-request';
import { keepPartialBuild, resolveRecoveryTarget } from '@/lib/jobs/recovery';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequest(request, async () => {
    const user = await getSessionUser();
    if (!user) return jsonError('Sign in required', 'UNAUTHORIZED', 401);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { jobId?: unknown };
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
    const result = await keepPartialBuild(target.job.id);
    if (!result.ok) return jsonError(result.error, 'KEEP_FAILED', result.status);
    return NextResponse.json(result);
  });
}
