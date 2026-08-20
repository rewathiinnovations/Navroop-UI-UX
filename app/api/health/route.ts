import { prisma } from '@/lib/db';
import { currentRelease } from '@/lib/deploy/release';
import { runHealthChecks } from '@/lib/health/check';
import { getIntegration } from '@/lib/integrations/store';
import { readRuntimeConfigState } from '@/lib/observability/runtime-config';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { sentryDsn, sentryEnvironment } from '@/lib/sentry/options';
import { headStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  // The three-state read, not the boolean one: an unreadable config file stops Sentry
  // initialising and must not be reported as "never connected" (F-738).
  const runtimeRead = readRuntimeConfigState();
  const runtime = runtimeRead.state === 'ok' ? runtimeRead.config : null;
  let matchesIntegration: boolean | null = null;
  try {
    const row = await getIntegration(DEFAULT_WORKSPACE_ID, 'SENTRY');
    if (row?.status === 'CONNECTED' && row.config.projectId) {
      matchesIntegration = runtime?.projectId === row.config.projectId;
    } else if (!row) {
      matchesIntegration = null;
    } else {
      matchesIntegration = Boolean(runtime);
    }
  } catch {
    matchesIntegration = null;
  }

  const result = await runHealthChecks({
    db: prisma,
    storageHead: headStorage,
    version: process.env.npm_package_version ?? '0.1.0',
    sentryDsnConfigured: Boolean(sentryDsn()),
    releaseSha: currentRelease().sha,
    sentryEnvironment: sentryEnvironment(),
    observabilityFile: {
      present: Boolean(runtime),
      state: runtimeRead.state,
      error: runtimeRead.state === 'unreadable' ? runtimeRead.message : null,
      projectId: runtime?.projectId ?? null,
      matchesIntegration,
    },
  });
  return Response.json(result, { status: result.ok ? 200 : 503 });
}
