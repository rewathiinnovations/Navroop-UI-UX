import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { jsonError } from '@/lib/api/error-response';
import { withRequest } from '@/lib/api/with-request';
import { getLatestChatJob } from '@/lib/jobs/recovery';
import { getActiveJob } from '@/lib/jobs/store';
import { toPublicJob } from '@/lib/jobs/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequest(request, async () => {
    const user = await getSessionUser();
    if (!user) return jsonError('Sign in required', 'UNAUTHORIZED', 401);
    const { id } = await params;
    // A read, gated like the project list: any signed-in member. Owner-only here
    // meant a member watching a teammate's project polled 403 forever, so the
    // building indicator and the recovery panel never told them what was
    // happening — while the files and preview routes next door showed them the
    // whole site. The job's own mutations (keep/retry/start-over) stay gated.
    //
    // No existence check: this is the highest-frequency endpoint in the product
    // (every 2s per open workspace for the first two minutes of a build, then
    // every 10s, multiplied by viewers) and a `project.findFirst` in front of it
    // was a third to a half of the request's database work for nothing (F-643).
    // `getActiveJob`/`getLatestChatJob` are already scoped by `projectId` and answer
    // `null` for an id that does not exist, and the poller cannot tell a 404 from
    // `{ job: null }`: `useGenerationJob.refresh` maps `!response.ok` and a null
    // job to the same `null`. A soft-deleted project therefore reports its last
    // job instead of 404, which is what the workspace would show anyway.
    //
    // The fallback is the newest *chat* job, not the newest row. Every caller of this
    // endpoint is a chat surface — the workspace poll (`useGenerationJob`), the plan
    // poll's phase reading (`useProjectPlan`), and the SSE reattach loop
    // (`pollForResume` in `lib/generation/generation-runtime.ts`) — and none of them is
    // about a quality scan. `getLatestJob` was kind-blind, and `recordScanRun` files a
    // settled AUDIT row after every successful build, so the poll started answering with
    // the scan the moment a build finished: a failed scan read as a failed build, and the
    // chat's building indicator stayed dark for every message after it. /admin/jobs and
    // the Quality panel read those rows through their own queries and are untouched.
    // It is one statement with the kind set bound into it, not one lookup per chat kind:
    // a project left in BUILDING with a settled job takes this branch on every 2s tick, so
    // a fan-out here is the same cost F-643 removed, paid four times over.
    const active = await getActiveJob(id);
    const latest = active ?? (await getLatestChatJob(id));
    /**
     * `?files=1` adds the running job's persisted `partialFiles` so a tab whose SSE
     * stream dropped can replay what the build has written since (F-092). Opt-in on
     * purpose: `toPublicJob` leaves the file bytes out, and this is the highest-frequency
     * endpoint in the product — the 2s poller must not start shipping the whole project
     * on every tick. Only the reattach loop in `lib/generation/stream-resume.ts` asks.
     */
    const withFiles = request.nextUrl.searchParams.get('files') === '1';
    return NextResponse.json({
      job: latest ? toPublicJob(latest) : null,
      filesWritten: latest?.filesWritten ?? 0,
      ...(withFiles ? { partialFiles: latest?.partialFiles ?? [] } : {}),
    });
  });
}
