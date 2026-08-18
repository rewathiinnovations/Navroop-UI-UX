import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { jsonError } from '@/lib/api/error-response';
import { withRequest } from '@/lib/api/with-request';
import { startOverJob } from '@/lib/jobs/recovery';
import { getLatestJob } from '@/lib/jobs/store';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withRequest(request, async () => {
    const user = await getSessionUser();
    if (!user) return jsonError('Sign in required', 'UNAUTHORIZED', 401);
    const { id } = await params;
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
    const result = await startOverJob(latest.id);
    if (!result.ok) return jsonError(result.error, 'START_OVER_FAILED', result.status);
    return NextResponse.json(result);
  });
}
