import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { jsonError } from '@/lib/api/error-response';
import { withRequest } from '@/lib/api/with-request';
import { getActiveJob, getLatestJob } from '@/lib/jobs/store';
import { toPublicJob } from '@/lib/jobs/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequest(request, async () => {
    const user = await getSessionUser();
    if (!user) return jsonError('Sign in required', 'UNAUTHORIZED', 401);
    const { id } = await params;
    const project = await prisma.project.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!project) return jsonError('Project not found', 'NOT_FOUND', 404);
    // A read, gated like the project list: any signed-in member. Owner-only here
    // meant a member watching a teammate's project polled 403 forever, so the
    // building indicator and the recovery panel never told them what was
    // happening — while the files and preview routes next door showed them the
    // whole site. The job's own mutations (keep/retry/start-over) stay gated.
    const active = await getActiveJob(id);
    const latest = active ?? (await getLatestJob(id));
    return NextResponse.json({
      job: latest ? toPublicJob(latest) : null,
      filesWritten: latest?.filesWritten ?? 0,
    });
  });
}
