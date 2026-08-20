import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getCoolifyClient } from '@/lib/coolify/client';
import { currentRelease, parseReleaseHistory } from '@/lib/deploy/release';
import { executeCoolifyRollback, planRollback } from '@/lib/deploy/rollback';
import { prisma } from '@/lib/db';
import { writeAudit } from '@/lib/audit/log';
import { getSelfIdentity, SELF_UUID_NOT_CONFIGURED } from '@/lib/runtime/self';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });

  const body = (await request.json().catch(() => ({}))) as {
    confirmation?: string;
    targetSha?: string;
  };

  const historyRow = await prisma.appSetting.findUnique({
    where: { key: 'deploy.history' },
    select: { value: true },
  });
  const current = currentRelease();
  const plan = planRollback({
    currentSha: current.sha,
    targetSha: body.targetSha,
    confirmation: body.confirmation || '',
    history: parseReleaseHistory(historyRow?.value),
  });
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 });

  const appUuid = getSelfIdentity().coolifyAppUuid;
  if (!appUuid) {
    return NextResponse.json({ error: SELF_UUID_NOT_CONFIGURED }, { status: 400 });
  }

  const client = await getCoolifyClient();
  if (!client) {
    return NextResponse.json({ error: 'Coolify is not connected' }, { status: 400 });
  }

  const result = await executeCoolifyRollback({
    request: client.request,
    applicationUuid: appUuid,
    targetSha: plan.target.sha,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'deploy.rollback',
    targetType: 'release',
    targetId: plan.target.sha,
    after: { from: current.sha, to: plan.target.sha, deploymentUuid: result.deploymentUuid },
  });

  // "Deploying", not "rolled back": the pin is confirmed but the build is not. The pin is
  // also sticky — Coolify keeps deploying this commit until the operator moves it on.
  return NextResponse.json({
    ok: true,
    sha: result.sha,
    deploymentUuid: result.deploymentUuid,
    note: `Coolify is now deploying ${result.sha}; watch the deployment to confirm it finishes. The application stays pinned to this commit until you deploy a newer one. Database was not reverted — restore from backup if the schema changed.`,
  });
}
