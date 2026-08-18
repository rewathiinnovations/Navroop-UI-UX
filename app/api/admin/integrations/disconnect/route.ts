import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { INTEGRATION_KINDS, type IntegrationKind } from '@/lib/integrations/types';
import { KIND_LABELS } from '@/lib/integrations/types';
import { countLiveDeployments, disconnectIntegration, getIntegration } from '@/lib/integrations/store';
import { disconnectWarning } from '@/lib/integrations/messages';
import { listPublicIntegrations } from '@/lib/integrations/public';

export async function POST(request: Request) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as { kind?: string; confirm?: string };
  const kind = body.kind as IntegrationKind;
  if (!INTEGRATION_KINDS.includes(kind)) {
    return NextResponse.json({ error: 'Invalid kind' }, { status: 422 });
  }
  const existing = await getIntegration('default', kind);
  if (!existing || existing.status === 'DISCONNECTED') {
    return NextResponse.json({ error: 'Already disconnected' }, { status: 409 });
  }
  const liveCount = await countLiveDeployments();
  const expected = KIND_LABELS[kind];
  const sentryWarning =
    kind === 'SENTRY'
      ? 'Error tracking will stop after the next restart. You will not be notified of application errors.'
      : null;
  if ((body.confirm || '').trim() !== expected) {
    return NextResponse.json(
      {
        error: `Type ${expected} to confirm`,
        warning: sentryWarning ?? disconnectWarning(liveCount),
        liveCount,
      },
      { status: 422 },
    );
  }
  let stillSendingUntilRestart = false;
  if (kind === 'SENTRY') {
    const { disconnectSentry } = await import('@/lib/integrations/sentry-persist');
    const sentryResult = await disconnectSentry();
    stillSendingUntilRestart = sentryResult.stillSendingUntilRestart;
  } else {
    await disconnectIntegration({ kind });
  }
  const { writeAudit } = await import('@/lib/audit/log');
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'integration.disconnect',
    targetType: 'integration',
    targetId: kind,
    after: { kind, status: 'DISCONNECTED' },
  });
  return NextResponse.json({
    ...(await listPublicIntegrations()),
    liveCount,
    warning: sentryWarning ?? disconnectWarning(liveCount),
    stillSendingUntilRestart,
  });
}
