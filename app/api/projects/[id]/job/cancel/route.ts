import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { jsonError } from '@/lib/api/error-response';
import { withRequest } from '@/lib/api/with-request';
import { cancelJob } from '@/lib/jobs/lifecycle';
import { resolveRecoveryTarget } from '@/lib/jobs/recovery';

/**
 * Stops the generation job the chat was showing. Unlike "Start over" this does not
 * re-plan or reset phase: it cancels the running/queued job and leaves the project
 * where the job left it, so the chat can pick the thread back up.
 *
 * Same target resolution as its three siblings (keep / retry / start-over), which is
 * the rule AGENTS.md states for all four: `resolveRecoveryTarget` acts on the job the
 * client rendered and refuses with STALE_JOB when something else has become active
 * since. This route read `getActiveJob` and never opened the body, so a Stop pressed
 * against job A landed on whatever was active by the time the POST arrived — the
 * automatic build-fix retry, or a queued follow-up — cancelling a build the person had
 * not asked to stop and reporting it as success. It also inherits the `showsChatRecovery`
 * gate from that helper, so a PUBLISH (whose cancelJob branch tears down Coolify
 * apps/DNS/repos), an AUDIT, an EXPORT, a DOMAIN_VERIFY or a TEMPLATE_THUMBNAIL row is
 * still unreachable from chat.
 */
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

    const target = await resolveRecoveryTarget(id, body.jobId);
    if (!target.ok) return jsonError(target.error, target.code, target.status);
    // Stop only has meaning for a job that has not stopped. The resolver hands back a
    // settled row happily — "keep what was built" is exactly that case — so the
    // in-flight test stays here, on the resolved target rather than on the newest row.
    if (target.job.status !== 'QUEUED' && target.job.status !== 'RUNNING') {
      return jsonError('That build already finished', 'ALREADY_SETTLED', 409);
    }

    const settled = await cancelJob(target.job.id, 'Stopped');
    return NextResponse.json({ ok: true, job: settled ?? target.job });
  });
}
