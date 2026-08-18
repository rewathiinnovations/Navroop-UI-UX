import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { getIntegration } from '@/lib/integrations/store';
import { persistSentrySettings } from '@/lib/integrations/sentry-persist';
import { listPublicIntegrations } from '@/lib/integrations/public';
import { settingsChangeRequiresRestart } from '@/lib/integrations/sentry';

export async function POST(request: Request) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });
  const row = await getIntegration(DEFAULT_WORKSPACE_ID, 'SENTRY');
  if (!row || row.status === 'DISCONNECTED') {
    return NextResponse.json({ error: 'Sentry is not connected' }, { status: 409 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    environment?: string;
    tracesSampleRate?: number;
    sessionReplay?: boolean;
    performance?: boolean;
    ignoreList?: string[];
    fingerprintLimit?: number;
    fingerprintWindowSec?: number;
  };
  const tracesSampleRate =
    typeof body.tracesSampleRate === 'number' ? Math.min(1, Math.max(0, body.tracesSampleRate)) : row.config.tracesSampleRate;
  await persistSentrySettings({
    ...row.config,
    environment: body.environment ?? row.config.environment,
    tracesSampleRate,
    sessionReplay: body.sessionReplay ?? row.config.sessionReplay,
    performance: body.performance ?? row.config.performance,
    ignoreList: body.ignoreList ?? row.config.ignoreList,
    fingerprintLimit: body.fingerprintLimit ?? row.config.fingerprintLimit,
    fingerprintWindowSec: body.fingerprintWindowSec ?? row.config.fingerprintWindowSec,
    connectedById: user.id,
  });
  return NextResponse.json({
    restartRequired: settingsChangeRequiresRestart(body),
    ...(await listPublicIntegrations()),
  });
}
